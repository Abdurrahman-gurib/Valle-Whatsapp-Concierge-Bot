/**
 * THE BACK OFFICE — runs inside WhatsApp itself.
 *
 * Any number in the `agents` table can message the business number and drive the
 * whole system with # commands. No web dashboard needed.
 *
 * The key idea: once an agent runs #claim, any plain text they send (no #) is
 * relayed straight to that customer, and the bot stops auto-answering them.
 */

import * as db from '../core/db.js';
import { sendText } from '../whatsapp/client.js';
import { askKnowledgeBase } from './ai.js';

const HELP = `*VALLÉ BACK OFFICE* 🎛

*Queue*
#queue — chats waiting for a human
#claim — take the oldest waiting chat
#claim 23057123456 — take a specific chat
#end — hand back to the bot
#who — which chat am I on

*While claimed*
Just type normally → sent to the guest
#note <text> — private note, guest can't see
#info — profile, source, notes, last messages

*Direct*
#say 23057123456 <text> — one-off message
#history 23057123456 — last 10 messages

*Control*
#bot off / #bot on — global kill switch
#mute 23057123456 — bot silent for this guest
#unmute 23057123456
#ask <question> — query the price list / factsheet
#stats — today's numbers
#leads — recent booking requests
#help — this menu`;

/**
 * @returns {boolean} true if the message was an admin action and is fully handled.
 */
export async function handleAdminMessage({ agent, text, from }) {
  const trimmed = (text || '').trim();

  // Not a command → relay to the customer this agent has claimed.
  if (!trimmed.startsWith('#')) {
    return relayToCustomer(agent, trimmed);
  }

  const [rawCmd, ...rest] = trimmed.split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case '#help':   return reply(from, HELP);
    case '#queue':  return cmdQueue(from);
    case '#claim':  return cmdClaim(agent, from, arg);
    case '#end':    return cmdEnd(agent, from);
    case '#who':    return cmdWho(agent, from);
    case '#note':   return cmdNote(agent, from, arg);
    case '#info':   return cmdInfo(agent, from);
    case '#say':    return cmdSay(agent, from, rest);
    case '#history':return cmdHistory(from, rest[0]);
    case '#bot':    return cmdBot(from, arg);
    case '#mute':   return cmdMute(from, rest[0], true);
    case '#unmute': return cmdMute(from, rest[0], false);
    case '#ask':    return cmdAsk(from, arg);
    case '#stats':  return cmdStats(from);
    case '#leads':  return cmdLeads(from);
    default:
      return reply(from, `Unknown command \`${cmd}\`.\nSend *#help* for the list.`);
  }
}

/* ───────────────────────── commands ───────────────────────── */

async function cmdQueue(from) {
  const waiting = await db.listWaiting(10);
  if (!waiting.length) return reply(from, '✅ Queue is empty. The bot is handling everything.');

  const lines = waiting.map((c, i) => {
    const mins = Math.round((Date.now() - new Date(c.last_seen_at)) / 60000);
    // A guest who asked for a person receives NO bot replies at all until
    // someone here answers, so the team must see that at a glance.
    const flag = c.bot_silent ? '\n   🔴 asked for a person, bot is silent' : '';
    return `${i + 1}. *${c.profile_name || c.wa_id}* (${c.wa_id})\n   waiting ${mins} min${c.source ? ` · via ${c.source}` : ''}${flag}`;
  });

  return reply(from, `⏳ *${waiting.length} waiting*\n\n${lines.join('\n')}\n\nSend *#claim* to take the oldest.`);
}

async function cmdClaim(agent, from, arg) {
  let target;

  if (arg) {
    target = await db.getContactByWaId(normalize(arg));
    if (!target) return reply(from, `No conversation found for ${arg}.`);
  } else {
    const [oldest] = await db.listWaiting(1);
    if (!oldest) return reply(from, 'Nothing in the queue right now. 👍');
    target = oldest;
  }

  if (target.mode === 'human' && target.claimed_by && target.claimed_by !== agent.wa_id) {
    const other = await db.getAgent(target.claimed_by);
    return reply(from, `⚠️ Already handled by ${other?.name || target.claimed_by}.\nSend *#claim ${target.wa_id}* again to take over.`);
  }

  await db.setMode(target.wa_id, 'human', agent.wa_id);
  await db.setAgentActiveChat(agent.wa_id, target.wa_id);

  const history = await db.getHistory(target.id, 8);
  const transcript = history
    .map((m) => `${m.author === 'customer' ? '👤' : '🤖'} ${truncate(m.body, 160)}`)
    .join('\n');
  const notes = await db.getNotes(target.id, 3);

  await reply(from,
    `✅ You are now on *${target.profile_name || target.wa_id}* (${target.wa_id})\n` +
    `${target.source ? `Source: ${target.source}\n` : ''}` +
    `\n*Recent:*\n${transcript || '(no messages)'}` +
    (notes.length ? `\n\n*Notes:*\n${notes.map((n) => `• ${n.body}`).join('\n')}` : '') +
    `\n\n_Type normally to reply. #end when done._`
  );

  // Tell the guest a human arrived — this is what makes handover feel good.
  await sendText(target.wa_id,
    `👋 Hi! ${agent.name} here from Vallé. I'm taking over from our assistant, how can I help?`
  );
  await db.logMessage({
    contactId: target.id, direction: 'out', author: 'system',
    body: `[${agent.name} claimed the chat]`,
  });
  return true;
}

async function cmdEnd(agent, from) {
  if (!agent.active_chat) return reply(from, 'You are not on any chat.');

  const contact = await db.getContactByWaId(agent.active_chat);
  await db.setMode(agent.active_chat, 'bot');
  await db.setAgentActiveChat(agent.wa_id, null);

  if (contact) {
    await sendText(contact.wa_id,
      `Thanks for chatting! 🌿 Our assistant is back on — ask me anything about activities, prices or booking.`
    );
    await db.logMessage({
      contactId: contact.id, direction: 'out', author: 'system',
      body: `[${agent.name} released the chat]`,
    });
  }

  return reply(from, `↩️ Released ${contact?.profile_name || agent.active_chat}. Bot is handling it again.`);
}

async function cmdWho(agent, from) {
  if (!agent.active_chat) return reply(from, 'Not on any chat. Send *#queue* to see who is waiting.');
  const c = await db.getContactByWaId(agent.active_chat);
  return reply(from, `You are on *${c?.profile_name || agent.active_chat}* (${agent.active_chat}).`);
}

async function cmdNote(agent, from, body) {
  if (!agent.active_chat) return reply(from, 'Claim a chat first (*#claim*).');
  if (!body) return reply(from, 'Usage: #note called twice, wants Saturday');
  const c = await db.getContactByWaId(agent.active_chat);
  await db.addNote(c.id, agent.wa_id, body);
  return reply(from, '📝 Note saved (private — the guest cannot see it).');
}

async function cmdInfo(agent, from) {
  if (!agent.active_chat) return reply(from, 'Claim a chat first (*#claim*).');
  const c = await db.getContactByWaId(agent.active_chat);
  const notes = await db.getNotes(c.id, 5);
  const hist = await db.getHistory(c.id, 6);

  return reply(from,
    `*${c.profile_name || 'Unknown'}* — ${c.wa_id}\n` +
    `Language: ${c.lang} · Mode: ${c.mode}\n` +
    `Source: ${c.source || 'direct'}\n` +
    `First seen: ${new Date(c.created_at).toLocaleDateString('en-GB')}\n` +
    (notes.length ? `\n*Notes*\n${notes.map((n) => `• ${n.body}`).join('\n')}` : '\n_No notes._') +
    `\n\n*Last messages*\n${hist.map((m) => `${m.author === 'customer' ? '👤' : '🤖'} ${truncate(m.body, 100)}`).join('\n')}`
  );
}

async function cmdSay(agent, from, rest) {
  const to = normalize(rest[0] || '');
  const body = rest.slice(1).join(' ');
  if (!to || !body) return reply(from, 'Usage: #say 23057123456 Your table is confirmed');

  const c = await db.getContactByWaId(to);
  await sendText(to, body);
  if (c) {
    await db.logMessage({
      contactId: c.id, direction: 'out', author: 'agent',
      authorWaId: agent.wa_id, body,
    });
  }
  return reply(from, `✅ Sent to ${to}.`);
}

async function cmdHistory(from, target) {
  const waId = normalize(target || '');
  const c = waId && (await db.getContactByWaId(waId));
  if (!c) return reply(from, 'Usage: #history 23057123456');

  const hist = await db.getHistory(c.id, 10);
  const icon = { customer: '👤', bot: '🤖', agent: '👨‍💼', system: '⚙️' };
  return reply(from,
    `*History — ${c.profile_name || waId}*\n\n` +
    hist.map((m) => `${icon[m.author] || '·'} ${truncate(m.body, 150)}`).join('\n')
  );
}

async function cmdBot(from, arg) {
  const on = /^on$/i.test(arg);
  const off = /^off$/i.test(arg);
  if (!on && !off) return reply(from, 'Usage: *#bot off* or *#bot on*');

  await db.setSetting('bot_enabled', on ? 'true' : 'false');
  return reply(from, on
    ? '🟢 Bot ON — AI is answering guests again.'
    : '🔴 Bot OFF — every incoming message now goes to the queue for a human.');
}

async function cmdMute(from, target, mute) {
  const waId = normalize(target || '');
  if (!waId) return reply(from, `Usage: #${mute ? '' : 'un'}mute 23057123456`);
  const c = await db.getContactByWaId(waId);
  if (!c) return reply(from, `No conversation with ${waId}.`);

  await db.setMode(waId, mute ? 'paused' : 'bot');
  return reply(from, mute
    ? `🔇 Bot muted for ${c.profile_name || waId}. Only humans will reply.`
    : `🔊 Bot re-enabled for ${c.profile_name || waId}.`);
}

async function cmdAsk(from, question) {
  if (!question) return reply(from, 'Usage: #ask what is the max weight on the bicycle zipline');
  const answer = await askKnowledgeBase(question);
  return reply(from, `📖 ${answer}`);
}

async function cmdStats(from) {
  const s = await db.getStats();
  return reply(from,
    `📊 *VALLÉ BOT*\n\n` +
    `Guests total: *${s.total_contacts}*\n` +
    `Active (24h): *${s.active_24h}*\n` +
    `Messages (24h): *${s.msgs_24h}*\n` +
    `Waiting for human: *${s.waiting}*\n` +
    `With an agent now: *${s.in_human}*\n` +
    `Booking requests (7d): *${s.leads_7d}*`
  );
}

async function cmdLeads(from) {
  const { rows } = await db.q(
    `SELECT l.*, c.wa_id, c.profile_name
       FROM leads l JOIN contacts c ON c.id = l.contact_id
      ORDER BY l.created_at DESC LIMIT 8`
  );
  if (!rows.length) return reply(from, 'No booking requests captured yet.');

  return reply(from,
    `🎟 *Recent booking requests*\n\n` +
    rows.map((l) =>
      `• *${l.full_name || l.profile_name || l.wa_id}* — ${l.pax || '?'} pax\n` +
      `  ${l.visit_date || 'date TBC'} · ${l.interest || '—'}\n` +
      `  wa.me/${l.wa_id}`
    ).join('\n\n')
  );
}

/* ───────────────────────── relay ───────────────────────── */

async function relayToCustomer(agent, text) {
  if (!agent.active_chat) {
    await reply(agent.wa_id,
      `You are not on a chat, so that wasn't sent anywhere.\nSend *#queue* to see who is waiting, or *#help*.`);
    return true;
  }
  if (!text) return true;

  const c = await db.getContactByWaId(agent.active_chat);
  if (!c) {
    await db.setAgentActiveChat(agent.wa_id, null);
    return reply(agent.wa_id, 'That conversation no longer exists.');
  }

  await sendText(c.wa_id, text);
  await db.logMessage({
    contactId: c.id, direction: 'out', author: 'agent',
    authorWaId: agent.wa_id, body: text,
  });
  return true;
}

/* ───────────────────────── helpers ───────────────────────── */

async function reply(to, body) {
  await sendText(to, body);
  return true;
}

/** Accepts 5292 8841, +230 5292 8841, wa.me/230... → 23052928841 */
function normalize(input) {
  const digits = String(input).replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 8 ? `230${digits}` : digits;
}

function truncate(s, n) {
  const t = String(s || '').replace(/\n/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}
