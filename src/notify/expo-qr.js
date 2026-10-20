/**
 * Forwards WhatsApp delivery receipts to Vallé Expo QR.
 *
 * The number has one webhook and it is this bot's, so Expo QR (which sends the
 * Expo passes, visit answers and reminders from the same number) only learns
 * that a message was delivered or read if we pass the `statuses` on. Expo QR
 * matches them by message id and ignores the bot's own messages.
 *
 * Fire-and-forget after the webhook is acknowledged: a slow or failing Expo QR
 * never delays or breaks the bot. Off unless both variables are set:
 *   EXPO_QR_STATUS_URL    https://api-production-a18a.up.railway.app/api/webhooks/whatsapp
 *   EXPO_QR_STATUS_TOKEN  the same value as WHATSAPP_STATUS_TOKEN on Expo QR
 */
const url = () => (process.env.EXPO_QR_STATUS_URL || '').trim();
const token = () => (process.env.EXPO_QR_STATUS_TOKEN || '').trim();

export const expoQrEnabled = () => Boolean(url() && token());

export function forwardStatuses(statuses) {
  if (!expoQrEnabled() || !Array.isArray(statuses) || statuses.length === 0) return Promise.resolve(false);
  return fetch(url(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Expo-Token': token() },
    body: JSON.stringify({ statuses }),
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => {
      if (!r.ok) console.warn('[expo-qr] receipts not accepted:', r.status);
      return r.ok;
    })
    .catch((err) => {
      console.warn('[expo-qr] receipts not forwarded:', err.message);
      return false;
    });
}
