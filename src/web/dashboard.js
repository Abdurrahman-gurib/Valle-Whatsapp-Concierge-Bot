/**
 * DASHBOARD — the back-office web app of the concierge.
 *
 *   GET  /dashboard?key=<DASHBOARD_KEY>   the app (HTML shell, data via JSON)
 *   GET  /dashboard/data?key=             stats, series, contacts, leads, feed
 *   GET  /dashboard/history?key=&wa_id=   one guest's conversation
 *   POST /dashboard/email?key=            { wa_id, email? } send the overview
 *   POST /dashboard/email-all?key=        overview to every QR guest with a
 *                                         captured address not yet emailed
 *
 * Search, filters, charts and CSV/print reports run in the browser on the
 * JSON payload; only the two email routes write anything. Disabled unless
 * DASHBOARD_KEY is set in .env. Keep the link private: it shows guest
 * numbers and can send email as marketing@.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q } from '../core/db.js';
import * as db from '../core/db.js';
import { config } from '../core/config.js';
import { sendOverviewEmail, emailEnabled, findEmail } from '../notify/email.js';

const TZ = config.bot.timezone;

const authed = (req) => config.dashboardKey && req.query.key === config.dashboardKey;

// Chart.js is served from the app itself: the park's office network blocks
// some CDNs (proven on 3 Sept — tables rendered, charts never did), and the
// dashboard must not depend on a third party being reachable.
const CHART_JS = fs.readFileSync(path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js'
));

export function mountDashboard(app) {
  app.get('/dashboard/chart.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(CHART_JS);
  });

  app.get('/dashboard', (req, res) => {
    // A colleague following the bare link (the user guide prints it without
    // the key on purpose) gets a friendly gate instead of "Forbidden".
    if (!authed(req)) return res.status(403).send(GATE);
    res.send(PAGE);
  });

  app.get('/dashboard/data', async (req, res) => {
    if (!authed(req)) return res.sendStatus(403);
    try {
      const [stats, series, scans, waiting, leads, contacts, messages] = await Promise.all([
        q(`SELECT
             (SELECT count(*) FROM contacts)                                                        AS total_contacts,
             (SELECT count(*) FROM contacts WHERE source IS NOT NULL)                               AS qr_scans,
             (SELECT count(*) FROM contacts WHERE last_seen_at > now() - interval '24 hours')       AS active_24h,
             (SELECT count(*) FROM contacts WHERE mode = 'waiting')                                 AS waiting,
             (SELECT count(*) FROM contacts WHERE mode = 'human')                                   AS in_human,
             (SELECT count(*) FROM messages WHERE created_at > now() - interval '24 hours')         AS msgs_24h,
             (SELECT count(*) FROM leads)                                                           AS leads_total,
             (SELECT count(*) FROM contacts WHERE email IS NOT NULL)                                AS emails_captured,
             (SELECT count(*) FROM contacts WHERE email_at IS NOT NULL)                             AS emails_sent`),
        q(`SELECT to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') AS day, direction, count(*) AS n
             FROM messages WHERE created_at > now() - interval '14 days'
            GROUP BY 1, 2 ORDER BY 1`, [TZ]),
        q(`SELECT to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') AS day, count(*) AS n
             FROM contacts WHERE source IS NOT NULL AND created_at > now() - interval '14 days'
            GROUP BY 1 ORDER BY 1`, [TZ]),
        q(`SELECT wa_id, profile_name, source, last_seen_at FROM contacts
            WHERE mode = 'waiting' ORDER BY last_seen_at ASC LIMIT 50`),
        q(`SELECT l.created_at, l.full_name, l.pax, l.visit_date, l.interest, c.profile_name, c.wa_id
             FROM leads l JOIN contacts c ON c.id = l.contact_id
            ORDER BY l.created_at DESC LIMIT 100`),
        q(`SELECT wa_id, profile_name, email, email_at, sms_at, source, mode, bot_silent,
                  created_at, last_seen_at
             FROM contacts ORDER BY last_seen_at DESC LIMIT 500`),
        q(`SELECT m.created_at, m.direction, m.author, m.body, c.profile_name, c.wa_id
             FROM messages m JOIN contacts c ON c.id = m.contact_id
            ORDER BY m.created_at DESC LIMIT 50`),
      ]);
      res.json({
        now: new Date().toISOString(),
        emailEnabled: emailEnabled(),
        stats: stats.rows[0],
        series: series.rows,
        scans: scans.rows,
        waiting: waiting.rows,
        leads: leads.rows,
        contacts: contacts.rows,
        messages: messages.rows,
      });
    } catch (err) {
      console.error('[dashboard] data', err);
      res.status(500).json({ error: 'query failed' });
    }
  });

  app.get('/dashboard/history', async (req, res) => {
    if (!authed(req)) return res.sendStatus(403);
    try {
      const contact = await db.getContactByWaId(String(req.query.wa_id || ''));
      if (!contact) return res.status(404).json({ error: 'no such guest' });
      const { rows } = await q(
        `SELECT created_at, direction, author, body, msg_type FROM messages
          WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [contact.id]
      );
      res.json({ contact: {
        wa_id: contact.wa_id, profile_name: contact.profile_name, email: contact.email,
        source: contact.source, mode: contact.mode, bot_silent: contact.bot_silent,
      }, messages: rows.reverse() });
    } catch (err) {
      console.error('[dashboard] history', err);
      res.status(500).json({ error: 'query failed' });
    }
  });

  // One guest: optionally capture a typed address, then send the overview.
  app.post('/dashboard/email', async (req, res) => {
    if (!authed(req)) return res.sendStatus(403);
    if (!emailEnabled()) return res.status(503).json({ error: 'email is not configured' });
    try {
      const waId = String(req.body?.wa_id || '');
      const contact = await db.getContactByWaId(waId);
      if (!contact) return res.status(404).json({ error: 'no such guest' });

      let address = contact.email;
      if (req.body?.email) {
        const typed = findEmail(req.body.email);
        if (!typed) return res.status(400).json({ error: 'that does not look like an email address' });
        await db.setEmail(waId, typed);
        address = typed;
      }
      if (!address) return res.status(400).json({ error: 'no email on file for this guest' });

      const ok = await sendOverviewEmail({ to: address, name: contact.profile_name });
      if (!ok) return res.status(502).json({ error: 'send failed — check server logs' });
      await db.markEmailSent(waId);
      console.log(`[dashboard] overview emailed to ${address} for ${waId} (by back office)`);
      res.json({ ok: true, email: address });
    } catch (err) {
      console.error('[dashboard] email', err);
      res.status(500).json({ error: 'send failed' });
    }
  });

  // Every QR guest with a captured address who has not been emailed yet.
  // Never re-sends: a guest gets the overview once, whoever triggers it.
  app.post('/dashboard/email-all', async (req, res) => {
    if (!authed(req)) return res.sendStatus(403);
    if (!emailEnabled()) return res.status(503).json({ error: 'email is not configured' });
    try {
      const { rows } = await q(
        `SELECT wa_id, profile_name, email FROM contacts
          WHERE source IS NOT NULL AND email IS NOT NULL AND email_at IS NULL
          ORDER BY last_seen_at DESC LIMIT 50`
      );
      let sent = 0;
      const failed = [];
      for (const c of rows) {
        const ok = await sendOverviewEmail({ to: c.email, name: c.profile_name });
        if (ok) { await db.markEmailSent(c.wa_id); sent += 1; }
        else failed.push(c.email);
        // Resend rate limit is 2/s on the standard plan: stay well under it.
        await new Promise((r) => setTimeout(r, 700));
      }
      console.log(`[dashboard] bulk overview: ${sent} sent, ${failed.length} failed (by back office)`);
      res.json({ ok: true, candidates: rows.length, sent, failed });
    } catch (err) {
      console.error('[dashboard] email-all', err);
      res.status(500).json({ error: 'bulk send failed' });
    }
  });
}

/* ══════════════ the access gate (wrong or missing key) ══════════════ */

const GATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vallé Concierge — Access</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow:ital,wght@1,800&family=Work+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#340057;font:15px 'Work Sans',system-ui,sans-serif;color:#22133A}
  .card{background:#F7F4EF;border-radius:18px;padding:34px 36px;max-width:380px;width:calc(100% - 40px);text-align:center}
  .brand{font:italic 800 30px/0.85 Barlow,sans-serif;color:#340057;transform:rotate(-4deg);display:inline-block}
  .brand small{display:block;font:italic 800 10px/1.8 Barlow,sans-serif;letter-spacing:.4em;color:#7333FF}
  p{color:#6E6280;font-size:13.5px;margin:14px 0 18px}
  input{width:100%;padding:11px 14px;border:1px solid #D8D2E6;border-radius:10px;font:inherit;text-align:center}
  button{width:100%;margin-top:10px;padding:11px;border:0;border-radius:10px;background:#FF3358;
         color:#fff;font:600 14px 'Work Sans';cursor:pointer}
</style></head><body><div class="card">
  <span class="brand">VALLÉ<small>ADVENATURE&nbsp;PARK</small></span>
  <p>This is the team dashboard of the Vallé WhatsApp Concierge.<br>Enter the access key to continue.</p>
  <form onsubmit="location.href='/dashboard?key='+encodeURIComponent(document.getElementById('k').value.trim());return false">
    <input id="k" type="password" placeholder="access key" autofocus>
    <button>Open the dashboard</button>
  </form>
</div></body></html>`;

/* ═══════════════════════ the app shell ═══════════════════════ */
/* Vallé Brand Guidelines V2: Barlow ExtraBold Italic headlines on the 4°
   tilt, Work Sans text, Chivo Mono numbers, the five brand colours, the
   Slope on the header. All data arrives via /dashboard/data. */

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vallé Concierge — Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow:ital,wght@1,800&family=Work+Sans:wght@400;500;600&family=Chivo+Mono:wght@400;600&display=swap" rel="stylesheet">
<script src="/dashboard/chart.js"></script>
<style>
  :root{
    --purple:#340057; --scarlet:#FF3358; --indigo:#7333FF; --yellow:#FFFC33;
    --green:#33FF74; --lavender:#EBE2FF; --ink:#22133A; --dim:#7A6E8C;
    --paper:#F7F4EF; --card:#FFFFFF; --line:#E6E0D6;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 'Work Sans',system-ui,sans-serif}
  .num,.mono{font-family:'Chivo Mono',monospace;font-variant-numeric:tabular-nums;white-space:nowrap}

  /* header on the Slope */
  header{background:var(--purple);color:#fff;padding:26px 22px 40px;position:relative;overflow:hidden}
  header::after{content:'';position:absolute;left:-2%;right:-2%;bottom:-26px;height:52px;background:var(--paper);transform:rotate(-2deg)}
  header .lines{position:absolute;right:-40px;top:-30px;width:280px;height:200px;opacity:.55;
    background:repeating-linear-gradient(115deg,transparent 0 26px,var(--indigo) 26px 34px)}
  .brand{font:italic 800 34px/0.8 Barlow,sans-serif;letter-spacing:.01em;color:var(--yellow);
    transform:rotate(-4deg);display:inline-block;margin:6px 0 0 4px}
  .brand small{display:block;color:#fff;font:italic 800 12px/1.6 Barlow,sans-serif;letter-spacing:.42em}
  .sub{position:relative;color:var(--lavender);font-size:12.5px;margin-top:10px}
  .sub .dot{display:inline-block;width:8px;height:8px;border-radius:99px;background:var(--green);margin-right:5px}

  .wrap{max-width:1180px;margin:0 auto;padding:20px 18px 70px}
  h2{font:italic 800 19px Barlow,sans-serif;color:var(--purple);text-transform:uppercase;
     letter-spacing:.03em;margin:34px 0 12px;border-left:5px solid var(--scarlet);padding-left:10px}

  /* KPI tiles */
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:12px;margin-top:-14px;position:relative}
  .tile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 15px;border-bottom:4px solid var(--indigo)}
  .tile .n{font:600 25px 'Chivo Mono',monospace;color:var(--purple)}
  .tile .l{font-size:11px;color:var(--dim);letter-spacing:.07em;text-transform:uppercase;font-weight:600}
  .tile.warn{border-bottom-color:var(--scarlet)} .tile.warn .n{color:var(--scarlet)}
  .tile.go{border-bottom-color:var(--green)}

  /* charts */
  .charts{display:grid;grid-template-columns:2fr 1fr;gap:14px}
  .charts .panel:nth-child(3){grid-column:1}
  @media(max-width:860px){.charts{grid-template-columns:1fr}}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}
  .panel h3{margin:0 0 8px;font:600 12px 'Work Sans';color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
  .panel .cv{position:relative;height:210px}

  /* toolbar */
  .bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 10px}
  .bar input[type=search]{flex:1;min-width:190px;padding:9px 13px;border:1px solid var(--line);border-radius:10px;font:inherit;background:#fff}
  .bar select{padding:9px 10px;border:1px solid var(--line);border-radius:10px;font:inherit;background:#fff;color:var(--ink)}
  .btn{border:0;border-radius:10px;padding:9px 14px;font:600 13px 'Work Sans';cursor:pointer;white-space:nowrap}
  .btn.primary{background:var(--purple);color:#fff}
  .btn.hot{background:var(--scarlet);color:#fff}
  .btn.ghost{background:var(--lavender);color:var(--purple)}
  .btn:disabled{opacity:.5;cursor:default}
  .count{font-size:12px;color:var(--dim);margin-left:auto}

  /* tables */
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:13.5px;min-width:680px}
  th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);text-align:left;font-weight:600}
  th,td{padding:9px 14px;border-top:1px solid #F0EDE5;vertical-align:middle}
  thead th{border-top:none;background:#FBFAF6}
  tbody tr.click{cursor:pointer} tbody tr.click:hover{background:#F6F2FF}
  .pill{display:inline-block;color:#fff;font-size:11px;font-weight:600;padding:1px 9px;border-radius:99px;white-space:nowrap}
  .dim{color:#B4ABC4}
  .msg{max-width:460px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .empty{padding:16px;color:var(--dim);font-size:13.5px}
  .mail-ok{color:#1E8A4C;font-weight:600;font-size:12px}

  /* modal */
  .overlay{position:fixed;inset:0;background:rgba(34,19,58,.55);display:none;align-items:center;justify-content:center;padding:16px;z-index:50}
  .overlay.open{display:flex}
  .modal{background:var(--paper);border-radius:16px;max-width:640px;width:100%;max-height:86vh;display:flex;flex-direction:column;overflow:hidden}
  .modal header{padding:14px 18px;background:var(--purple);overflow:visible}
  .modal header::after{display:none}
  .modal h4{margin:0;color:#fff;font:italic 800 16px Barlow}
  .modal .meta{color:var(--lavender);font-size:12px;margin-top:2px}
  .modal .x{position:absolute;top:10px;right:14px;background:none;border:0;color:#fff;font-size:20px;cursor:pointer}
  .chat{overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
  .bubble{max-width:82%;padding:8px 12px;border-radius:14px;font-size:13.5px;white-space:pre-wrap;word-break:break-word}
  .bubble.in{background:#fff;border:1px solid var(--line);align-self:flex-start;border-bottom-left-radius:4px}
  .bubble.out{background:var(--lavender);align-self:flex-end;border-bottom-right-radius:4px}
  .bubble .who{font-size:10.5px;color:var(--dim);margin-bottom:2px}
  .modal footer{padding:12px 16px;border-top:1px solid var(--line);display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#fff}
  .modal footer input{flex:1;min-width:170px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;font:inherit}

  #toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--purple);color:#fff;
    padding:11px 18px;border-radius:12px;font-size:13.5px;display:none;z-index:60;max-width:88vw}
  #toast.err{background:var(--scarlet)}

  @media print{
    header .lines,.bar,.btn,#toast,.overlay{display:none!important}
    body{background:#fff} .card,.panel,.tile{border-color:#ccc;break-inside:avoid}
    .charts{display:block} .panel{margin-bottom:12px}
  }
</style></head><body>

<header><div class="lines"></div>
  <span class="brand">VALLÉ<small>ADVENATURE&nbsp;PARK&nbsp;·&nbsp;MAURITIUS</small></span>
  <div class="sub"><span class="dot"></span><span id="updated">loading…</span> · auto-refreshes every 60&nbsp;s</div>
</header>

<div class="wrap">
  <div class="tiles" id="tiles"></div>

  <h2>Activity</h2>
  <div class="charts">
    <div class="panel"><h3>Messages per day — 14 days</h3><div class="cv"><canvas id="chMsgs"></canvas></div></div>
    <div class="panel"><h3>Guests by source</h3><div class="cv"><canvas id="chSrc"></canvas></div></div>
    <div class="panel"><h3>QR scans per day — 14 days</h3><div class="cv"><canvas id="chScans"></canvas></div></div>
    <div class="panel"><h3>Chats by mode</h3><div class="cv"><canvas id="chMode"></canvas></div></div>
  </div>

  <h2>Guests</h2>
  <div class="bar">
    <input type="search" id="q" placeholder="Search name, number or email…">
    <select id="fSource"><option value="">Source: all</option><option value="atm-dubai-2026">ATM Dubai 2026</option><option value="__none">No QR</option></select>
    <select id="fMode"><option value="">Mode: all</option><option value="bot">bot</option><option value="human">human</option><option value="waiting">waiting</option><option value="paused">paused</option><option value="__needs">needs a person</option></select>
    <select id="fEmail"><option value="">Email: all</option><option value="has">captured</option><option value="sent">overview sent</option><option value="unsent">captured, not sent</option><option value="none">none</option></select>
    <select id="fWhen"><option value="">Seen: any time</option><option value="1">today</option><option value="7">last 7 days</option></select>
    <button class="btn ghost" id="csv">⬇ CSV</button>
    <button class="btn ghost" onclick="window.print()">🖨 Report</button>
    <button class="btn hot" id="emailAll" title="Overview email to every QR guest with a captured address who has not received it">📧 Email all ATM scans</button>
    <span class="count" id="count"></span>
  </div>
  <div class="card"><table>
    <thead><tr><th>Guest</th><th>Number</th><th>Email</th><th>Source</th><th>Mode</th><th>Last seen</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table></div>

  <h2>Waiting for a human 🔔</h2>
  <div class="card" id="waiting"></div>

  <h2>Leads</h2>
  <div class="card" id="leads"></div>

  <h2>Latest messages</h2>
  <div class="card" id="feed"></div>
</div>

<div class="overlay" id="overlay"><div class="modal">
  <header><h4 id="mName"></h4><div class="meta" id="mMeta"></div><button class="x" id="mClose">✕</button></header>
  <div class="chat" id="mChat"></div>
  <footer>
    <input id="mEmail" type="email" placeholder="guest email…">
    <button class="btn primary" id="mSend">📧 Send overview</button>
  </footer>
</div></div>

<div id="toast"></div>

<script>
const KEY = new URLSearchParams(location.search).get('key');
const api = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when = (d) => d ? new Intl.DateTimeFormat('en-GB',{timeZone:'${TZ}',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(d)) : '';
const C = { purple:'#340057', scarlet:'#FF3358', indigo:'#7333FF', yellow:'#FFFC33', green:'#33FF74', lavender:'#EBE2FF', dim:'#7A6E8C' };
const MODE_COLORS = { bot:'#1E8A4C', waiting:'#B8860B', human:C.indigo, paused:C.dim };

let D = null, charts = {}, modalWaId = null;

const toast = (msg, err) => { const t = document.getElementById('toast');
  t.textContent = msg; t.className = err ? 'err' : ''; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 4200); };

async function load() {
  try {
    const r = await fetch(api('/dashboard/data'));
    if (!r.ok) throw new Error(r.status);
    D = await r.json();
  } catch (e) { toast('Could not refresh data (' + e.message + ')', true); return; }
  document.getElementById('updated').textContent = 'Live · updated ' + when(D.now) + ' (Mauritius time)';
  tiles(); renderRows(); renderWaiting(); renderLeads(); renderFeed();
  // Charts come last and must never take the tables down with them: if the
  // Chart.js CDN is unreachable, the dashboard still works without graphs.
  try { if (typeof Chart !== 'undefined') drawCharts(); } catch (e) { console.warn('charts skipped:', e); }
  document.getElementById('emailAll').disabled = !D.emailEnabled;
}

function tiles() {
  const s = D.stats;
  const t = (n, l, cls='') => \`<div class="tile \${cls}"><div class="n num">\${n}</div><div class="l">\${l}</div></div>\`;
  document.getElementById('tiles').innerHTML =
    t(s.total_contacts,'Guests') + t(s.qr_scans,'QR scans','go') + t(s.active_24h,'Active 24 h') +
    t(s.waiting,'Waiting 🔔', s.waiting > 0 ? 'warn' : '') + t(s.msgs_24h,'Messages 24 h') +
    t(s.leads_total,'Leads') + t(s.emails_captured,'Emails captured') + t(s.emails_sent,'Overviews sent','go');
}

function drawCharts() {
  const days = []; for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i*864e5);
    days.push(d.toLocaleDateString('en-CA', { timeZone: '${TZ}' })); }
  const short = days.map((d) => d.slice(5));
  const series = (dir) => days.map((d) => Number((D.series.find((r) => r.day === d && r.direction === dir) || {}).n || 0));
  const scans = days.map((d) => Number((D.scans.find((r) => r.day === d) || {}).n || 0));

  const bySrc = {}; const byMode = {};
  for (const c of D.contacts) {
    bySrc[c.source || 'no QR'] = (bySrc[c.source || 'no QR'] || 0) + 1;
    const m = c.bot_silent ? 'needs a person' : c.mode;
    byMode[m] = (byMode[m] || 0) + 1;
  }

  const mk = (id, cfg) => { charts[id]?.destroy(); charts[id] = new Chart(document.getElementById(id), cfg); };
  const base = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } } };

  mk('chMsgs', { type: 'bar', data: { labels: short, datasets: [
      { label: 'from guests', data: series('in'),  backgroundColor: C.indigo,  stack: 's' },
      { label: 'replies',     data: series('out'), backgroundColor: C.scarlet, stack: 's' }]},
    options: { ...base, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { precision: 0 } } } } });

  mk('chScans', { type: 'line', data: { labels: short, datasets: [
      { label: 'QR scans', data: scans, borderColor: C.purple, backgroundColor: 'rgba(115,51,255,.18)', fill: true, tension: .3, pointRadius: 3, pointBackgroundColor: C.scarlet }]},
    options: { ...base, scales: { x: { grid: { display: false } }, y: { ticks: { precision: 0 } } } } });

  const donut = (labels, data, colors) => ({ type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: '#fff' }] },
    options: { ...base, cutout: '58%' } });
  mk('chSrc',  donut(Object.keys(bySrc),  Object.values(bySrc),  [C.green, C.purple, C.scarlet, C.yellow, C.indigo]));
  mk('chMode', donut(Object.keys(byMode), Object.values(byMode),
    Object.keys(byMode).map((m) => m === 'needs a person' ? C.scarlet : (MODE_COLORS[m] || C.dim))));
}

function filtered() {
  const qv = document.getElementById('q').value.trim().toLowerCase();
  const fs = document.getElementById('fSource').value;
  const fm = document.getElementById('fMode').value;
  const fe = document.getElementById('fEmail').value;
  const fw = document.getElementById('fWhen').value;
  const cutoff = fw ? Date.now() - Number(fw) * 864e5 : 0;
  return D.contacts.filter((c) => {
    if (qv && !((c.profile_name || '') + ' ' + c.wa_id + ' ' + (c.email || '')).toLowerCase().includes(qv)) return false;
    if (fs === '__none' ? c.source : (fs && c.source !== fs)) return false;
    if (fm === '__needs' ? !c.bot_silent : (fm && c.mode !== fm)) return false;
    if (fe === 'has'    && !c.email) return false;
    if (fe === 'sent'   && !c.email_at) return false;
    if (fe === 'unsent' && !(c.email && !c.email_at)) return false;
    if (fe === 'none'   && c.email) return false;
    if (cutoff && new Date(c.last_seen_at).getTime() < cutoff) return false;
    return true;
  });
}

const pill = (text, color) => \`<span class="pill" style="background:\${color}">\${esc(text)}</span>\`;
const modePill = (c) => c.bot_silent ? pill('needs a person', C.scarlet) : pill(c.mode, MODE_COLORS[c.mode] || C.dim);

function renderRows() {
  const rows = filtered();
  document.getElementById('count').textContent = rows.length + ' of ' + D.contacts.length + ' guests';
  document.getElementById('rows').innerHTML = rows.length ? rows.map((c) => \`
    <tr class="click" data-wa="\${esc(c.wa_id)}">
      <td>\${esc(c.profile_name || c.wa_id)}</td>
      <td class="num">\${esc(c.wa_id)}</td>
      <td>\${c.email ? esc(c.email) + (c.email_at ? ' <span class="mail-ok">✓ sent</span>' : '') : '<span class="dim">–</span>'}</td>
      <td>\${c.source ? pill(c.source, '#14432A') : '<span class="dim">–</span>'}</td>
      <td>\${modePill(c)}</td>
      <td class="num">\${when(c.last_seen_at)}</td>
      <td><button class="btn ghost" data-mail="\${esc(c.wa_id)}" \${D.emailEnabled ? '' : 'disabled'}>📧</button></td>
    </tr>\`).join('')
    : '<tr><td colspan="7" class="empty">No guests match these filters.</td></tr>';
}

function renderWaiting() {
  const w = D.waiting;
  document.getElementById('waiting').innerHTML = w.length ? \`<table>
    <thead><tr><th>Guest</th><th>Number</th><th>Source</th><th>Since</th></tr></thead><tbody>\${
    w.map((c) => \`<tr><td>\${esc(c.profile_name || c.wa_id)}</td><td class="num">\${esc(c.wa_id)}</td>
      <td>\${c.source ? pill(c.source, '#14432A') : '<span class="dim">–</span>'}</td><td class="num">\${when(c.last_seen_at)}</td></tr>\`).join('')
    }</tbody></table>\` : '<div class="empty">Nobody waiting — the bot has it covered. 🌿</div>';
}

function renderLeads() {
  const l = D.leads;
  document.getElementById('leads').innerHTML = l.length ? \`<table>
    <thead><tr><th>When</th><th>Guest</th><th>Pax</th><th>Date of visit</th><th>Interest</th></tr></thead><tbody>\${
    l.map((x) => \`<tr><td class="num">\${when(x.created_at)}</td><td>\${esc(x.full_name || x.profile_name || x.wa_id)}</td>
      <td class="num">\${esc(x.pax ?? '?')}</td><td>\${esc(x.visit_date || 'TBC')}</td><td class="msg">\${esc(x.interest || '')}</td></tr>\`).join('')
    }</tbody></table>\` : '<div class="empty">No leads captured yet.</div>';
}

function renderFeed() {
  const m = D.messages;
  document.getElementById('feed').innerHTML = m.length ? \`<table>
    <thead><tr><th>When</th><th>Guest</th><th></th><th>From</th><th>Message</th></tr></thead><tbody>\${
    m.map((x) => \`<tr><td class="num">\${when(x.created_at)}</td><td>\${esc(x.profile_name || x.wa_id)}</td>
      <td style="color:\${x.direction === 'in' ? C.indigo : '#1E8A4C'};font-weight:600">\${x.direction === 'in' ? '⟶' : '⟵'}</td>
      <td>\${esc(x.author)}</td><td class="msg">\${esc(x.body || '')}</td></tr>\`).join('')
    }</tbody></table>\` : '<div class="empty">No messages yet.</div>';
}

/* ── conversation modal ── */
async function openModal(waId) {
  modalWaId = waId;
  const r = await fetch(api('/dashboard/history?wa_id=' + encodeURIComponent(waId)));
  if (!r.ok) { toast('Could not load that conversation', true); return; }
  const h = await r.json();
  document.getElementById('mName').textContent = h.contact.profile_name || h.contact.wa_id;
  document.getElementById('mMeta').textContent =
    h.contact.wa_id + (h.contact.email ? ' · ' + h.contact.email : '') +
    (h.contact.source ? ' · ' + h.contact.source : '') + ' · mode: ' + (h.contact.bot_silent ? 'needs a person' : h.contact.mode);
  document.getElementById('mEmail').value = h.contact.email || '';
  document.getElementById('mChat').innerHTML = h.messages.map((m) => \`
    <div class="bubble \${m.direction === 'in' ? 'in' : 'out'}">
      <div class="who">\${esc(m.author)} · \${when(m.created_at)}</div>\${esc(m.body || '[' + (m.msg_type || 'media') + ']')}</div>\`).join('')
    || '<div class="empty">No messages stored.</div>';
  document.getElementById('overlay').classList.add('open');
  const chat = document.getElementById('mChat'); chat.scrollTop = chat.scrollHeight;
}
const closeModal = () => { document.getElementById('overlay').classList.remove('open'); modalWaId = null; };

async function sendOverview(waId, typedEmail) {
  const body = { wa_id: waId }; if (typedEmail) body.email = typedEmail;
  const r = await fetch(api('/dashboard/email'), { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { toast('Overview emailed to ' + j.email + ' 🌿'); load(); }
  else toast(j.error || 'Send failed', true);
}

/* ── events ── */
for (const id of ['q', 'fSource', 'fMode', 'fEmail', 'fWhen'])
  document.getElementById(id).addEventListener('input', renderRows);

document.getElementById('rows').addEventListener('click', (e) => {
  const mail = e.target.closest('[data-mail]');
  if (mail) { e.stopPropagation();
    const c = D.contacts.find((x) => x.wa_id === mail.dataset.mail);
    if (c?.email) { if (confirm('Send the park overview to ' + c.email + '?')) sendOverview(c.wa_id); }
    else openModal(mail.dataset.mail);
    return; }
  const tr = e.target.closest('tr[data-wa]');
  if (tr) openModal(tr.dataset.wa);
});
document.getElementById('mClose').addEventListener('click', closeModal);
document.getElementById('overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeModal(); });
document.getElementById('mSend').addEventListener('click', () => {
  const typed = document.getElementById('mEmail').value.trim();
  if (!typed) { toast('Type the guest\\'s email first', true); return; }
  sendOverview(modalWaId, typed);
  closeModal();
});

document.getElementById('emailAll').addEventListener('click', async () => {
  const pending = D.contacts.filter((c) => c.source && c.email && !c.email_at).length;
  if (!pending) { toast('Every QR guest with an email already has the overview 🌿'); return; }
  if (!confirm('Send the park overview to ' + pending + ' QR guest(s) with a captured email who have not received it yet?')) return;
  const btn = document.getElementById('emailAll'); btn.disabled = true;
  try {
    const r = await fetch(api('/dashboard/email-all'), { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (r.ok) toast('Sent ' + j.sent + ' of ' + j.candidates + (j.failed?.length ? ' — failed: ' + j.failed.join(', ') : ' 🌿'), Boolean(j.failed?.length));
    else toast(j.error || 'Bulk send failed', true);
  } finally { btn.disabled = false; load(); }
});

document.getElementById('csv').addEventListener('click', () => {
  const rows = filtered();
  const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = ['Guest,Number,Email,Overview sent,Source,Mode,Last seen',
    ...rows.map((c) => [c.profile_name || '', c.wa_id, c.email || '', c.email_at ? when(c.email_at) : '',
      c.source || '', c.bot_silent ? 'needs a person' : c.mode, when(c.last_seen_at)].map(cell).join(','))].join('\\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\\ufeff' + csv], { type: 'text/csv' }));
  a.download = 'valle-guests-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
});

load();
setInterval(() => { if (!document.hidden && !modalWaId) load(); }, 60000);
</script></body></html>`;
