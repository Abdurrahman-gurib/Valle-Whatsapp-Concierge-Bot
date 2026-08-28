/**
 * SMS — Twilio.
 *
 * One message, once: the moment a guest scans the ATM Dubai QR code and opens
 * the conversation, the same welcome reaches their phone as a text. It is a
 * courtesy and a fallback, so it must never delay or break the WhatsApp reply.
 * Every failure is logged and swallowed.
 *
 * Switched on purely by configuration: with no Twilio credentials in .env,
 * smsEnabled() is false and not a single request is made.
 *
 * Twilio's REST API is a form POST with basic auth, so no SDK is needed.
 */
import { config } from '../core/config.js';

const API = 'https://api.twilio.com/2010-04-01';

/** True when Twilio is configured well enough to send. */
export const smsEnabled = () => Boolean(
  config.sms.accountSid && config.sms.authToken
  && (config.sms.from || config.sms.messagingServiceSid)
);

/** A WhatsApp id is digits only; Twilio wants E.164. */
export const toE164 = (waId) => `+${String(waId).replace(/\D/g, '')}`;

/**
 * Keep the text inside one SMS segment where we can. Latin text gets 160
 * characters; a single character outside the GSM alphabet (™, emoji, Arabic)
 * drops the whole message to 70 and triples the cost, so the welcome text is
 * written in plain Latin on purpose.
 */
const GSM = /^[\r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;

export const segments = (body) => {
  const unicode = !GSM.test(body);
  const size = unicode ? 70 : 160;
  return Math.max(1, Math.ceil(body.length / size));
};

/**
 * Send one SMS. Returns true when Twilio accepted it.
 * Never throws: the WhatsApp conversation matters more than the text message.
 */
export async function sendSms(waId, body) {
  if (!smsEnabled()) return false;

  const to = toE164(waId);
  const form = new URLSearchParams({ To: to, Body: body });
  if (config.sms.messagingServiceSid) form.set('MessagingServiceSid', config.sms.messagingServiceSid);
  else form.set('From', config.sms.from);

  const auth = Buffer.from(`${config.sms.accountSid}:${config.sms.authToken}`).toString('base64');

  try {
    const res = await fetch(`${API}/Accounts/${config.sms.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // 21610 = the recipient replied STOP. Their choice, and not an error.
      const quiet = data.code === 21610 || data.code === 21211;
      console[quiet ? 'log' : 'error'](
        `[sms] not sent to ${to}: ${data.message || res.status} (${data.code || res.status})`);
      return false;
    }
    console.log(`[sms] sent to ${to} (${segments(body)} segment${segments(body) > 1 ? 's' : ''}, sid ${data.sid})`);
    return true;
  } catch (err) {
    console.error('[sms] failed', err.message);
    return false;
  }
}
