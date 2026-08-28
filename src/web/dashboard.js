/**
 * DASHBOARD — read-only web view of the concierge.
 *
 * GET /dashboard?key=<DASHBOARD_KEY>
 * Shows live stats, the human-waiting queue, captured leads, recent
 * conversations and the latest messages. Auto-refreshes every 30 s.
 * Disabled unless DASHBOARD_KEY is set in .env. Keep the link private.
 */
import { q } from '../core/db.js';
import { config } from '../core/config.js';

const TZ = config.bot.timezone;

export function mountDashboard(app) {
  app.get('/dashboard', async (req, res) => {
    if (!config.dashboardKey || req.query.key !== config.dashboardKey) {
      return res.sendStatus(403);
    }
    try {
      const [stats, waiting, leads, contacts, messages] = await Promise.all([
        q(`SELECT
             (SELECT count(*) FROM contacts) AS total_contacts,
             (SELECT count(*) FROM contacts WHERE last_seen_at > now() - interval '24 hours') AS active_24h,
             (SELECT count(*) FROM contacts WHERE mode = 'waiting') AS waiting,
             (SELECT count(*) FROM contacts WHERE mode = 'human') AS in_human,
             (SELECT count(*) FROM messages WHERE created_at > now() - interval '24 hours') AS msgs_24h,
             (SELECT count(*) FROM leads WHERE created_at > now() - interval '7 days') AS leads_7d`),
        q(`SELECT * FROM contacts WHERE mode = 'waiting' ORDER BY last_seen_at ASC LIMIT 20`),
        q(`SELECT l.*, c.profile_name, c.wa_id FROM leads l
             JOIN contacts c ON c.id = l.contact_id
            ORDER BY l.created_at DESC LIMIT 20`),
        q(`SELECT * FROM contacts ORDER BY last_seen_at DESC LIMIT 20`),
        q(`SELECT m.created_at, m.direction, m.author, m.body, c.profile_name, c.wa_id
             FROM messages m JOIN contacts c ON c.id = m.contact_id
            ORDER BY m.created_at DESC LIMIT 30`),
      ]);
      res.send(page({
        s: stats.rows[0],
        waiting: waiting.rows,
        leads: leads.rows,
        contacts: contacts.rows,
        messages: messages.rows,
      }));
    } catch (err) {
      console.error('[dashboard]', err);
      res.status(500).send('Dashboard error — check server logs.');
    }
  });
}

/* ───────────────────────── rendering ───────────────────────── */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const when = (d) => d
  ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d))
  : '';

const MODE_COLORS = { bot: '#2E7D4F', waiting: '#A66B1F', human: '#2B6CB0', paused: '#718096' };

const pill = (text, color) =>
  `<span class="pill" style="background:${color}">${esc(text)}</span>`;

// A guest who asked for a person is waiting on the TEAM, not on the bot:
// the dashboard has to say so, or nobody knows the chat is unattended.
const modePill = (c) => c.bot_silent
  ? pill('needs a person', '#C53030')
  : pill(c.mode, MODE_COLORS[c.mode] || '#718096');
const srcPill = (s) => s ? pill(s, '#14432A') : '<span class="dim">–</span>';

function page({ s, waiting, leads, contacts, messages }) {
  const name = (c) => esc(c.profile_name || c.wa_id);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Vallé Concierge — Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap');
  *{box-sizing:border-box} body{font-family:Outfit,system-ui,sans-serif;margin:0;background:#F7F5F0;color:#1A2B21;font-weight:300}
  .wrap{max-width:1100px;margin:0 auto;padding:28px 18px 60px}
  h1{font-size:24px;font-weight:800;color:#14432A;margin:0}
  .sub{color:#6B7F72;font-size:13px;margin:4px 0 24px}
  h2{font-size:16px;font-weight:600;color:#14432A;margin:32px 0 10px}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .tile{background:#fff;border:1px solid #E3E0D8;border-radius:14px;padding:14px 16px}
  .tile .n{font-size:26px;font-weight:800;color:#14432A;font-variant-numeric:tabular-nums}
  .tile .l{font-size:12px;color:#6B7F72;letter-spacing:.06em;text-transform:uppercase;font-weight:600}
  .tile.warn .n{color:#A66B1F}
  .card{background:#fff;border:1px solid #E3E0D8;border-radius:14px;overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:13.5px;min-width:640px}
  th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7F72;text-align:left;font-weight:600}
  th,td{padding:9px 14px;border-top:1px solid #EFEDE6;vertical-align:top}
  thead th{border-top:none}
  .pill{display:inline-block;color:#fff;font-size:11px;font-weight:600;padding:1px 9px;border-radius:99px;white-space:nowrap}
  .dim{color:#9AA89F}
  .msg{max-width:480px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .in{color:#2B6CB0;font-weight:600}.out{color:#2E7D4F;font-weight:600}
  .num{font-variant-numeric:tabular-nums;white-space:nowrap}
  .empty{padding:16px;color:#9AA89F;font-size:13.5px}
</style></head><body><div class="wrap">
<h1>🌿 Vallé Concierge</h1>
<p class="sub">Live dashboard · ${when(new Date())} (Mauritius time) · refreshes every 30 s</p>

<div class="tiles">
  <div class="tile"><div class="n">${s.total_contacts}</div><div class="l">Contacts</div></div>
  <div class="tile"><div class="n">${s.active_24h}</div><div class="l">Active 24 h</div></div>
  <div class="tile warn"><div class="n">${s.waiting}</div><div class="l">Waiting 🔔</div></div>
  <div class="tile"><div class="n">${s.in_human}</div><div class="l">With human</div></div>
  <div class="tile"><div class="n">${s.msgs_24h}</div><div class="l">Messages 24 h</div></div>
  <div class="tile"><div class="n">${s.leads_7d}</div><div class="l">Leads 7 d</div></div>
</div>

<h2>🔔 Waiting for a human</h2>
<div class="card">${waiting.length ? `<table>
  <thead><tr><th>Guest</th><th>Number</th><th>Source</th><th>Since</th></tr></thead>
  <tbody>${waiting.map((c) => `<tr>
    <td>${name(c)}</td><td class="num">${esc(c.wa_id)}</td>
    <td>${srcPill(c.source)}</td><td class="num">${when(c.last_seen_at)}</td>
  </tr>`).join('')}</tbody></table>`
  : `<div class="empty">Nobody waiting — the bot has it covered. 🌿</div>`}</div>

<h2>🎟 Recent leads</h2>
<div class="card">${leads.length ? `<table>
  <thead><tr><th>When</th><th>Guest</th><th>Pax</th><th>Date of visit</th><th>Interest</th></tr></thead>
  <tbody>${leads.map((l) => `<tr>
    <td class="num">${when(l.created_at)}</td>
    <td>${esc(l.full_name || l.profile_name || l.wa_id)}</td>
    <td class="num">${esc(l.pax ?? '?')}</td>
    <td>${esc(l.visit_date || 'TBC')}</td>
    <td class="msg">${esc(l.interest || '')}</td>
  </tr>`).join('')}</tbody></table>`
  : `<div class="empty">No leads captured yet.</div>`}</div>

<h2>👥 Recent conversations</h2>
<div class="card">${contacts.length ? `<table>
  <thead><tr><th>Guest</th><th>Number</th><th>Email</th><th>Source</th><th>Mode</th><th>Last seen</th></tr></thead>
  <tbody>${contacts.map((c) => `<tr>
    <td>${name(c)}</td><td class="num">${esc(c.wa_id)}</td>
    <td class="num">${c.email ? esc(c.email) : '<span class="dim">–</span>'}</td>
    <td>${srcPill(c.source)}</td><td>${modePill(c)}</td>
    <td class="num">${when(c.last_seen_at)}</td>
  </tr>`).join('')}</tbody></table>`
  : `<div class="empty">No conversations yet — share the QR codes! 🌿</div>`}</div>

<h2>💬 Latest messages</h2>
<div class="card">${messages.length ? `<table>
  <thead><tr><th>When</th><th>Guest</th><th></th><th>From</th><th>Message</th></tr></thead>
  <tbody>${messages.map((m) => `<tr>
    <td class="num">${when(m.created_at)}</td>
    <td>${esc(m.profile_name || m.wa_id)}</td>
    <td class="${m.direction === 'in' ? 'in' : 'out'}">${m.direction === 'in' ? '⟶' : '⟵'}</td>
    <td>${esc(m.author)}</td>
    <td class="msg">${esc(m.body || '')}</td>
  </tr>`).join('')}</tbody></table>`
  : `<div class="empty">No messages yet.</div>`}</div>

</div></body></html>`;
}
