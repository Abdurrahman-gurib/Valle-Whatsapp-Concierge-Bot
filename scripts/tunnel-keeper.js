#!/usr/bin/env node
/**
 * TUNNEL KEEPER — keeps a public HTTPS tunnel alive and points the 360dialog
 * webhook at it. Temporary bridge until the bot moves to a cloud host.
 *
 *   npm run tunnel
 *
 * This office network is hostile to tunnels: its DNS resolves
 * trycloudflare.com to the router, SSH on port 22 is blocked at times, and
 * localtunnel occasionally stalls. So the keeper cycles through providers
 * until one connects, and keeps cycling whenever the current one dies:
 *
 *   1. serveo       (SSH over port 22; held for hours when 22 is open)
 *   2. pinggy       (SSH over port 443, which this network always allows;
 *                    free tunnels expire hourly and are simply reopened)
 *   3. localtunnel  (HTTPS; died silently every few minutes on 27 August)
 *
 * On every new public URL it re-registers the 360dialog webhook, including
 * the X-Valle-Token header the server checks. A watchdog probes the public
 * URL through DNS-over-HTTPS every minute and rotates when it stops answering.
 *
 * Run with NODE_USE_SYSTEM_CA=1 (the supervisor does): this office network
 * intercepts some TLS with its own certificate.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const START_TIMEOUT_MS = 45_000;

const SSH_OPTS = [
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ConnectTimeout=15',
];

// Order matters: the first provider is tried first and after every rotation
// the next one is used. Serveo held the webhook for hours at a time on
// 27 August; localtunnel died silently three times in one hour while its
// process kept running (503 "Tunnel Unavailable"). So serveo leads.
/**
 * Cloudflare quick tunnel: keeps four connections to Cloudflare's edge open
 * and reconnects them itself, which survives this network's habit of
 * dropping long-lived connections every few minutes. Needs bin/cloudflared.exe
 * (https://github.com/cloudflare/cloudflared/releases, windows-amd64).
 */
const CLOUDFLARED = path.join(ROOT, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

const PROVIDERS = [
  ...(fs.existsSync(CLOUDFLARED) ? [{
    name: 'cloudflare',
    cmd: CLOUDFLARED,
    args: ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate', '--protocol', 'http2'],
    // the log also mentions api.trycloudflare.com: that is not the tunnel
    url: /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i,
    startTimeoutMs: 30_000,
  }] : []),
  {
    name: 'serveo',
    cmd: 'ssh',
    args: [...SSH_OPTS, '-R', `80:localhost:${PORT}`, 'serveo.net'],
    url: /https:\/\/[a-z0-9.-]+\.serveousercontent\.com/i,
  },
  {
    // SSH over 443, which this network allows even when 22 is blocked. Free
    // tunnels expire after 60 minutes: the process exits and is restarted.
    // Pinggy has renamed its hostnames more than once; match all of them.
    name: 'pinggy',
    cmd: 'ssh',
    args: [...SSH_OPTS, '-p', '443', '-R', `0:localhost:${PORT}`, 'a.pinggy.io'],
    url: /https:\/\/[a-z0-9-]+\.(?:run\.pinggy-free\.link|free\.pinggy\.net|a\.free\.pinggy\.link|pinggy\.link)/i,
    startTimeoutMs: 20_000,   // when pinggy answers at all it does so within seconds
  },
  {
    name: 'localtunnel',
    cmd: process.execPath,
    args: [path.join(ROOT, 'node_modules', 'localtunnel', 'bin', 'lt.js'), '--port', String(PORT)],
    url: /https:\/\/[a-z0-9-]+\.loca\.lt/i,
  },
];

let child = null;
let current = null;
let providerIndex = 0;
let starting = null;      // timer that rotates provider if no URL appears
let switching = false;

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function setWebhook(base) {
  const url = `${base.replace(/\/+$/, '')}/webhook`;
  try {
    const res = await fetch('https://waba-v2.360dialog.io/v1/configs/webhook', {
      method: 'POST',
      headers: {
        'D360-API-KEY': process.env.D360_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url, headers: { 'X-Valle-Token': process.env.VERIFY_TOKEN } }),
    });
    log(res.ok ? `✅ webhook -> ${url}` : `❌ webhook set failed ${res.status}`);
  } catch (e) {
    log('❌ webhook set error:', e.message);
  }
}

function stopChild() {
  clearTimeout(starting);
  starting = null;
  if (!child) return;
  const c = child;
  child = null;
  try { c.kill(); } catch { /* already gone */ }
}

function rotate(reason) {
  if (switching) return;
  switching = true;
  stopChild();
  current = null;
  providerIndex = (providerIndex + 1) % PROVIDERS.length;
  log(`${reason} — switching to ${PROVIDERS[providerIndex].name} in 5 s`);
  setTimeout(() => { switching = false; start(); }, 5000);
}

/**
 * Windows on this laptop intermittently refuses to start ANY process
 * ("spawn EPERM", a security policy or a sleeping machine). That used to
 * crash the keeper outright and take the webhook down until someone noticed.
 * Now a failed spawn is just another reason to try again shortly.
 */
const SPAWN_RETRY_MS = 15_000; 

function start() {
  const p = PROVIDERS[providerIndex];
  log(`starting tunnel via ${p.name}...`);
  try {
    child = spawn(p.cmd, p.args);
  } catch (err) {
    log(`could not start ${p.name} (${err.code || err.message}) — retrying in ${SPAWN_RETRY_MS / 1000} s`);
    child = null;
    setTimeout(start, SPAWN_RETRY_MS);
    return;
  }
  const mine = child;

  // Node reports most spawn failures asynchronously, as an 'error' event,
  // and an unhandled one kills the process.
  child.on('error', (err) => {
    if (mine !== child) return;
    log(`${p.name} spawn error (${err.code || err.message}) — retrying in ${SPAWN_RETRY_MS / 1000} s`);
    clearTimeout(starting);
    starting = null;
    child = null;
    current = null;
    setTimeout(start, SPAWN_RETRY_MS);
  });

  const onData = async (buf) => {
    const m = String(buf).match(p.url);
    if (m && m[0] !== current) {
      clearTimeout(starting);
      starting = null;
      current = m[0];
      currentSince = Date.now();
      publicMisses = 0;
      log(`tunnel up (${p.name}): ${current}`);
      await setWebhook(current);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('exit', (code) => {
    if (mine !== child) return;           // superseded by a rotation
    if (current) {
      log(`${p.name} exited (${code}) — restarting same provider`);
      current = null;
      child = null;
      setTimeout(start, 5000);
    } else {
      rotate(`${p.name} failed to start (exit ${code})`);
    }
  });

  // If no URL appears in time, this provider is blocked right now: rotate.
  const wait = p.startTimeoutMs || START_TIMEOUT_MS;
  starting = setTimeout(() => {
    if (!current) rotate(`${p.name} produced no URL in ${wait / 1000} s`);
  }, wait);
}

/**
 * Watchdog, two checks a minute apart:
 *
 *  1. The LOCAL server, so a dead bot is at least logged.
 *  2. The PUBLIC URL, the way 360dialog sees it. Tunnels die silently: the
 *     localtunnel process keeps running while loca.lt has forgotten it, and
 *     the webhook points at nothing. The child never exits, so only a real
 *     probe catches it. Two misses in a row and the provider is rotated.
 *
 * The office DNS cannot resolve tunnel hostnames, so the probe resolves the
 * name through Cloudflare's DNS-over-HTTPS and connects to the address
 * directly, with the hostname carried in SNI and the Host header.
 */
const PROBE_GRACE_MS = 60_000;   // a fresh tunnel needs a moment to propagate
const PROBE_EVERY_MS = 30_000;   // tunnels die within minutes here: look often
let currentSince = 0;
let publicMisses = 0;

async function resolvePublic(hostname) {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(8_000),
  });
  const j = await r.json();
  return (j.Answer || []).find((a) => a.type === 1)?.data || null;
}

function probePublic(url) {
  return new Promise((resolve) => {
    const { hostname } = new URL(url);
    resolvePublic(hostname).then((ip) => {
      if (!ip) return resolve(false);
      const req = https.request({
        host: ip, servername: hostname, path: '/health', method: 'GET', timeout: 12_000,
        headers: { Host: hostname, 'bypass-tunnel-reminder': '1' },
      }, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    }).catch(() => resolve(false));
  });
}

setInterval(async () => {
  try {
    const r = await fetch(`http://localhost:${PORT}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`http ${r.status}`);
  } catch (e) {
    log('local server not answering:', e.message, '(tunnel left running)');
    return;                                   // not the tunnel's fault
  }

  if (!current || Date.now() - currentSince < PROBE_GRACE_MS) return;
  const ok = await probePublic(current);
  if (ok) { publicMisses = 0; return; }
  publicMisses += 1;
  log(`public URL not reachable (${publicMisses}/2): ${current}`);
  if (publicMisses >= 2) {
    publicMisses = 0;
    rotate('public URL dead while the tunnel process lived on');
  }
}, PROBE_EVERY_MS);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopChild(); process.exit(0); });
}

// Whatever else goes wrong, the keeper's one job is to stay alive and keep
// trying: a dead keeper means a dead webhook until a person notices.
process.on('uncaughtException', (err) => {
  log('unexpected error, keeper continues:', err.code || err.message);
  if (!child) setTimeout(start, SPAWN_RETRY_MS);
});
process.on('unhandledRejection', (err) => {
  log('unhandled rejection, keeper continues:', err?.message || err);
});

start();
