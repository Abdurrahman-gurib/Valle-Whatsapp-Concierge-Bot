import * as db from '../core/db.js';
import { config, isBusinessHours } from '../core/config.js';
import { generateReply } from './ai.js';
import { handleAdminMessage } from './admin.js';
import { handleMenuMessage, sendMenuWelcome } from './menu-bot.js';
import { wantsHuman, needsHuman } from './handover-signals.js';
import { sendSms, smsEnabled } from '../notify/sms.js';
import { sendOverviewEmail, emailEnabled, findEmail } from '../notify/email.js';
import { sendGallery, hasImages } from './images.js';
import { sendDoc } from './documents.js';
import { transcribeAudio, synthesizeSpeech } from '../whatsapp/voice.js';
import {
  sendText, sendButtons, sendList, sendTemplate, markAsRead, sendTypingIndicator,
  downloadMedia, uploadMedia, sendAudio, isOwnOutbound,
} from '../whatsapp/client.js';

/**
 * THE ONE MESSAGE THAT ACTIVATES THE CONCIERGE.
 *
 * The ATM Dubai 2026 QR code opens WhatsApp with this text ready to send:
 *
 *   "Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to
 *    discover more about Vallé Advenature Park and the unforgettable
 *    experiences it offers in Mauritius."
 *
 * Nothing else switches the bot on. Every other conversation on this number —
 * walk-in enquiries, regular customers, partners, anyone typing "hi" — belongs
 * entirely to the sales and reservations team: the bot does not read it, does
 * not mark it as read and never replies in it.
 */
const QR_SOURCES = [
  { match: /\batm\s*dubai\b/i, tag: 'atm-dubai-2026' },
];

/** True when this message is one of the QR prefills (i.e. the guest just scanned). */
const isQrPrefillText = (text) => QR_SOURCES.some((s) => s.match.test((text || '').trim()));

/** Marks a chat taken over by a colleague working in the WhatsApp Business app. */
const APP_AGENT = 'app';

/* ═══════════════ THE SECOND AND THIRD CHANNELS ═══════════════ */

/**
 * The welcome text message.
 *
 * Plain Latin on purpose: one character outside the GSM alphabet (a ™, an
 * emoji) turns a 160 character SMS into a 70 character one and triples what
 * every scan costs. This fits in a single segment.
 */
const WELCOME_SMS =
  'Vallé Advenature Park: thanks for scanning our QR at ATM Dubai 2026. '
  + 'We have replied on WhatsApp with everything about the park. See you in Mauritius!';

/**
 * A guest who has just scanned gets the same welcome on their phone, once.
 *
 * Fire and forget, deliberately: Twilio is slower than WhatsApp and far less
 * important. The guest must never wait on it, and a Twilio outage must never
 * cost them their WhatsApp reply.
 */
function welcomeBySms(contact) {
  if (!smsEnabled() || !config.sms.enabled || contact.sms_at) return;
  sendSms(contact.wa_id, WELCOME_SMS)
    .then(async (ok) => {
      if (!ok) return;
      await db.markSmsSent(contact.wa_id);
      await db.logMessage({
        contactId: contact.id, direction: 'out', author: 'system', body: '[sms: welcome]',
      });
    })
    .catch((err) => console.error('[router] welcome SMS failed', err.message));
}

/** Ask the guest for the address to send the overview to. */
async function askForEmail(contact) {
  if (!emailEnabled()) return false;
  await sendText(contact.wa_id,
    `Of course 🌿 What is the best email address for you? ` +
    `I will send the full Vallé overview as a PDF, so you still have it after the show.`);
  await db.setAwaiting(contact.wa_id, 'email');
  await db.logMessage({
    contactId: contact.id, direction: 'out', author: 'system', body: '[email: asked]',
  });
  return true;
}

/**
 * The moment a guest scans the QR code and the welcome menu has gone out, ask
 * for their email so the overview lands in their inbox while they are still on
 * the stand. Asked once per guest. They can ignore it: the next message they
 * send is answered normally and the question is dropped (see handleEmailReply).
 */
async function inviteEmailAfterScan(contact) {
  if (!emailEnabled() || contact.email) return;
  if (await db.hasLoggedMarker(contact.id, '[email: offered]')) return;
  await sendText(contact.wa_id,
    `Would you like the full Vallé overview in your inbox as well? 📧 ` +
    `Just reply with your email address and I will send it straight away.`);
  await db.setAwaiting(contact.wa_id, 'email');
  contact.awaiting = 'email';
  await db.logMessage({
    contactId: contact.id, direction: 'out', author: 'system', body: '[email: offered]',
  });
}

/**
 * Offer the overview by email, once per guest and never again. Shown after we
 * hand over a document, which is the moment a guest is most likely to want a
 * copy they can keep.
 */
async function offerEmailOnce(contact) {
  if (!emailEnabled() || contact.email || contact.awaiting === 'email') return;
  if (await db.hasLoggedMarker(contact.id, '[email: offered]')) return;
  try {
    await sendButtons(contact.wa_id,
      `Would you like this by email as well, so you keep it after ATM Dubai? 📧`,
      [{ id: 'email_overview', title: '📧 Email it to me' }]);
    await db.logMessage({
      contactId: contact.id, direction: 'out', author: 'system', body: '[email: offered]',
    });
  } catch (err) {
    console.error('[router] could not offer email', err.message);
  }
}

/**
 * The guest is answering our question about their address, or has volunteered
 * one mid-conversation. Returns true when this message was about email and
 * needs no further routing.
 *
 * Nobody is ever trapped here: if we asked for an address and the guest writes
 * something else, the question is dropped and their message is answered
 * normally. That was the lesson of the waiting queue.
 */
async function handleEmailReply(contact, text) {
  const address = findEmail(text);
  const asked = contact.awaiting === 'email';

  if (!address) {
    if (!asked) return false;
    // They were asked, and answered with something that is not an address.
    if (/@/.test(text)) {
      await sendText(contact.wa_id,
        `That address does not look quite right to me 🙈 Could you send it again, ` +
        `for example marie@example.com? Or just carry on and ask me anything.`);
      return true;
    }
    // Not an attempt at all: drop the question and let them get on with it.
    await db.setAwaiting(contact.wa_id, null);
    contact.awaiting = null;
    return false;
  }

  if (!emailEnabled()) return false;

  await db.setEmail(contact.wa_id, address);
  contact.email = address;
  contact.awaiting = null;

  const sent = await sendOverviewEmail({ to: address, name: contact.profile_name });
  if (sent) {
    await db.markEmailSent(contact.wa_id);
    await sendText(contact.wa_id,
      `Sent 📧 The full Vallé overview is on its way to *${address}*. ` +
      `Do check your spam folder if it is not there in a minute. ` +
      `Anything else you would like to know about the park? 🌿`);
    await db.logMessage({
      contactId: contact.id, direction: 'out', author: 'system', body: `[email: sent to ${address}]`,
    });
    await broadcastToAgents(
      `📧 *Email captured*\n\n` +
      `*${contact.profile_name || 'Guest'}* — ${contact.wa_id}\n` +
      `${address}\n` +
      `${contact.source ? `Via: ${contact.source}` : ''}`);
  } else {
    await sendText(contact.wa_id,
      `Thank you! I have noted *${address}* and a colleague will send the overview across. 🌿`);
    await db.logMessage({
      contactId: contact.id, direction: 'out', author: 'system', body: `[email: capture failed ${address}]`,
    });
  }
  return true;
}

/** A typed request for the overview by email, in the languages we meet. */
const ASKS_BY_EMAIL = /\b(e-?mail|mail it|by mail|inbox)\b|courriel|par mail|correo|e-?post|почт|بريد|邮箱|メール/i;

/* ═══════════════ STAFF REPLIES FROM THE WHATSAPP APP ═══════════════ */

/**
 * WhatsApp echoes every message sent from the business number back to the
 * webhook. When that message was typed by a colleague in the WhatsApp Business
 * app (coexistence), the bot must immediately step aside for that guest: no
 * reading, no typing indicator, no replies, until someone releases the chat
 * with #release in the back office.
 *
 * Echoes of the bot's own API messages are ignored, otherwise it would pause
 * itself after every reply it sends.
 */
export async function handleStaffEcho(echo) {
  const guest = echo?.to || echo?.recipient_id;
  const echoId = echo?.id;
  if (!guest) return;

  // Our own outbound message coming back to us: ignore.
  if (isOwnOutbound(echoId) || (echoId && await db.hasOutboundMessage(echoId))) return;

  const contact = await db.getContactByWaId(guest);
  if (!contact) return;                       // never a guest of ours

  const body = echo?.text?.body || `[${echo?.type || 'message'} from the team]`;

  if (contact.mode !== 'human') {
    await db.setMode(guest, 'human', APP_AGENT);
    console.log('[router] a colleague replied from the WhatsApp app — bot paused for', guest);
  }

  await db.logMessage({
    contactId: contact.id,
    waMessageId: echoId,
    direction: 'out',
    author: 'agent',
    authorWaId: APP_AGENT,
    body,
  });
}

/**
 * Re-read the chat before sending anything. Generating an AI answer or
 * transcribing a voice note takes seconds, and a colleague may have replied in
 * that window: the bot must then drop its answer instead of double-messaging
 * the guest.
 */
async function botStillOwns(contact) {
  const fresh = await db.getContactByWaId(contact.wa_id);
  if (!fresh || fresh.mode === 'human' || fresh.mode === 'paused' || fresh.bot_silent) {
    console.log('[router] chat handed to a colleague mid-reply, dropping bot answer for', contact.wa_id);
    return false;
  }
  return true;
}

/**
 * True when we already told this guest exactly this, recently. Looks back far
 * enough to cover a conversation that continued while they waited, so a
 * reassurance is never repeated message after message.
 */
async function alreadyToldThem(contact, body) {
  const recent = await db.getHistory(contact.id, 25);
  return recent.some((m) => m.author === 'bot' && m.body === body);
}

/* ═══════════════════════ ENTRY POINT ═══════════════════════ */

export async function handleIncomingMessage(msg, contactProfile) {
  const from = msg.from;                       // customer or agent wa_id
  const waMessageId = msg.id;
  // Coexistence occasionally delivers a message with no sender (seen once on
  // 28 Aug: a contact card with a name and no number). Nothing to answer.
  if (!from) {
    console.warn('[router] message without a sender ignored:', msg.type, waMessageId);
    return;
  }
  const profileName = contactProfile?.profile?.name;

  const text = extractText(msg);

  /* ---- 1. Is the sender staff? Then it's a back-office command ---- */
  const agent = await resolveAgent(from);
  if (agent) {
    markAsRead(waMessageId).catch(() => {});
    await handleAdminMessage({ agent, text, from });
    return;
  }

  /* ---- 2. Normal guest ---- */
  const contact = await db.getOrCreateContact(from, profileName);

  const isNew = await db.logMessage({
    contactId: contact.id,
    waMessageId,
    direction: 'in',
    author: 'customer',
    body: text,
    msgType: msg.type,
  });
  // Meta retries webhooks; without this a retry would answer the guest twice.
  if (!isNew) return;

  // Tag which QR they came from — the first message that matches a QR
  // prefill unlocks the bot for this contact, permanently.
  const hadSource = Boolean(contact.source);
  const source = await tagSource(contact, text);

  /* ---- 2b. QR-ONLY GATE — absolute ---- */
  // The bot exists only for guests who arrived through a Vallé QR code.
  // For anyone else it does NOTHING AT ALL: no read receipt, no typing
  // indicator, no reply, whatever mode the chat is in. The message is still
  // stored so the team can see it in the back office and the dashboard.
  if (config.bot.qrOnly && !source) {
    console.log('[router] silent — no QR code for this contact:', from);
    return;
  }

  // A fresh scan reaches them on both channels: the WhatsApp reply they are
  // already reading, and the same welcome as a text message on their phone.
  if (!hadSource && source) welcomeBySms(contact);

  /* ---- 2c. A fresh QR scan restarts the concierge ---- */
  // A guest who scans a Vallé code is explicitly asking for the assistant. If a
  // colleague handled this chat earlier but has been quiet for a while, the scan
  // opens a new concierge session. If a colleague is mid-conversation right now,
  // the scan changes nothing: the person keeps the chat.
  if (contact.mode === 'human' && isQrPrefillText(text)) {
    const quietFor = await db.minutesSinceLastAgentMessage(contact.id);
    if (quietFor === null || quietFor >= config.bot.qrReactivateMinutes) {
      await db.setMode(from, 'bot');
      contact.mode = 'bot';
      console.log(`[router] QR scanned after ${quietFor ?? '∞'} min of team silence — concierge resumed for`, from);
    }
  }

  /* ---- 3a. THE GUEST ASKED FOR A PERSON — total silence ---- */
  // Set when they tap "Talk to a person" or ask for an agent in any language,
  // and by #mute in the back office. The team has been alerted and the chat is
  // in #queue; the bot does not read it, does not type, does not reply. It comes
  // back only when a colleague answers (mode 'human') or releases it (#release).
  if (contact.bot_silent || contact.mode === 'paused') {
    console.log('[router] silent — this chat is reserved for a colleague:', from);
    return;
  }

  /* ---- 3. A HUMAN OWNS THIS CHAT — total silence ---- */
  // Set either by #claim in the back office, or automatically the moment a
  // colleague answers this guest from the WhatsApp Business app (see
  // handleStaffEcho). The bot does not read, does not type, does not reply.
  if (contact.mode === 'human') {
    // Relay to the colleague who claimed from the back office, so they see the
    // guest in their own WhatsApp. Never for an app takeover: that colleague is
    // already reading the conversation in the app, a relay would double it.
    if (contact.claimed_by && contact.claimed_by !== APP_AGENT) {
      await notifyClaimingAgent(contact, text);
    }
    console.log('[router] silent — a colleague is handling', from);
    return;
  }

  // From here on the bot is answering this guest, so read receipts are honest.
  markAsRead(waMessageId).catch(() => {});

  /* ---- 4. Waiting for a colleague, but nobody has replied yet ---- */
  // The guest asked for something a person must handle, so the team has been
  // alerted. That must NOT leave them stranded: while they wait, the concierge
  // keeps answering everything it can (menus, photos, prices, PDFs). It only
  // falls silent once a colleague actually replies (mode 'human', step 3).
  // The queue reassurance is sent once and never repeated.
  if (contact.mode === 'waiting' && !contact.bot_silent) {
    const notice = isBusinessHours()
      ? `Thanks, you're in the queue and a colleague will be with you shortly. 🙏`
      : `Thanks! We're closed right now (open daily 09:00–17:30). A colleague will reply first thing. 🌙`;
    if (!(await alreadyToldThem(contact, notice))) {
      await sendText(from, notice);
      await db.logMessage({ contactId: contact.id, direction: 'out', author: 'bot', body: notice });
    }
    // fall through: keep helping with whatever else they ask
  }

  /* ---- 5. Bot muted for this guest, or globally off ---- */
  const globallyOn = (await db.getSetting('bot_enabled')) !== 'false';
  if (!globallyOn) {
    await queueForHuman(contact, 'Bot switched off — manual handling', text);
    return;
  }

  /* ---- 5a. An email address, asked for or volunteered ---- */
  // Checked before everything else: "marie@gmail.com" is not a question about
  // the park, and a guest answering our question must not be routed elsewhere.
  if (text && await handleEmailReply(contact, text)) return;

  /* ---- 5b. Voice notes: transcribe, then answer in the guest's language ---- */
  if (!text && (msg.type === 'audio' || msg.type === 'voice')) {
    await handleVoiceNote(contact, msg, profileName, waMessageId);
    return;
  }

  /* ---- 5c. Photos: the AI looks at them and reacts ---- */
  if (!text && msg.type === 'image' && msg.image?.id && config.bot.mode !== 'menu') {
    try {
      const { buffer, mime } = await downloadMedia(msg.image.id);
      await db.logMessage({
        contactId: contact.id, direction: 'in', author: 'system', body: '[photo received]',
      });
      await respondWithAI(contact, msg.image.caption || '', profileName, waMessageId, {
        image: { data: buffer.toString('base64'), media_type: (mime || 'image/jpeg').split(';')[0] },
      });
      return;
    } catch (err) {
      console.error('[router] photo handling failed', err.message);
    }
  }

  /* ---- 5d. Other non-text media: acknowledge, don't try to interpret ---- */
  if (!text) {
    await sendText(from,
      `Thanks! 📎 I can't open attachments yet, but I've flagged this for the team. ` +
      `Could you describe it in a message, or type *agent* to reach a person?`);
    return;
  }

  /* ---- 6. Route what the guest said (typed, tapped or spoken) ---- */
  await routeGuestText(contact, text, profileName, waMessageId, { firstScan: !hadSource && source });
}

/**
 * One path for everything a guest says, whether they typed it, tapped a menu
 * row or spoke it into a voice note. Keeping a single route means a spoken
 * "send me the pricelist" behaves exactly like the written one.
 */
async function routeGuestText(contact, text, profileName, waMessageId, { firstScan = false, voiceReply = false } = {}) {
  if (config.bot.mode === 'menu' || config.bot.mode === 'hybrid') {
    // A QR prefill always opens with the welcome menu, first scan or re-scan,
    // and must never be mistaken for a booking enquiry.
    if (firstScan || isQrPrefillText(text)) {
      await sendMenuWelcome(contact);
      await inviteEmailAfterScan(contact);
      return;
    }
    if (wantsHuman(text)) {
      await queueForHuman(contact, 'Guest asked to speak to a person', text, { guestAsked: true });
      return;
    }
    if (needsHuman(text)) {
      await queueForHuman(contact, 'Booking change / complaint — needs a person', text);
      return;
    }
    // "Email it to me", or the button under a document we just sent.
    if (text === 'email_overview' || (emailEnabled() && ASKS_BY_EMAIL.test(text))) {
      if (await askForEmail(contact)) return;
    }
    const menuOnly = config.bot.mode === 'menu';
    const outcome = await handleMenuMessage(contact, text, {
      handleFreeText: menuOnly,
      handlePhotoRequests: menuOnly,
      // In hybrid mode the canned topic cards stay out of the way: a guest who
      // writes in their own words gets a real answer from the assistant, which
      // reads the question in context instead of matching a keyword.
      topicCards: menuOnly,
    });
    if (outcome === 'human') {
      await queueForHuman(contact, 'Guest tapped "Talk to a person"', text, { guestAsked: true });
    } else if (outcome === 'lead') {
      await queueForHuman(contact, 'Menu bot — enquiry/booking to confirm', text, { silent: true });
    } else if (outcome === 'unhandled') {
      await respondWithAI(contact, text, profileName, waMessageId, { voiceReply });
    }
    return;
  }

  /* AI mode: shortcuts, then handover keywords, then the AI. */
  if (await handleShortcut(contact, text)) return;
  if (text === 'email_overview' || (emailEnabled() && ASKS_BY_EMAIL.test(text))) {
    if (await askForEmail(contact)) return;
  }
  if (wantsHuman(text)) {
    await queueForHuman(contact, 'Guest asked to speak to a person', text, { guestAsked: true });
    return;
  }
  if (needsHuman(text)) {
    await queueForHuman(contact, 'Booking change / complaint — needs a person', text);
    return;
  }
  await respondWithAI(contact, text, profileName, waMessageId, { voiceReply });
}

/* ═══════════════════════ AI PATH ═══════════════════════ */

async function respondWithAI(contact, text, profileName, waMessageId, { voiceReply = false, image = null } = {}) {
  sendTypingIndicator(waMessageId).catch(() => {});

  let result;
  let history = [];
  try {
    // A real conversation, not a lookup: the assistant sees what was said, what
    // the guest already received, and what we know about their visit.
    const [turns, alreadySent, lead] = await Promise.all([
      db.getHistory(contact.id, 20),
      db.listSentAssets(contact.id),
      db.getLatestLead(contact.id),
    ]);
    history = turns;
    result = await generateReply({
      history: image ? history : history.slice(0, -1), // last row is the message we're answering
      userText: text,
      profileName,
      source: contact.source,
      image,
      alreadySent,
      lead,
    });
  } catch (err) {
    console.error('[router] AI error', err);
    await sendText(contact.wa_id,
      `Sorry, I'm having a technical moment. 😅 A colleague will pick this up.`);
    await queueForHuman(contact, 'AI error — needs a human', text, { silent: true });
    return;
  }

  // A colleague may have answered while the AI was thinking: never double-message.
  if (!(await botStillOwns(contact))) return;

  if (result.reply) {
    // Guest spoke to us → speak back (same language), then send the text too
    // so prices and details stay readable. TTS failures fall back to text only.
    if (voiceReply) {
      try {
        const audio = await synthesizeSpeech(result.reply);
        if (audio) {
          const mediaId = await uploadMedia(audio, 'audio/ogg');
          await sendAudio(contact.wa_id, mediaId);
          await db.logMessage({
            contactId: contact.id, direction: 'out', author: 'bot', body: '[voice reply]',
          });
        }
      } catch (err) {
        console.error('[router] voice reply failed', err.message);
      }
    }
    await sendText(contact.wa_id, result.reply);
    await db.logMessage({
      contactId: contact.id, direction: 'out', author: 'bot', body: result.reply,
    });
  }

  // Photos, the map or a PDF the guest asked for, in whatever language.
  // If the reply promised something but no control line came with it, keep the
  // promise anyway: a guest told "here are some photos" must get photos.
  const toSend = result.send?.length
    ? correctPhotoTopic(result.send, text, history)
    : promisedAssets(result.reply, text, history);
  if (toSend.length) {
    if (!result.send?.length) console.log('[router] keeping a promise the reply made:', toSend.join(', '));
    await deliverAssets(contact, toSend);
  }

  if (result.lead) {
    await db.saveLead(contact.id, result.lead);
    await broadcastToAgents(
      `🎟 *New booking request*\n` +
      `${result.lead.full_name || contact.profile_name || contact.wa_id}\n` +
      `${result.lead.pax || '?'} pax · ${result.lead.visit_date || 'date TBC'}\n` +
      `${result.lead.interest || ''}\n\n` +
      `*#claim ${contact.wa_id}* to take it.`
    );
  }

  // The guest wants it in their inbox: ask for the address, the system sends it.
  if (result.askEmail && emailEnabled() && !contact.email) {
    await askForEmail(contact);
  }

  if (result.handover) {
    // ::HUMAN: means the guest asked for a person, so the bot stops here.
    // ::HANDOVER: is the assistant's own call, and it keeps helping meanwhile.
    await queueForHuman(contact, result.handover, text, {
      silent: true, guestAsked: Boolean(result.guestAsked),
    });
  }
}

/* ═══════════════════════ VOICE NOTES ═══════════════════════ */

/**
 * Download the voice note, transcribe it (any language), and answer it the same
 * way a typed message would be answered. Without a transcription key (or on
 * failure), the guest gets a polite reply and the note goes to the team, who
 * can listen to it in the WhatsApp app.
 */
async function handleVoiceNote(contact, msg, profileName, waMessageId) {
  const media = msg.audio || msg.voice;
  let transcript = null;

  try {
    if (media?.id) {
      const { buffer, mime } = await downloadMedia(media.id);
      transcript = await transcribeAudio(buffer, mime || media.mime_type);
    }
  } catch (err) {
    console.error('[voice] transcription failed', err.message);
  }

  // Transcription takes seconds: check nobody stepped in meanwhile.
  if (!(await botStillOwns(contact))) return;

  if (transcript && transcript.trim()) {
    await db.logMessage({
      contactId: contact.id, direction: 'in', author: 'system',
      body: `[voice transcript] ${transcript.slice(0, 500)}`,
    });

    // A spoken message is treated exactly like a written one: the same menus,
    // the same photo and PDF shortcuts, the same AI — only the reply also comes
    // back as a voice note.
    await routeGuestText(contact, transcript.trim(), profileName, waMessageId, { voiceReply: true });
    return;
  }

  // No transcription available: acknowledge warmly, hand the note to the team.
  await sendText(contact.wa_id,
    `🎙 Thank you for your voice message! A colleague will listen and reply to you ` +
    `right here shortly. You can also type your question for an instant answer.`);
  await queueForHuman(contact, 'Voice note needs a human ear', '[voice note]', { silent: true });
}

/* ═══════════════════ ATTACHMENTS THE AI CAN SEND ═══════════════════ */

/** Which photo set a promise like "photos of the bridge" refers to. */
// Order matters: "quad bike" is a QUAD, so quad is tested before bicycle.
const PHOTO_TOPIC_WORDS = [
  [/\bquad/i, 'quad'], [/\bbuggy|buggies/i, 'buggy'],
  [/\bzip ?lines?\b|tyrolienne|sky pulse|advenature flight/i, 'ziplines'],
  [/\bbicycle|cycl|\bbike\b/i, 'bicycle'],
  [/\bbridge|nepal/i, 'bridge'],
  [/\bluge|kart/i, 'luge'], [/\bpeak\b/i, 'peak'], [/expedition|explorer/i, 'expedition'],
  [/waterfall|cascade/i, 'waterfalls'], [/animal|tortoise|deer|wildlife/i, 'animals'],
  [/kids?|child|family/i, 'kids'], [/restaurant|dining|chamouz|bigarade/i, 'dining'],
  [/coloured earth|nature|forest/i, 'nature'], [/story|history|timeline/i, 'history'],
];

/** Which activity a sentence is about, or null when it names none. */
function topicOf(text) {
  const hit = PHOTO_TOPIC_WORDS.find(([re]) => re.test(text || ''));
  return hit ? hit[1] : null;
}

/**
 * What the conversation is about right now.
 *
 * "Do you have pictures?" means pictures OF THE THING WE WERE JUST DISCUSSING.
 * The guest's own words win; failing that, walk back through what they said and
 * what we answered, newest first, and take the first activity named.
 */
function currentTopic(userText, history = []) {
  const own = topicOf(userText);
  if (own) return own;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = topicOf(history[i]?.body);
    if (t) return t;
  }
  return null;
}

/** Is the guest asking to SEE something, in any language? */
const ASKS_FOR_PHOTOS = /\b(photos?|pictures?|images?|gallery|pics?)\b|\bfotos?\b|bilder|im[aá]gen|imagem|фото|صور|照片|写真|तस्वीर|zdj[eę]ci/i;

/** ...unless what they actually want is a file. Then photos are not the answer. */
const ASKS_FOR_A_FILE = /price ?list|pricelist|brochure|tarif|preisliste|\bpdf\b|\bmenus?\b|\bmap\b|plan du parc|presentation|magazine|factsheet/i;

/**
 * A promise the guest can read must always be kept. If the assistant writes
 * "here are some photos" but forgets the control line, the guest would receive
 * nothing at all, so work out what was promised and send it anyway.
 *
 * Two things this must NOT do, both learned the hard way:
 *   · fire on a PAST reference ("I sent you those earlier") — that is not a promise;
 *   · take the subject from the reply's closing offer ("want the zipline photos
 *     too?") when the guest asked about the buggy. The guest's question decides
 *     the subject, never a suggestion we made afterwards.
 */
function promisedAssets(reply, userText = '', history = []) {
  const t = (reply || '').toLowerCase();
  const promising = /(here (are|is)|i'?ll send|i am sending|sending you|let me send|voici|je vous envoie|attaching|hier sind|aqu[ií] (est[aá]n|tienes))/i.test(t);
  const asked = ASKS_FOR_PHOTOS.test(userText || '') && !ASKS_FOR_A_FILE.test(userText || '');
  if (!promising && !asked) return [];

  const tokens = [];
  // The guest asked to see something, or we said we were sending photos.
  if (asked || (promising && /\bphotos?\b|\bpictures?\b|\bimages?\b/i.test(t))) {
    tokens.push(`photos:${currentTopic(userText, history) || topicOf(t) || 'park'}`);
  }
  if (!promising) return tokens.slice(0, 2);

  if (/price ?list|brochure|tarif/i.test(t)) tokens.push('brochure');
  if (/\bmenus?\b/i.test(t) && /restaurant|chamouz|bigarade|carte/i.test(t)) tokens.push('menus');
  if (/\bmap\b|plan du parc/i.test(t)) tokens.push('map');
  if (/presentation|pr[ée]sentation/i.test(t)) tokens.push('presentation');
  return tokens.slice(0, 2);
}

/**
 * The guest names the subject, not us. If they asked about the buggy and the
 * control line says photos of something else, the guest's word wins: they asked
 * for buggy pictures and buggy pictures are what they get.
 *
 * A bare "photos" with no topic is filled in from the conversation, so "do you
 * have pictures?" after a buggy question sends buggy pictures.
 */
function correctPhotoTopic(tokens, userText, history) {
  const wanted = currentTopic(userText, history);
  if (!wanted) return tokens;
  return tokens.map((tok) => {
    if (!/^photos?(:|$)/i.test(tok.trim())) return tok;
    const named = tok.split(':')[1]?.trim();
    if (named && named === wanted) return tok;
    // Only override when the guest's own message names the subject, or when the
    // control line left it blank. A topic we inferred from older turns must not
    // overrule a deliberate choice by the assistant.
    if (!named || topicOf(userText)) {
      if (named !== wanted) console.log(`[router] photo topic corrected: ${named || 'none'} → ${wanted}`);
      return `photos:${wanted}`;
    }
    return tok;
  });
}

/** Words the AI may use in ::SEND: mapped to the document library. */
const SEND_DOCS = {
  brochure: 'brochure', pricelist: 'brochure',
  magazine: 'profile', profile: 'profile',
  presentation: 'presentation',
  factsheet: 'factsheet',
  pricelist: 'brochure',
  resident: 'pricelist_resident',
  student: 'pkg_student',
  senior: 'pkg_senior',
  kidspark: 'kidspark',
  // The two set menus that come with a package.
  explorers: 'menu_explorers',
  adventurers: 'menu_adventurers',
};

/**
 * Deliver what the AI decided to attach: park photos, the trail map or a PDF.
 * Never lets a failed attachment break the text answer the guest already has.
 */
async function deliverAssets(contact, tokens) {
  let sentDocument = false;
  for (const token of tokens) {
    try {
      if (token.startsWith('photos')) {
        const topic = token.includes(':') ? token.split(':')[1].trim() : 'park';
        await sendGallery(contact.wa_id, hasImages(topic) ? topic : 'park', 3);
        await db.logMessage({ contactId: contact.id, direction: 'out', author: 'bot',
          body: `[photos sent: ${topic}]` });
      } else if (token === 'map') {
        await sendGallery(contact.wa_id, 'map', 1);
        await db.logMessage({ contactId: contact.id, direction: 'out', author: 'bot',
          body: '[park map sent]' });
      } else if (token === 'menus') {
        await sendDoc(contact.wa_id, 'menu_chamouze');
        await sendDoc(contact.wa_id, 'menu_bigarade');
        await db.logMessage({ contactId: contact.id, direction: 'out', author: 'bot',
          body: '[restaurant menus sent]' });
      } else if (token === 'packages') {
        for (const key of ['pkg_exclusive', 'pkg_vip', 'pkg_diamond']) {
          await sendDoc(contact.wa_id, key);
        }
        await db.logMessage({ contactId: contact.id, direction: 'out', author: 'bot',
          body: '[package PDFs sent]' });
      } else if (SEND_DOCS[token]) {
        await sendDoc(contact.wa_id, SEND_DOCS[token]);
        await db.logMessage({ contactId: contact.id, direction: 'out', author: 'bot',
          body: `[document sent: ${token}]` });
        sentDocument = true;
      }
    } catch (err) {
      console.error('[router] could not send attachment', token, err.message);
    }
  }
  // A guest holding a PDF on their phone is the right moment to ask whether
  // they want it in their inbox as well. Offered once, then never again.
  if (sentDocument) await offerEmailOnce(contact);
}

/* ═══════════════════════ HANDOVER ═══════════════════════ */

/**
 * Put a guest in the queue and ping every active agent on their own WhatsApp.
 * @param silent  true when the AI already told the guest someone is coming
 */
async function queueForHuman(contact, reason, lastText, { silent = false, guestAsked = false } = {}) {
  // Already queued? Then the team knows and the guest has been told. Don't
  // repeat either: just note the new reason.
  const alreadyWaiting = contact.mode === 'waiting';
  await db.setMode(contact.wa_id, 'waiting');
  contact.mode = 'waiting';

  // A guest who asked for a person gets a person. The chat stays in the queue so
  // the team sees it in #queue, but the bot says nothing more here until a
  // colleague replies or releases it. When the BOT decided to escalate, it keeps
  // helping with everything else meanwhile.
  if (guestAsked && !contact.bot_silent) {
    await db.setBotSilent(contact.wa_id, true);
    contact.bot_silent = true;
  }

  if (alreadyWaiting && !guestAsked) {
    await db.logMessage({
      contactId: contact.id, direction: 'out', author: 'system',
      body: `[already queued: ${reason}]`,
    });
    return;
  }

  if (!silent) {
    await sendText(contact.wa_id, isBusinessHours()
      ? `Of course — let me get a colleague for you. One moment. 🙋`
      : `Of course! We're closed right now (daily 09:00–17:30), but a colleague will reply as soon as we open. 🌙`);
  }

  await db.logMessage({
    contactId: contact.id, direction: 'out', author: 'system',
    body: `[queued for human: ${reason}]`,
  });

  await broadcastToAgents(
    `🔔 *Guest needs a human*\n\n` +
    `*${contact.profile_name || 'Guest'}* — ${contact.wa_id}\n` +
    `${contact.source ? `Via: ${contact.source}\n` : ''}` +
    `Reason: ${reason}\n\n` +
    `_"${String(lastText).slice(0, 200)}"_\n\n` +
    `Reply *#claim* to take it.`,
    contact
  );
}

/**
 * Ping agents. Free-form only works if that agent messaged the business number in
 * the last 24 h; otherwise we fall back to an approved template.
 */
async function broadcastToAgents(body, contact = null) {
  const agents = await db.listActiveAgents();
  if (!agents.length) {
    console.warn('[router] no active agents to notify');
    return;
  }

  for (const a of agents) {
    if (a.active_chat && contact && a.active_chat !== contact.wa_id) continue; // busy elsewhere
    try {
      await sendText(a.wa_id, body);
      await db.touchAgentAlert(a.wa_id);
    } catch (err) {
      // 131047 / 131026 = 24-hour window closed
      if (config.wa.agentAlertTemplate) {
        try {
          await sendTemplate(
            a.wa_id,
            config.wa.agentAlertTemplate,
            config.wa.agentAlertTemplateLang,
            [contact?.profile_name || 'A guest', contact?.wa_id || '']
          );
        } catch (e2) {
          console.error('[router] agent template alert failed', a.wa_id, e2.message);
        }
      } else {
        console.error('[router] could not alert agent', a.wa_id, err.message);
      }
    }
  }
}

/** Forward a guest's message to the agent currently handling them. */
async function notifyClaimingAgent(contact, text) {
  if (!contact.claimed_by) return;
  try {
    await sendText(contact.claimed_by,
      `👤 *${contact.profile_name || contact.wa_id}*\n${text}`);
  } catch (err) {
    console.error('[router] relay to agent failed', err.message);
  }
}

/* ═══════════════════════ MENUS ═══════════════════════ */

/** Buttons/list taps and typed shortcuts. Returns true if fully handled. */
async function handleShortcut(contact, text) {
  const t = text.trim().toLowerCase();
  const to = contact.wa_id;

  if (['hi', 'hello', 'hey', 'bonjour', 'salut', 'menu', 'start', 'bonzour'].includes(t)) {
    await sendMainMenu(contact);
    return true;
  }

  switch (t) {
    case 'menu_activities':
      await sendList(to, {
        header: 'Our activities',
        body: 'Pick one and I\'ll give you the details, price and requirements.',
        footer: 'Vallé — Chamouny',
        buttonText: 'See activities',
        sections: [
          { title: 'In the air', rows: [
            { id: 'act_ziplines', title: 'Ziplines', description: 'From Rs 1,375 · 8 courses up to 5.5 km' },
            { id: 'act_bicycle', title: 'Bicycle Zipline', description: 'Rs 1,150 · 18 m up, unique in Mauritius' },
            { id: 'act_bridge', title: 'Nepalese Bridge', description: 'Rs 1,300 · 350 m, 80–100 m high' },
          ]},
          { title: 'On the ground', rows: [
            { id: 'act_quad', title: 'Quad', description: 'From Rs 3,600 · 1 h and 2 h tracks' },
            { id: 'act_buggy', title: 'Buggy', description: 'From Rs 7,500 · up to 4 seats' },
            { id: 'act_luge', title: 'Mountain Luge Kart', description: 'From Rs 700 · 15 min' },
          ]},
          { title: 'More', rows: [
            { id: 'act_packages', title: 'Packages', description: 'Light, Gold, VIP, Diamond…' },
            { id: 'act_dining', title: 'Dining', description: '2 restaurants, 2 cafeterias' },
            { id: 'act_cinematic', title: 'Cinematic', description: 'Photo & video of your day' },
          ]},
        ],
      });
      return true;

    case 'menu_book':
      await sendText(to,
        `Great! 🎉 To check availability I just need:\n\n` +
        `1️⃣ Your name\n2️⃣ Date of visit\n3️⃣ How many people (and ages if children)\n4️⃣ What you'd like to do\n\n` +
        `You can send it all in one message.`);
      return true;

    case 'menu_human':
      await queueForHuman(contact, 'Guest tapped "Talk to a person"', text, { guestAsked: true });
      return true;

    default:
      return false; // let the AI take it
  }
}

async function sendMainMenu(contact) {
  const name = contact.profile_name ? `, ${contact.profile_name.split(' ')[0]}` : '';
  await sendButtons(
    contact.wa_id,
    `Welcome to *Vallé — Advenature Park*${name}! 🌿\n\n` +
    `Ziplines up to 5.5 km, quad and buggy trails, the Nepalese Bridge and the 23 Coloured Earth — ` +
    `in the south of Mauritius, open daily 09:00–17:30.\n\n` +
    `What can I help you with?`,
    [
      { id: 'menu_activities', title: '🎢 Activities' },
      { id: 'menu_book', title: '📅 Book a visit' },
      { id: 'menu_human', title: '💬 Talk to a person' },
    ],
    { footer: 'Or just type your question' }
  );
  await db.logMessage({
    contactId: contact.id, direction: 'out', author: 'bot', body: '[main menu]',
  });
}

/* ═══════════════════════ HELPERS ═══════════════════════ */

/** Pulls text out of every message shape WhatsApp sends. */
function extractText(msg) {
  switch (msg.type) {
    case 'text':    return msg.text?.body || '';
    case 'button':  return msg.button?.text || '';
    case 'interactive':
      return msg.interactive?.button_reply?.id
          || msg.interactive?.list_reply?.id
          || '';
    default:        return ''; // image, audio, document, location, sticker…
  }
}

async function resolveAgent(waId) {
  const agent = await db.getAgent(waId);
  if (agent) return agent;
  // Bootstrap: numbers in ADMIN_NUMBERS become managers on first contact
  if (config.bot.adminNumbers.includes(waId)) {
    return db.upsertAgent(waId, 'Manager', 'manager');
  }
  return null;
}

/** Returns the contact's source tag, setting it if this message matches a QR prefill. */
async function tagSource(contact, text) {
  if (contact.source) return contact.source;
  const hit = QR_SOURCES.find((s) => s.match.test(text || ''));
  if (hit) {
    await db.setSource(contact.wa_id, hit.tag);
    contact.source = hit.tag;
  }
  return contact.source || null;
}

/* ═══════════════════ AUTO-RELEASE SWEEPER ═══════════════════ */

/** If an agent goes quiet, hand the guest back to the bot instead of leaving them stuck. */
export async function sweepStaleHandovers() {
  try {
    // Chats a colleague is handling are NEVER taken back automatically unless
    // the business opts in with HUMAN_TAKEOVER_MINUTES. The bot must not
    // reappear in a conversation a person is having with a guest.
    const takeoverMinutes = config.bot.humanTakeoverMinutes;
    const stale = takeoverMinutes > 0 ? await db.listStaleHumanChats(takeoverMinutes) : [];
    for (const c of stale) {
      await db.setMode(c.wa_id, 'bot');
      if (c.claimed_by && c.claimed_by !== APP_AGENT) {
        await db.setAgentActiveChat(c.claimed_by, null);
      }
      await sendText(c.wa_id,
        `Our assistant is back with you 🌿 Ask me anything about activities, prices or booking.`);
      console.log('[sweeper] auto-released', c.wa_id);
    }

    // Guests stuck in the WAITING queue must not wait forever either:
    // release them back to the bot when no agent claimed them in time, and
    // immediately when there are no active agents at all to claim them.
    const agents = await db.listActiveAgents();
    // Guests who asked for a person are excluded from both lists: their chat
    // belongs to the team until a colleague answers or releases it.
    const waiting = agents.length
      ? await db.listStaleWaiting(config.bot.handoverTimeoutMin)
      : await db.listWaitingReleasable(100);
    for (const c of waiting) {
      await db.setMode(c.wa_id, 'bot');
      console.log('[sweeper] released from waiting queue', c.wa_id);
    }
  } catch (err) {
    console.error('[sweeper] failed', err.message);
  }
}
