import express from 'express';
import { config } from './core/config.js';
import { verifySignature } from './whatsapp/client.js';
import { handleIncomingMessage, handleStaffEcho, sweepStaleHandovers } from './bot/router.js';
import { mountDashboard } from './web/dashboard.js';
import { pool } from './core/db.js';

const app = express();

// We need the RAW body to check Meta's signature, so capture it during parsing.
app.use(
  express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
    limit: '3mb',                      // Meta webhook payloads can reach 3 MB
  })
);

/* ───────── health check (for Render/Railway/uptime monitors) ───────── */
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, uptime: process.uptime() });
  } catch {
    res.status(503).json({ ok: false });
  }
});

/* ───────── 1. Webhook verification (Meta calls this once, with GET) ───────── */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.wa.verifyToken) {
    console.log('[webhook] verified by Meta ✅');
    return res.status(200).send(challenge);
  }
  console.warn('[webhook] verification failed — check VERIFY_TOKEN');
  return res.sendStatus(403);
});

/* ───────── 2. Incoming events (POST) ───────── */
app.post('/webhook', async (req, res) => {
  // Authenticate the caller:
  //  - meta: Meta signs every delivery with the App Secret (X-Hub-Signature-256)
  //  - d360: 360dialog sends the custom X-Valle-Token header we registered
  //    when setting the webhook (see set-webhook-d360.js)
  const authed = config.wa.provider === 'd360'
    ? req.get('x-valle-token') === config.wa.verifyToken
    : verifySignature(req.rawBody, req.get('x-hub-signature-256'));
  if (!authed) {
    console.warn('[webhook] unauthenticated delivery — rejected');
    return res.sendStatus(401);
  }

  // ACK FIRST. Meta needs a 200 within 5 seconds or it retries and disables you.
  // The AI call takes 1–4 s, so it must happen after this line.
  res.sendStatus(200);

  try {
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;

        // Delivery / read receipts and send errors
        if (value.statuses) {
          for (const s of value.statuses) {
            if (s.status === 'failed') {
              console.error('[status] failed', s.recipient_id, JSON.stringify(s.errors));
            }
          }
        }

        // Messages sent FROM the business number, echoed back to us. A message
        // typed by a colleague in the WhatsApp Business app pauses the bot for
        // that guest. Handled before inbound messages so a takeover always
        // wins the race against a reply the bot is about to send.
        const echoes = [...(value.message_echoes || []), ...(value.smb_message_echoes || [])];
        for (const echo of echoes) {
          const guest = echo?.to || echo?.recipient_id;
          enqueueForSender(guest, () => handleStaffEcho(echo));
        }

        // Actual inbound messages — serialized PER SENDER so rapid messages
        // from one guest are answered in order, never racing each other.
        for (const msg of value.messages || []) {
          const profile = value.contacts?.find((c) => c.wa_id === msg.from);
          enqueueForSender(msg.from, () => handleIncomingMessage(msg, profile));
        }
      }
    }
  } catch (err) {
    console.error('[webhook] processing error', err);
  }
});

/**
 * Per-sender processing queues. Messages from different guests still run in
 * parallel; messages from the SAME guest run strictly one after another, so
 * replies arrive in order and rapid-fire messages can't produce interleaved
 * or duplicate-looking answers.
 */
const senderQueues = new Map();
function enqueueForSender(from, job) {
  const prev = senderQueues.get(from) || Promise.resolve();
  const next = prev
    .then(job)
    .catch((err) => console.error('[handler] unhandled error', err));
  senderQueues.set(from, next);
  next.finally(() => {
    if (senderQueues.get(from) === next) senderQueues.delete(from);
  });
}

app.get('/', (_req, res) => res.send('Vallé WhatsApp bot is running 🌿'));

/* ───────── read-only web dashboard (see dashboard.js) ───────── */
mountDashboard(app);

const server = app.listen(config.port, () => {
  console.log(`🌿 Vallé WhatsApp bot listening on :${config.port} (${config.env})`);
  console.log(`   Model: ${config.ai.model}  ·  Graph: ${config.wa.version}`);
});

// Hand guests back to the bot if an agent goes quiet
setInterval(sweepStaleHandovers, 5 * 60 * 1000);

/* ───────── graceful shutdown ───────── */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`\n${sig} received, shutting down…`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
