/**
 * SMS — Twilio.
 *
 * One message, once: the moment a guest scans the ATM Dubai QR code and opens
 * the conversation, a short note about the park reaches their phone as a
 * text, whatever their country. It is a courtesy and a fallback, so it must
 * never delay or break the WhatsApp reply. Every failure is logged and
 * swallowed.
 *
 * Switched on purely by configuration: with no Twilio credentials in the
 * environment, smsEnabled() is false and not a single request is made.
 *
 * Twilio's REST API is a form POST with basic auth, so no SDK is needed.
 * One attempt per guest, deliberately: the API has no idempotency key, so a
 * retry after a timeout could text someone twice.
 * Delivery is reported back by Twilio to /twilio/status (mountSmsStatusWebhook)
 * and written into the guest's conversation, so the dashboard shows sent,
 * delivered or failed for every guest.
 */
import crypto from 'node:crypto';
import express from 'express';
import { config } from '../core/config.js';
import * as db from '../core/db.js';

const API = 'https://api.twilio.com/2010-04-01';
/** Twilio answers in well under a second; a hung request must not linger. */
const TIMEOUT_MS = 15_000;

/** True when Twilio is configured well enough to send. */
export const smsEnabled = () => config.sms.enabled !== false && Boolean(
  config.sms.accountSid && config.sms.authToken
  && (config.sms.from || config.sms.messagingServiceSid || config.sms.alphaSender)
);

/* ═══════════════════ WHO SENDS, PER COUNTRY ═══════════════════ */

/**
 * Countries whose operators show an unregistered alphanumeric sender such as
 * "Valle" as it is, per Twilio's per-country SMS guidelines on 12 Sept 2026:
 * Mauritius, Réunion, the UK, France, Germany, Italy, Ukraine, Bahrain, Egypt,
 * Pakistan and Kenya. France, Egypt and Kenya are here because their operators
 * do not deliver a foreign number at all; Pakistan and Kenya may swap the name
 * for a generic one on some networks. Everywhere else the guest sees the
 * number in TWILIO_FROM instead (India even rewrites that into a random short
 * number, which is normal there).
 */
const ALPHA_PREFIXES = ['230', '262', '44', '33', '49', '39', '380', '973', '20', '92', '254'];

/**
 * Countries not worth a text today: the operators only deliver sender IDs
 * registered weeks in advance (UAE, Saudi Arabia, Qatar, Kuwait), there is no
 * route (Russia), marketing SMS is blocked (Turkey, China), or an unregistered
 * number is blocked (USA and Canada). The guest still gets the WhatsApp reply, and the
 * dashboard shows why the text was skipped. SMS_SKIP_COUNTRIES (dial prefixes,
 * comma separated) replaces this list, e.g. drop 971 once the UAE sender ID
 * is registered; "none" skips nobody.
 */
const DEFAULT_SKIP = {
  971: 'UAE operators only deliver sender IDs registered weeks in advance',
  966: 'Saudi operators only deliver sender IDs registered weeks in advance',
  974: 'Qatar operators only deliver sender IDs registered weeks in advance',
  965: 'Kuwait: Ooredoo and Zain block unregistered senders from 15 Sept 2026, Viva rejects numbers',
  7: 'no SMS route to Russia',
  90: 'promotional SMS is blocked in Turkey',
  86: 'China does not allow marketing SMS or links from abroad',
  1: 'USA and Canada block unregistered numbers',
};

function skipList() {
  const raw = String(config.sms.skipCountries ?? '').trim();
  if (!raw) return DEFAULT_SKIP;
  if (raw.toLowerCase() === 'none') return {};
  return Object.fromEntries(raw.split(',').map((p) => p.trim().replace(/\D/g, '')).filter(Boolean)
    .map((p) => [p, DEFAULT_SKIP[p] || 'skipped by configuration (SMS_SKIP_COUNTRIES)']));
}

/**
 * Which sender a phone number gets: { skip: reason }, { messagingServiceSid },
 * { from: 'Valle' | '+1…' } or { none: what to configure }. A Messaging
 * Service, when set, decides for itself and overrides the alphanumeric rule
 * (that is where registered sender IDs will live later); the skip list is
 * honoured either way.
 */
export function senderFor(waId) {
  const digits = String(waId).replace(/\D/g, '');
  const skip = skipList();
  const hit = Object.keys(skip).sort((a, b) => b.length - a.length).find((p) => digits.startsWith(p));
  if (hit) return { skip: skip[hit] };
  if (config.sms.messagingServiceSid) return { messagingServiceSid: config.sms.messagingServiceSid };
  if (config.sms.alphaSender && ALPHA_PREFIXES.some((p) => digits.startsWith(p))) return { from: config.sms.alphaSender };
  if (config.sms.from) return { from: config.sms.from };
  return {
    none: config.sms.alphaSender
      ? 'this country does not accept an alphanumeric sender; set TWILIO_FROM to a Twilio number'
      : 'set TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID',
  };
}

/** A WhatsApp id is digits only; Twilio wants E.164. */
export const toE164 = (waId) => `+${String(waId).replace(/\D/g, '')}`;

/**
 * The welcome text message, sent once to every guest who scans the ATM Dubai
 * QR code. Plain Latin on purpose: one character outside the GSM alphabet
 * (a ™, an emoji) turns a 160 character SMS into a 70 character one and
 * triples what every scan costs. This fits in a single segment; the suite
 * checks that it stays there.
 */
export const WELCOME_SMS =
  'Vallé Advenature Park, Mauritius: thank you for scanning our QR at ATM Dubai 2026. '
  + 'Prices, activities and photos are waiting on WhatsApp. vallepark.com';

/** GSM-7 basic alphabet: one septet per character. */
const GSM_BASIC = /^[\r\n\f@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà]*$/;
/** GSM-7 extension table: each of these costs two septets (escape + character). */
const GSM_EXT = /[\^{}\\\[~\]|€]/g;

/**
 * How many SMS segments a text costs, the way Twilio bills it.
 *
 * GSM-7 text fits 160 septets in one segment and 153 per segment once split;
 * characters from the extension table (€ [ ] { } \ ^ ~ |) cost two. A single
 * character outside the alphabet (™, emoji, Arabic) turns the whole message
 * into UCS-2: 70 characters, 67 per segment once split. The welcome text is
 * written in plain Latin on purpose so every scan costs one segment.
 */
export function segments(body) {
  const text = String(body ?? '');
  if (GSM_BASIC.test(text.replace(GSM_EXT, ''))) {
    const septets = text.length + (text.match(GSM_EXT) || []).length;
    return septets <= 160 ? 1 : Math.ceil(septets / 153);
  }
  const units = text.length;                 // UTF-16 code units, as UCS-2 counts
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

/** Where Twilio reports delivery, when the bot has a public address. */
export const statusCallbackUrl = () =>
  (config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/twilio/status` : '');

/** What the team can do about the Twilio errors we expect to meet. */
const HINTS = {
  20003: 'Twilio refused the account: the credentials are wrong, or the KYC compliance profile in Trust Hub is not approved yet',
  21211: 'the number is not a valid phone number',
  21408: 'this country is not enabled for SMS: Twilio Console → Messaging → Settings → Geo permissions',
  21606: 'the From number cannot text this country; use a Messaging Service with a sender the country accepts',
  21610: 'the guest replied STOP earlier, so Twilio will not text them (their choice)',
  21612: 'no route from this sender to that country; add a sender the country accepts',
  21614: 'the number is not a mobile',
  30003: 'the phone is off or unreachable',
  30005: 'the number is unknown or no longer in service',
  30006: 'the number is a landline or cannot receive SMS',
  30007: 'the carrier filtered the message; register the sender ID for that country',
  30008: 'the carrier gave no reason',
  30018: 'this country wants a pre-registered sender ID, so delivery is not guaranteed; register "Valle" for it under Numbers and Senders → Alphanumeric senders',
  30040: 'blocked: this country only delivers pre-registered sender IDs; register "Valle" for it before texting there',
  30034: 'the sender is not registered for this destination (US A2P 10DLC or a sender-ID registration)',
};
export const smsHint = (code) => HINTS[Number(code)] || '';

/**
 * Send one SMS. Resolves to { ok: true, sid, status } when Twilio accepted it
 * (delivery itself is reported later through the status webhook), or to
 * { ok: false, code, message, hint } saying why not. Never throws: the
 * WhatsApp conversation matters more than the text message.
 */
export async function sendSms(waId, body) {
  if (!smsEnabled()) return { ok: false, code: 'disabled', message: 'Twilio is not configured', hint: '' };

  const to = toE164(waId);
  const sender = senderFor(to);
  if (sender.skip) {
    console.log(`[sms] skipped ${to}: ${sender.skip}`);
    return { ok: false, code: 'skipped', message: sender.skip, hint: sender.skip };
  }
  if (sender.none) {
    console.error(`[sms] no sender for ${to}: ${sender.none}`);
    return { ok: false, code: 'no-sender', message: sender.none, hint: sender.none };
  }
  const form = new URLSearchParams({ To: to, Body: body });
  if (sender.messagingServiceSid) form.set('MessagingServiceSid', sender.messagingServiceSid);
  else form.set('From', sender.from);
  const callback = statusCallbackUrl();
  if (callback) form.set('StatusCallback', callback);

  const auth = Buffer.from(`${config.sms.accountSid}:${config.sms.authToken}`).toString('base64');
  const n = segments(body);

  try {
    const res = await fetch(`${API}/Accounts/${config.sms.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const code = data.code || res.status;
      const hint = smsHint(code);
      // STOP, not a phone, a landline: the guest's side, not ours. 21408 (the
      // country is not enabled) stays loud on purpose.
      const quiet = code === 21610 || code === 21211 || code === 21614;
      console[quiet ? 'log' : 'error'](
        `[sms] not sent to ${to}: ${data.message || res.status} (${code})${hint ? ' — ' + hint : ''}`);
      return { ok: false, code, message: data.message || `HTTP ${res.status}`, hint };
    }
    console.log(`[sms] sent to ${to} (${n} segment${n > 1 ? 's' : ''}, sid ${data.sid}, ${data.status})`);
    return { ok: true, sid: data.sid, status: data.status };
  } catch (err) {
    const timedOut = err.name === 'TimeoutError';
    const message = timedOut ? `no answer from Twilio in ${TIMEOUT_MS / 1000} s` : err.message;
    console.error('[sms] failed', to, message);
    return { ok: false, code: timedOut ? 'timeout' : 'network', message, hint: '' };
  }
}

/* ═══════════════════ DELIVERY REPORTS FROM TWILIO ═══════════════════ */

/**
 * Twilio signs every callback: base64(HMAC-SHA1(auth token, url followed by
 * every POST field's name and value, sorted by name)). The URL must be the
 * one Twilio called, which is the one we gave it, so it is rebuilt from
 * configuration rather than trusted from the request.
 */
export function verifyTwilioSignature(url, params, signature) {
  if (!signature || !config.sms.authToken) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', config.sms.authToken).update(data, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * What Twilio tells us about a text we sent, written into the guest's
 * conversation so the dashboard shows it: "[sms: delivered]" or
 * "[sms: undelivered 30003 — the phone is off or unreachable]". The states in
 * between (queued, sending, sent) are noise and are ignored.
 */
export async function recordSmsStatus(params) {
  const status = String(params.MessageStatus || params.SmsStatus || '').toLowerCase();
  if (!['delivered', 'undelivered', 'failed'].includes(status)) return false;
  const waId = String(params.To || '').replace(/\D/g, '');
  const contact = waId ? await db.getContactByWaId(waId) : null;
  if (!contact) return false;
  const code = params.ErrorCode ? String(params.ErrorCode) : '';
  const hint = code ? smsHint(code) : '';
  const body = status === 'delivered'
    ? '[sms: delivered]'
    : `[sms: ${status}${code ? ' ' + code : ''}${hint ? ' — ' + hint : ''}]`;
  await db.logMessage({ contactId: contact.id, direction: 'out', author: 'system', body });
  console.log(`[sms] ${status} to +${waId}${code ? ' (' + code + ')' : ''}`);
  return true;
}

/**
 * The address Twilio reports delivery to. Rejects anything not signed with
 * our auth token, then answers 204 whatever happens next: Twilio retries on
 * errors, and a retry would not help.
 */
export function mountSmsStatusWebhook(app) {
  app.post('/twilio/status', express.urlencoded({ extended: false }), async (req, res) => {
    const url = statusCallbackUrl();
    if (!url || !verifyTwilioSignature(url, req.body || {}, req.get('x-twilio-signature'))) {
      console.warn('[sms] delivery report with a bad signature — rejected');
      return res.sendStatus(403);
    }
    try {
      await recordSmsStatus(req.body || {});
    } catch (err) {
      console.error('[sms] could not record a delivery report', err.message);
    }
    res.sendStatus(204);
  });
}
