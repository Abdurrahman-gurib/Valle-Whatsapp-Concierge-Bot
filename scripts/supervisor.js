#!/usr/bin/env node
/**
 * SUPERVISOR — keeps the bot and the tunnel alive on this laptop.
 *
 *   npm run up
 *
 * Starts `node src/server.js` and `node scripts/tunnel-keeper.js`, and
 * restarts either one the moment it exits, with a short back-off so a crash
 * loop cannot spin. A failed start (Windows "spawn EPERM", seen several times
 * on this machine) is retried the same way instead of ending the supervisor.
 *
 * Logs go to logs/server.out.log, logs/server.err.log and logs/tunnel.log as
 * before; the supervisor's own lines go to logs/supervisor.log.
 *
 * This is a bridge until the bot moves to Railway. If Windows kills the
 * supervisor itself, nothing here can help; that is what a cloud host is for.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGS = path.join(ROOT, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

const supLog = fs.createWriteStream(path.join(LOGS, 'supervisor.log'), { flags: 'a' });
const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  supLog.write(line + '\n');
  console.log(line);
};

const MIN_BACKOFF = 5_000;
const MAX_BACKOFF = 60_000;

const SERVICES = [
  {
    name: 'server',
    args: ['src/server.js'],
    out: path.join(LOGS, 'server.out.log'),
    err: path.join(LOGS, 'server.err.log'),
  },
  {
    name: 'tunnel',
    args: ['scripts/tunnel-keeper.js'],
    out: path.join(LOGS, 'tunnel.log'),
    err: path.join(LOGS, 'tunnel.log'),
  },
];

const state = new Map(); // name -> { child, backoff, timer }

function start(svc) {
  const s = state.get(svc.name) || { child: null, backoff: MIN_BACKOFF, timer: null };
  state.set(svc.name, s);
  s.timer = null;

  let child;
  try {
    child = spawn(process.execPath, svc.args, {
      cwd: ROOT,
      // This office network intercepts some TLS with its own certificate.
      // Trusting the Windows store lets the keeper's public probe (DNS over
      // HTTPS) work; Node otherwise rejects the corporate CA.
      env: { ...process.env, NODE_USE_SYSTEM_CA: '1' },
      stdio: ['ignore', fs.openSync(svc.out, 'a'), fs.openSync(svc.err, 'a')],
      windowsHide: true,
    });
  } catch (err) {
    return retry(svc, s, `could not start (${err.code || err.message})`);
  }

  s.child = child;
  const startedAt = Date.now();
  log(`${svc.name} started, pid ${child.pid}`);

  child.on('error', (err) => {
    if (s.child !== child) return;
    s.child = null;
    retry(svc, s, `spawn error (${err.code || err.message})`);
  });

  child.on('exit', (code, signal) => {
    if (s.child !== child) return;
    s.child = null;
    // A process that ran for a while earned a fresh back-off.
    if (Date.now() - startedAt > 120_000) s.backoff = MIN_BACKOFF;
    retry(svc, s, `exited (${signal || code})`);
  });
}

function retry(svc, s, why) {
  if (shuttingDown) return;
  log(`${svc.name} ${why} — restarting in ${s.backoff / 1000} s`);
  s.timer = setTimeout(() => start(svc), s.backoff);
  s.backoff = Math.min(s.backoff * 2, MAX_BACKOFF);
}

let shuttingDown = false;
function shutdown() {
  shuttingDown = true;
  log('supervisor stopping');
  for (const s of state.values()) {
    clearTimeout(s.timer);
    try { s.child?.kill(); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(0), 500);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);

process.on('uncaughtException', (err) => log('unexpected error, supervisor continues:', err.code || err.message));
process.on('unhandledRejection', (err) => log('unhandled rejection, supervisor continues:', err?.message || err));

log('supervisor starting');
for (const svc of SERVICES) start(svc);
