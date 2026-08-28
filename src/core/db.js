import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => console.error('[db] idle client error', err));

export const q = (text, params) => pool.query(text, params);

/* ─────────────── CONTACTS ─────────────── */

export async function getOrCreateContact(waId, profileName) {
  const { rows } = await q(
    `INSERT INTO contacts (wa_id, profile_name)
     VALUES ($1, $2)
     ON CONFLICT (wa_id) DO UPDATE
       SET last_seen_at = now(),
           profile_name = COALESCE(EXCLUDED.profile_name, contacts.profile_name)
     RETURNING *`,
    [waId, profileName || null]
  );
  return rows[0];
}

export async function getContactByWaId(waId) {
  const { rows } = await q(`SELECT * FROM contacts WHERE wa_id = $1`, [waId]);
  return rows[0] || null;
}

/**
 * Move a chat between bot / waiting / human / paused.
 *
 * Any move OUT of the waiting queue also lifts the silence a guest earned by
 * asking for a person: once a colleague picks the chat up (mode 'human') or
 * releases it (mode 'bot'), the flag has done its job.
 */
export async function setMode(waId, mode, claimedBy = null) {
  const { rows } = await q(
    `UPDATE contacts
        SET mode = $2,
            claimed_by = $3,
            claimed_at = CASE WHEN $2 = 'human' THEN now() ELSE NULL END,
            bot_silent = CASE WHEN $2 = 'waiting' THEN bot_silent ELSE false END
      WHERE wa_id = $1
      RETURNING *`,
    [waId, mode, claimedBy]
  );
  return rows[0];
}

/**
 * The guest asked, in their own words or by tapping "Talk to a person", to be
 * put through to someone. From now on the bot writes nothing in this chat: no
 * reply, no read receipt, no typing indicator. Cleared by setMode as soon as a
 * colleague takes the chat or releases it.
 */
export async function setBotSilent(waId, silent = true) {
  const { rows } = await q(
    `UPDATE contacts SET bot_silent = $2 WHERE wa_id = $1 RETURNING *`,
    [waId, silent]
  );
  return rows[0];
}

export async function setSource(waId, source) {
  await q(
    `UPDATE contacts SET source = COALESCE(source, $2) WHERE wa_id = $1`,
    [waId, source]
  );
}

export async function setLang(waId, lang) {
  await q(`UPDATE contacts SET lang = $2 WHERE wa_id = $1`, [waId, lang]);
}

/* ─────────────── SMS & EMAIL ─────────────── */

/**
 * What we asked the guest for and have not received yet ('email', or null once
 * they answer). Kept deliberately short lived: one unanswered question at a
 * time, cleared the moment they say anything else, so nobody gets stuck.
 */
export async function setAwaiting(waId, awaiting) {
  const { rows } = await q(
    `UPDATE contacts SET awaiting = $2 WHERE wa_id = $1 RETURNING *`,
    [waId, awaiting]
  );
  return rows[0];
}

/** Store the address the guest gave us and note that the overview went out. */
export async function setEmail(waId, email) {
  const { rows } = await q(
    `UPDATE contacts SET email = $2, awaiting = NULL WHERE wa_id = $1 RETURNING *`,
    [waId, email]
  );
  return rows[0];
}

export async function markEmailSent(waId) {
  await q(`UPDATE contacts SET email_at = now() WHERE wa_id = $1`, [waId]);
}

export async function markSmsSent(waId) {
  await q(`UPDATE contacts SET sms_at = now() WHERE wa_id = $1`, [waId]);
}

/** Has this exact internal marker already been logged for this contact? */
export async function hasLoggedMarker(contactId, marker) {
  const { rows } = await q(
    `SELECT 1 FROM messages WHERE contact_id = $1 AND body = $2 LIMIT 1`,
    [contactId, marker]
  );
  return rows.length > 0;
}

/** Every guest who gave us an address, newest first: the ATM Dubai mailing list. */
export async function listEmails(limit = 500) {
  const { rows } = await q(
    `SELECT wa_id, profile_name, email, email_at, source FROM contacts
      WHERE email IS NOT NULL ORDER BY email_at DESC NULLS LAST LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Chats waiting for a human, oldest first. */
export async function listWaiting(limit = 10) {
  const { rows } = await q(
    `SELECT * FROM contacts WHERE mode = 'waiting' ORDER BY last_seen_at ASC LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Waiting-queue chats whose "queued" marker is older than N minutes —
 * nobody claimed them in time, so the sweeper hands them back to the bot.
 */
export async function listStaleWaiting(minutes) {
  const { rows } = await q(
    `SELECT * FROM contacts
      WHERE mode = 'waiting'
        AND bot_silent = false
        AND last_seen_at < now() - ($1 || ' minutes')::interval`,
    [String(minutes)]
  );
  return rows;
}

/**
 * Queued chats the bot may still help with — i.e. everyone except the guests
 * who explicitly asked for a person. Used by the auto-release sweeper, which
 * must never put the bot back into a chat a guest reserved for a colleague.
 */
export async function listWaitingReleasable(limit = 100) {
  const { rows } = await q(
    `SELECT * FROM contacts
      WHERE mode = 'waiting' AND bot_silent = false
      ORDER BY last_seen_at ASC LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Human-handled chats where the agent has gone quiet — auto-release these. */
export async function listStaleHumanChats(minutes) {
  const { rows } = await q(
    `SELECT c.* FROM contacts c
      WHERE c.mode = 'human'
        AND c.claimed_at < now() - ($1 || ' minutes')::interval
        AND NOT EXISTS (
          SELECT 1 FROM messages m
           WHERE m.contact_id = c.id
             AND m.author = 'agent'
             AND m.created_at > now() - ($1 || ' minutes')::interval
        )`,
    [String(minutes)]
  );
  return rows;
}

/* ─────────────── MESSAGES ─────────────── */

/**
 * Returns false if this Meta message id was already stored (duplicate webhook).
 * Uses RETURNING rather than rowCount — unambiguous across drivers.
 */
export async function logMessage({
  contactId, waMessageId, direction, author, authorWaId, body, msgType = 'text',
}) {
  const { rows } = await q(
    `INSERT INTO messages (contact_id, wa_message_id, direction, author, author_wa_id, body, msg_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING id`,
    [contactId, waMessageId || null, direction, author, authorWaId || null, body, msgType]
  );
  return rows.length > 0;
}

/**
 * Was this WhatsApp message id sent BY US? Used to tell the bot's own echoes
 * apart from a colleague replying in the WhatsApp Business app.
 */
export async function hasOutboundMessage(waMessageId) {
  if (!waMessageId) return false;
  const { rows } = await q(
    `SELECT 1 FROM messages WHERE wa_message_id = $1 AND direction = 'out' LIMIT 1`,
    [waMessageId]
  );
  return rows.length > 0;
}

/**
 * Minutes since a colleague last wrote to this guest (from the app or the back
 * office). null when no colleague has ever written. Used to decide whether a
 * fresh QR scan may restart the concierge.
 */
export async function minutesSinceLastAgentMessage(contactId) {
  const { rows } = await q(
    `SELECT max(created_at) AS at FROM messages WHERE contact_id = $1 AND author = 'agent'`,
    [contactId]
  );
  const at = rows[0]?.at;
  if (!at) return null;
  return (Date.now() - new Date(at).getTime()) / 60000;
}

/**
 * Documents and photo sets this guest has already received, newest first.
 * Lets the assistant refer back to them instead of sending the same file twice.
 */
export async function listSentAssets(contactId) {
  const { rows } = await q(
    `SELECT DISTINCT body FROM messages
      WHERE contact_id = $1 AND direction = 'out' AND body LIKE '[%'
      ORDER BY body LIMIT 20`,
    [contactId]
  );
  return rows
    .map((r) => r.body.replace(/^\[|\]$/g, '').replace(/^menu\]?\s*/, '').trim())
    .filter((s) => /sent|photos|document|map/i.test(s));
}

/** The most recent booking details captured for this guest, if any. */
export async function getLatestLead(contactId) {
  const { rows } = await q(
    `SELECT full_name, pax, visit_date, interest FROM leads
      WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [contactId]
  );
  return rows[0] || null;
}

/** Recent turns for AI context, oldest-first. */
export async function getHistory(contactId, limit = 12) {
  const { rows } = await q(
    `SELECT author, body FROM messages
      WHERE contact_id = $1 AND body IS NOT NULL AND author <> 'system'
        AND body NOT LIKE '[%'
      ORDER BY created_at DESC LIMIT $2`,
    [contactId, limit]
  );
  return rows.reverse();
}

/* ─────────────── AGENTS ─────────────── */

export async function getAgent(waId) {
  const { rows } = await q(
    `SELECT * FROM agents WHERE wa_id = $1 AND active = true`,
    [waId]
  );
  return rows[0] || null;
}

export async function listActiveAgents() {
  const { rows } = await q(`SELECT * FROM agents WHERE active = true`);
  return rows;
}

export async function upsertAgent(waId, name, role = 'agent') {
  const { rows } = await q(
    `INSERT INTO agents (wa_id, name, role) VALUES ($1,$2,$3)
     ON CONFLICT (wa_id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = true
     RETURNING *`,
    [waId, name, role]
  );
  return rows[0];
}

export async function setAgentActiveChat(agentWaId, customerWaId) {
  await q(`UPDATE agents SET active_chat = $2 WHERE wa_id = $1`, [agentWaId, customerWaId]);
}

export async function touchAgentAlert(agentWaId) {
  await q(`UPDATE agents SET last_alert_at = now() WHERE wa_id = $1`, [agentWaId]);
}

/* ─────────────── NOTES / LEADS / SETTINGS ─────────────── */

export async function addNote(contactId, agentWaId, body) {
  await q(`INSERT INTO notes (contact_id, agent_wa_id, body) VALUES ($1,$2,$3)`,
    [contactId, agentWaId, body]);
}

export async function getNotes(contactId, limit = 5) {
  const { rows } = await q(
    `SELECT * FROM notes WHERE contact_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [contactId, limit]
  );
  return rows;
}

export async function saveLead(contactId, lead) {
  await q(
    `INSERT INTO leads (contact_id, full_name, pax, visit_date, interest, raw)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [contactId, lead.full_name || null, lead.pax || null, lead.visit_date || null,
     lead.interest || null, lead]
  );
}

export async function getSetting(key) {
  const { rows } = await q(`SELECT value FROM settings WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key, value) {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

/** Counters for the #stats command. */
export async function getStats() {
  const { rows } = await q(`
    SELECT
      (SELECT count(*) FROM contacts)                                        AS total_contacts,
      (SELECT count(*) FROM contacts WHERE last_seen_at > now() - interval '24 hours') AS active_24h,
      (SELECT count(*) FROM contacts WHERE mode = 'waiting')                 AS waiting,
      (SELECT count(*) FROM contacts WHERE mode = 'human')                   AS in_human,
      (SELECT count(*) FROM messages WHERE created_at > now() - interval '24 hours') AS msgs_24h,
      (SELECT count(*) FROM leads WHERE created_at > now() - interval '7 days')      AS leads_7d
  `);
  return rows[0];
}
