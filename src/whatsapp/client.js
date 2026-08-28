import crypto from 'node:crypto';
import { config } from '../core/config.js';

const BASE = () =>
  `https://graph.facebook.com/${config.wa.version}/${config.wa.phoneNumberId}`;

// 360dialog's gateway mirrors the Cloud API: same payloads, different host + auth.
const D360_BASE = 'https://waba-v2.360dialog.io';

/**
 * Ids of messages THIS bot sent. WhatsApp echoes every message sent from the
 * business number back to the webhook, including our own; without this set the
 * bot would mistake its own replies for a staff member typing in the app and
 * pause itself. Bounded so it can never grow without limit.
 */
const ownOutboundIds = new Set();
const OWN_ID_LIMIT = 1000;

function rememberOwnOutbound(id) {
  if (!id) return;
  ownOutboundIds.add(id);
  if (ownOutboundIds.size > OWN_ID_LIMIT) {
    ownOutboundIds.delete(ownOutboundIds.values().next().value);
  }
}

/** True when this WhatsApp message id is one the bot itself sent. */
export const isOwnOutbound = (id) => Boolean(id) && ownOutboundIds.has(id);

async function callGraph(payload) {
  const d360 = config.wa.provider === 'd360';
  const res = await fetch(d360 ? `${D360_BASE}/messages` : `${BASE()}/messages`, {
    method: 'POST',
    headers: {
      ...(d360
        ? { 'D360-API-KEY': config.wa.d360ApiKey }
        : { Authorization: `Bearer ${config.wa.token}` }),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = data?.error || {};
    console.error('[whatsapp] send failed', res.status, err.code, err.message, err.error_data?.details || '');
    // 131047 / 131026 = outside the 24-hour window; caller may fall back to a template
    const e = new Error(err.message || `Graph API ${res.status}`);
    e.code = err.code;
    throw e;
  }
  // Remember what we sent, so its echo is never mistaken for a staff reply.
  for (const m of data?.messages || []) rememberOwnOutbound(m.id);
  return data;
}

/** Plain text. WhatsApp caps a text body at 4096 chars — we split rather than lose the tail. */
export async function sendText(to, body, { preview = false } = {}) {
  const chunks = splitForWhatsApp(String(body ?? '').trim() || '…');
  let last;
  for (const chunk of chunks) {
    last = await callGraph({
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: chunk, preview_url: preview },
    });
  }
  return last;
}

/** Up to 3 reply buttons. Titles max 20 chars. */
export async function sendButtons(to, bodyText, buttons, { header, footer } = {}) {
  return callGraph({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(header ? { header: { type: 'text', text: header.slice(0, 60) } } : {}),
      body: { text: bodyText.slice(0, 1024) },
      ...(footer ? { footer: { text: footer.slice(0, 60) } } : {}),
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

/**
 * A tap-to-open list menu. WhatsApp allows at most 10 rows in TOTAL across all
 * sections and rejects the whole message otherwise (error 131009), which would
 * leave the guest with no reply at all. Trim here so that can never happen.
 */
export async function sendList(to, { header, body, footer, buttonText, sections }) {
  const MAX_ROWS = 10;
  let budget = MAX_ROWS;
  const trimmed = [];
  for (const s of sections) {
    if (budget <= 0) break;
    const rows = s.rows.slice(0, budget);
    budget -= rows.length;
    if (rows.length) trimmed.push({ ...s, rows });
  }
  const dropped = sections.reduce((n, s) => n + s.rows.length, 0) - (MAX_ROWS - budget);
  if (dropped > 0) console.warn(`[whatsapp] list menu had too many rows, dropped ${dropped}`);
  sections = trimmed;

  return callGraph({
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(header ? { header: { type: 'text', text: header.slice(0, 60) } } : {}),
      body: { text: body.slice(0, 1024) },
      ...(footer ? { footer: { text: footer.slice(0, 60) } } : {}),
      action: {
        button: buttonText.slice(0, 20),
        sections: sections.map((s) => ({
          title: s.title.slice(0, 24),
          rows: s.rows.slice(0, 10).map((r) => ({
            id: r.id,
            title: r.title.slice(0, 24),
            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
          })),
        })),
      },
    },
  });
}

/** Template message — the ONLY thing deliverable outside the 24-hour window. */
export async function sendTemplate(to, name, lang = 'en', bodyParams = []) {
  return callGraph({
    to,
    type: 'template',
    template: {
      name,
      language: { code: lang },
      ...(bodyParams.length
        ? {
            components: [
              {
                type: 'body',
                parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })),
              },
            ],
          }
        : {}),
    },
  });
}

/** Send a document (PDF pricelist, etc.) by uploaded media id. */
export async function sendDocument(to, { id, filename, caption }) {
  return callGraph({
    recipient_type: 'individual',
    to,
    type: 'document',
    document: { id, filename, ...(caption ? { caption } : {}) },
  });
}

/** Send an image by media id or public link, with optional caption. */
export async function sendImage(to, { id, link, caption }) {
  return callGraph({
    recipient_type: 'individual',
    to,
    type: 'image',
    image: { ...(id ? { id } : { link }), ...(caption ? { caption } : {}) },
  });
}

/** Upload media (e.g. a generated voice note) and get a reusable media id. */
export async function uploadMedia(buffer, mime = 'audio/ogg') {
  const d360 = config.wa.provider === 'd360';
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mime }), 'voice.ogg');

  const res = await fetch(d360 ? `${D360_BASE}/media` : `${BASE()}/media`, {
    method: 'POST',
    headers: d360
      ? { 'D360-API-KEY': config.wa.d360ApiKey }
      : { Authorization: `Bearer ${config.wa.token}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new Error(`media upload ${res.status}`);
  return data.id;
}

/** Send an uploaded audio file — OGG/Opus renders as a WhatsApp voice note. */
export async function sendAudio(to, mediaId) {
  return callGraph({
    recipient_type: 'individual',
    to,
    type: 'audio',
    audio: { id: mediaId },
  });
}

/**
 * Download a media file (voice note, image...) sent by a customer.
 * Two-step on both providers: fetch the media URL by id, then the bytes.
 * 360dialog requires routing the CDN URL through their gateway.
 */
export async function downloadMedia(mediaId) {
  const d360 = config.wa.provider === 'd360';
  const authHeaders = d360
    ? { 'D360-API-KEY': config.wa.d360ApiKey }
    : { Authorization: `Bearer ${config.wa.token}` };

  const infoUrl = d360
    ? `${D360_BASE}/${mediaId}`
    : `https://graph.facebook.com/${config.wa.version}/${mediaId}`;
  const infoRes = await fetch(infoUrl, { headers: authHeaders });
  if (!infoRes.ok) throw new Error(`media info ${infoRes.status}`);
  const info = await infoRes.json();
  if (!info.url) throw new Error('media info has no url');

  // 360dialog: the returned lookaside.fbsbx.com URL must be fetched via their host.
  const fileUrl = d360
    ? info.url.replace(/^https:\/\/[^/]+/, D360_BASE)
    : info.url;
  const fileRes = await fetch(fileUrl, { headers: authHeaders });
  if (!fileRes.ok) throw new Error(`media download ${fileRes.status}`);

  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mime: info.mime_type || 'audio/ogg' };
}

/** Blue ticks for the customer — makes the bot feel alive while it thinks. */
export async function markAsRead(messageId) {
  try {
    await callGraph({ status: 'read', message_id: messageId });
  } catch {
    /* non-critical */
  }
}

/** Typing indicator (shown while the AI generates). Requires the message id being replied to. */
export async function sendTypingIndicator(messageId) {
  try {
    await callGraph({
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    });
  } catch {
    /* non-critical, older API versions ignore this */
  }
}

/**
 * Verifies X-Hub-Signature-256 so only Meta can post to your webhook.
 * Requires the RAW body bytes — see the express.json verify hook in server.js.
 */
export function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', config.wa.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** WhatsApp hard-limits text bodies at 4096 chars; split on paragraph boundaries. */
function splitForWhatsApp(text, limit = 3900) {
  if (text.length <= limit) return [text];
  const out = [];
  let buf = '';
  for (const para of text.split('\n')) {
    if ((buf + '\n' + para).length > limit) {
      if (buf) out.push(buf);
      buf = para.slice(0, limit);
    } else {
      buf = buf ? buf + '\n' + para : para;
    }
  }
  if (buf) out.push(buf);
  return out;
}
