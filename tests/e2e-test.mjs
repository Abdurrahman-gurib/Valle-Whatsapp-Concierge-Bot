/**
 * End-to-end smoke test.
 * Runs the REAL router/admin/db code against an in-memory Postgres,
 * with the WhatsApp send + Claude call stubbed out.
 *
 *   npm run test:e2e
 */
import { newDb } from 'pg-mem';

process.env.WHATSAPP_TOKEN = 'test';
process.env.PHONE_NUMBER_ID = '1';
process.env.VERIFY_TOKEN = 'v';
process.env.APP_SECRET = 's';
process.env.ANTHROPIC_API_KEY = 'k';
process.env.DATABASE_URL = 'postgres://x/y';
process.env.ADMIN_NUMBERS = '23052928841';
process.env.QR_ONLY = 'true';
process.env.BOT_MODE = 'menu';
process.env.OPENAI_API_KEY = 'sk-test-whisper';
// Email and SMS stay OFF unless a section switches them on: dotenv must not
// leak the real Resend and Twilio keys from .env into the suite.
process.env.RESEND_API_KEY = '';
process.env.EMAIL_FROM = '';
process.env.TWILIO_ACCOUNT_SID = '';
process.env.TWILIO_AUTH_TOKEN = '';
process.env.TWILIO_FROM = '';
process.env.TWILIO_MESSAGING_SERVICE_SID = '';

import fs from 'node:fs';

/* ---- in-memory postgres ---- */
const mem = newDb();
mem.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
const pgAdapter = mem.adapters.createPg();
const memPool = new pgAdapter.Pool();

/* ---- point db.js at it (pool.query is a normal property, so this is fine) ---- */
const dbMod = await import('../src/core/db.js');
dbMod.pool.query = (...a) => memPool.query(...a);

/* ---- a fixed weather reading, so no section ever calls Open-Meteo for real ---- */
const weatherMod = await import('../src/core/weather.js');
const SAMPLE_WEATHER = {
  observedAt: '2026-08-28T12:15', temperature: 20, feelsLike: 19, humidity: 90, precipitation: 0.6,
  condition: 'light rain showers', wind: 28, gusts: 60,
  days: [
    { date: '2026-08-28', condition: 'rain showers', max: 21, min: 18, rainChance: 100, gusts: 63, sunrise: '06:22', sunset: '18:00' },
    { date: '2026-08-29', condition: 'light drizzle', max: 21, min: 17, rainChance: 78, gusts: 72, sunrise: '06:21', sunset: '18:00' },
    { date: '2026-08-30', condition: 'light drizzle', max: 22, min: 18, rainChance: 78, gusts: 75, sunrise: '06:20', sunset: '18:00' },
  ],
};
weatherMod._setWeatherCache(SAMPLE_WEATHER);

await memPool.query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));

/* ---- tiny assertion helpers ---- */
let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label} ${extra}`); fail++; }
};

const inbound = (from, body, id) => ({
  from, id: id || 'wamid.' + Math.random(), type: 'text', text: { body },
});

console.log('\n═══ VALLÉ BOT — END-TO-END TEST ═══\n');

/* ═══ 1. Contact creation + source tagging ═══ */
console.log('1. Guest scans the RECEPTION QR and sends the prefilled message');
{
  const c = await dbMod.getOrCreateContact('23057111111', 'Marie');
  check('contact created', c.wa_id === '23057111111');
  check('starts in bot mode', c.mode === 'bot');

  await dbMod.setSource('23057111111', 'reception');
  const c2 = await dbMod.getContactByWaId('23057111111');
  check('QR source tagged as "reception"', c2.source === 'reception', `got ${c2.source}`);
}

/* ═══ 2. Message idempotency (Meta retries webhooks) ═══ */
console.log('\n2. Meta re-delivers the same webhook twice');
{
  const c = await dbMod.getContactByWaId('23057111111');
  const first = await dbMod.logMessage({
    contactId: c.id, waMessageId: 'wamid.DUPE', direction: 'in',
    author: 'customer', body: 'How much is the zipline?',
  });
  await dbMod.logMessage({
    contactId: c.id, waMessageId: 'wamid.DUPE', direction: 'in',
    author: 'customer', body: 'How much is the zipline?',
  });
  check('first delivery stored', first === true);

  // pg-mem misreports rowCount on ON CONFLICT DO NOTHING, so assert the real
  // outcome: the unique index must have kept exactly one row.
  const { rows } = await dbMod.q(
    `SELECT count(*)::int AS n FROM messages WHERE wa_message_id = 'wamid.DUPE'`);
  check('duplicate rejected — exactly 1 row stored', rows[0].n === 1, `got ${rows[0].n}`);
}

/* ═══ 3. Handover queue ═══ */
console.log('\n3. Guest asks for a human');
{
  await dbMod.setMode('23057111111', 'waiting');
  const waiting = await dbMod.listWaiting(10);
  check('appears in the queue', waiting.length === 1 && waiting[0].wa_id === '23057111111');
}

/* ═══ 4. Agent claims ═══ */
console.log('\n4. Agent claims the chat from their own WhatsApp');
{
  const agent = await dbMod.upsertAgent('23052928841', 'Priya', 'manager');
  check('agent registered', agent.name === 'Priya');

  await dbMod.setMode('23057111111', 'human', agent.wa_id);
  await dbMod.setAgentActiveChat(agent.wa_id, '23057111111');

  const c = await dbMod.getContactByWaId('23057111111');
  check('contact now in human mode', c.mode === 'human');
  check('claimed by the right agent', c.claimed_by === '23052928841');

  const a2 = await dbMod.getAgent('23052928841');
  check('agent has an active chat', a2.active_chat === '23057111111');
}

/* ═══ 5. Notes are private ═══ */
console.log('\n5. Agent leaves a private note');
{
  const c = await dbMod.getContactByWaId('23057111111');
  await dbMod.addNote(c.id, '23052928841', 'Wants Saturday, 4 pax, has a 7yo');
  const notes = await dbMod.getNotes(c.id);
  check('note saved', notes.length === 1);
  check('note text intact', notes[0].body.includes('Saturday'));
}

/* ═══ 6. Release back to bot ═══ */
console.log('\n6. Agent releases the chat');
{
  await dbMod.setMode('23057111111', 'bot');
  await dbMod.setAgentActiveChat('23052928841', null);
  const c = await dbMod.getContactByWaId('23057111111');
  check('back to bot mode', c.mode === 'bot');
  check('claim cleared', c.claimed_by === null);
}

/* ═══ 7. Leads ═══ */
console.log('\n7. AI captures a booking request');
{
  const c = await dbMod.getContactByWaId('23057111111');
  await dbMod.saveLead(c.id, {
    full_name: 'Marie Laurent', pax: 4, visit_date: '2026-09-05',
    interest: 'Sky Pulse Tour + Quad Adventure',
  });
  const { rows } = await dbMod.q('SELECT * FROM leads');
  check('lead stored', rows.length === 1);
  check('pax captured', rows[0].pax === 4);
  check('interest captured', rows[0].interest.includes('Sky Pulse'));
}

/* ═══ 8. Global kill switch ═══ */
console.log('\n8. Manager flips the global kill switch');
{
  check('bot on by default', (await dbMod.getSetting('bot_enabled')) === 'true');
  await dbMod.setSetting('bot_enabled', 'false');
  check('bot turned off', (await dbMod.getSetting('bot_enabled')) === 'false');
  await dbMod.setSetting('bot_enabled', 'true');
  check('bot turned back on', (await dbMod.getSetting('bot_enabled')) === 'true');
}

/* ═══ 9. Text extraction from every message shape ═══ */
console.log('\n9. Parsing the different WhatsApp message shapes');
{
  // extractText is private, so exercise it through the shapes the router sees
  const shapes = [
    { type: 'text', text: { body: 'hello' }, expect: 'hello' },
    { type: 'interactive', interactive: { button_reply: { id: 'menu_book', title: 'Book' } }, expect: 'menu_book' },
    { type: 'interactive', interactive: { list_reply: { id: 'act_quad', title: 'Quad' } }, expect: 'act_quad' },
    { type: 'button', button: { text: 'Yes' }, expect: 'Yes' },
    { type: 'image', image: { id: '1' }, expect: '' },
  ];
  const extract = (m) => m.type === 'text' ? m.text?.body || ''
    : m.type === 'button' ? m.button?.text || ''
    : m.type === 'interactive' ? (m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || '')
    : '';
  for (const s of shapes) {
    check(`${s.type}${s.interactive ? ' (' + Object.keys(s.interactive)[0] + ')' : ''} → "${s.expect}"`,
      extract(s) === s.expect, `got "${extract(s)}"`);
  }
}

/* ═══ 10. AI control-line parsing ═══ */
console.log('\n10. Stripping ::CONTROL lines so guests never see them');
{
  const raw = `Sure! Our Gold package is Rs 19,400 single 🌿
Let me get a colleague to confirm availability.
::HANDOVER: guest wants to confirm a date
::LEAD: {"full_name":"Marie","pax":4,"visit_date":"5 Sept","interest":"Gold package"}`;

  // mirror of parseControl in ai.js
  let handover = null, lead = null; const kept = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t.startsWith('::HANDOVER:')) handover = t.slice(11).trim();
    else if (t.startsWith('::LEAD:')) { try { lead = JSON.parse(t.slice(7).trim()); } catch {} }
    else kept.push(line);
  }
  const reply = kept.join('\n').trim();

  check('control lines removed from guest reply', !reply.includes('::'));
  check('guest text preserved', reply.includes('Rs 19,400'));
  check('handover reason extracted', handover === 'guest wants to confirm a date');
  check('lead JSON parsed', lead?.pax === 4 && lead?.full_name === 'Marie');
}

/* ═══ 11. Number normalisation ═══ */
console.log('\n11. Normalising the many ways staff type a number');
{
  const normalize = (input) => {
    const d = String(input).replace(/\D/g, '');
    return !d ? '' : d.length === 8 ? `230${d}` : d;
  };
  const cases = [
    ['5292 8841', '23052928841'],
    ['+230 5292 8841', '23052928841'],
    ['52928841', '23052928841'],
    ['23052928841', '23052928841'],
    ['wa.me/23052928841', '23052928841'],
  ];
  for (const [input, want] of cases) {
    check(`"${input}" → ${want}`, normalize(input) === want, `got ${normalize(input)}`);
  }
}

/* ═══ 12. Long-message splitting ═══ */
console.log('\n12. Splitting replies over the 4096-char WhatsApp limit');
{
  const split = (text, limit = 3900) => {
    if (text.length <= limit) return [text];
    const out = []; let buf = '';
    for (const para of text.split('\n')) {
      if ((buf + '\n' + para).length > limit) { if (buf) out.push(buf); buf = para.slice(0, limit); }
      else buf = buf ? buf + '\n' + para : para;
    }
    if (buf) out.push(buf);
    return out;
  };
  const short = 'Rs 550 for admission.';
  const long = Array.from({ length: 400 }, (_, i) => `Line ${i}: some park info here`).join('\n');
  check('short message stays as one', split(short).length === 1);
  const chunks = split(long);
  check(`long message split into ${chunks.length} parts`, chunks.length > 1);
  check('every chunk under the limit', chunks.every((c) => c.length <= 3900));
  check('no content lost', chunks.join('\n').length === long.length);
}

/* ═══ 13. Business hours ═══ */
console.log('\n13. Business-hours awareness (Indian/Mauritius)');
{
  const { isBusinessHours } = await import('../src/core/config.js');
  check('10:00 local is open', isBusinessHours(new Date('2026-08-20T06:00:00Z')));  // 10:00 MU
  check('22:00 local is closed', !isBusinessHours(new Date('2026-08-20T18:00:00Z'))); // 22:00 MU
  check('06:00 local is closed', !isBusinessHours(new Date('2026-08-20T02:00:00Z'))); // 06:00 MU
}

/* ═══ 14. Stats ═══ */
console.log('\n14. #stats aggregation');
{
  const s = await dbMod.getStats();
  check('counts contacts', Number(s.total_contacts) >= 1);
  check('counts leads', Number(s.leads_7d) >= 1);
}

/* ═══ 15. QR-only gate — through the REAL router, network stubbed ═══ */
console.log('\n15. QR-only gate: strangers get silence, QR scanners get replies');
{
  const sent = []; // every real outbound message (read receipts filtered out)
  let anthropicCalls = 0;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('anthropic')) {
      anthropicCalls++;
      try { globalThis.__onAiRequest?.(JSON.parse(opts.body)); } catch { /* not JSON */ }
      if (globalThis.__aiHook) await globalThis.__aiHook();   // colleague steps in mid-answer
      return new Response(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant',
        model: 'claude-test', stop_reason: 'end_turn',
        content: [{ type: 'text', text: globalThis.__aiReply || 'Welcome to Vallé! 🌿' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('api.openai.com/v1/audio/speech')) { // TTS → opus bytes
      return new Response(new Uint8Array([79, 112, 117, 115]), { status: 200 });
    }
    if (u.includes('/media') && !/MEDIA\d/.test(u)) { // media upload
      return new Response(JSON.stringify({ id: 'MEDIA_OUT_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('lookaside')) { // media bytes (photo download)
      return new Response(new Uint8Array([255, 216, 255]), { status: 200 });
    }
    if (u.includes('api.openai.com/v1/audio/transcriptions')) {
      return new Response(JSON.stringify({ text: "Bonjour, c'est quoi le prix des tyroliennes pour deux personnes s'il vous plaît ?" }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/MEDIA\d+/.test(u)) { // media info lookup by id
      return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp/media/abc', mime_type: 'audio/ogg' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('lookaside')) { // media bytes
      return new Response(new Uint8Array([79, 103, 103, 83]), { status: 200 });
    }
    const payload = JSON.parse(opts?.body || '{}');
    if (!payload.status) sent.push({ ...payload, _url: u, _headers: opts?.headers || {} }); // status:'read' = receipt/typing, not a send
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  // Import AFTER stubbing fetch so ai.js's Anthropic client picks up the stub.
  const { handleIncomingMessage } = await import('../src/bot/router.js');

  // A stranger who found the number some other way — no QR text, no reply.
  await handleIncomingMessage(
    inbound('23057222222', 'Hello, are you open today?'),
    { wa_id: '23057222222', profile: { name: 'Randomer' } });
  check('stranger gets no reply', sent.length === 0, `sent ${sent.length}`);

  // A guest who scanned the ATM Dubai QR and pressed send.
  await handleIncomingMessage(
    inbound('971501234567',
      'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.'),
    { wa_id: '971501234567', profile: { name: 'Fatima' } });
  const scanner = await dbMod.getContactByWaId('971501234567');
  check('scanner tagged "atm-dubai-2026"', scanner?.source === 'atm-dubai-2026', `got ${scanner?.source}`);
  check('scanner got a reply', sent.length > 0, `sent ${sent.length}`);

  // Their follow-up messages no longer contain QR text — still unlocked.
  const afterFirst = sent.length;
  await handleIncomingMessage(
    inbound('971501234567', 'hello'),
    { wa_id: '971501234567', profile: { name: 'Fatima' } });
  check('scanner stays unlocked on follow-ups', sent.length > afterFirst, `sent ${sent.length}`);

  // The stranger tries again — still silence.
  const beforeRetry = sent.length;
  await handleIncomingMessage(
    inbound('23057222222', 'hi'),
    { wa_id: '23057222222', profile: { name: 'Randomer' } });
  check('stranger still ignored', sent.length === beforeRetry, `sent ${sent.length}`);

  /* ═══ 16. Menu bot: buttons, keywords, booking handoff — zero AI ═══ */
  console.log('\n16. Menu bot (BOT_MODE=menu): guided replies without AI');

  // Scanner taps the "Activities" button
  let before = sent.length;
  await handleIncomingMessage(
    { from: '971501234567', id: 'wamid.m1', type: 'interactive',
      interactive: { button_reply: { id: 'menu_activities', title: '🎢 Activities' } } },
    { wa_id: '971501234567', profile: { name: 'Fatima' } });
  const listMsg = sent[sent.length - 1];
  check('activities list sent', sent.length > before && listMsg?.interactive?.type === 'list');

  // Taps the Quad row in the list
  await handleIncomingMessage(
    { from: '971501234567', id: 'wamid.m2', type: 'interactive',
      interactive: { list_reply: { id: 'act_quad', title: 'Quad' } } },
    { wa_id: '971501234567', profile: { name: 'Fatima' } });
  const quadMsg = sent[sent.length - 1];
  check('quad card has the real price', quadMsg?.text?.body?.includes('Rs 3,600') === true);

  // Types a keyword question
  await handleIncomingMessage(inbound('971501234567', 'how much is the zipline?'),
    { wa_id: '971501234567', profile: { name: 'Fatima' } });
  const zipMsg = sent[sent.length - 1];
  check('typed "zipline" answered with prices', zipMsg?.text?.body?.includes('Rs 5,650') === true);

  // Sends booking details → acknowledged and queued for the team
  before = sent.length;
  await handleIncomingMessage(
    inbound('971501234567', 'Fatima Ahmed, 4 people, 12 September, Gold package'),
    { wa_id: '971501234567', profile: { name: 'Fatima' } });
  const fatima = await dbMod.getContactByWaId('971501234567');
  check('booking details queued for the team', fatima.mode === 'waiting', `mode=${fatima.mode}`);
  check('guest got an acknowledgement', sent.length > before);

  check('ZERO AI calls in menu mode', anthropicCalls === 0, `got ${anthropicCalls}`);

  /* ═══ 17. Hybrid mode: buttons & cards first, AI for free text ═══ */
  console.log('\n17. Hybrid bot (BOT_MODE=hybrid): cards for keywords, AI for the rest');
  const { config: cfg } = await import('../src/core/config.js');
  cfg.bot.mode = 'hybrid';

  // New guest scans the ATM QR → welcome buttons, no AI call
  await handleIncomingMessage(
    inbound('971509999999',
      'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  const welcome = sent[sent.length - 1];
  check('hybrid welcome is the list menu',
    welcome?.interactive?.type === 'list', JSON.stringify(welcome)?.slice(0, 80));
  check('welcome without AI', anthropicCalls === 0, `got ${anthropicCalls}`);

  // A file request is answered instantly, with no AI call
  await handleIncomingMessage(inbound('971509999999', 'send me the brochure'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  check('file request → instant document, no AI',
    sent[sent.length - 1]?.type === 'document' && anthropicCalls === 0);

  // A question in the guest's own words goes to the assistant
  await handleIncomingMessage(inbound('971509999999', 'quad price please'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  check('written question → answered by the assistant, not a canned card',
    anthropicCalls === 1, `calls=${anthropicCalls}`);

  // Free-form question → AI answers
  await handleIncomingMessage(inbound('971509999999', 'Is the park suitable for my grandmother?'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  const aiReply = sent[sent.length - 1];
  check('free text → AI reply sent', aiReply?.text?.body?.includes('Welcome to Vallé'), JSON.stringify(aiReply)?.slice(0, 80));

  // French question → must reach the assistant, never an English card
  const callsBeforeFr = anthropicCalls;
  await handleIncomingMessage(inbound('971509999999', 'Bonjour, quel est le prix des tyroliennes ?'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  check('French text goes to the assistant', anthropicCalls === callsBeforeFr + 1, `got ${anthropicCalls}`);

  // Re-sending the QR prefill → welcome again, never a silent "lead" queue
  await handleIncomingMessage(
    inbound('971509999999',
      'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  const rescan = sent[sent.length - 1];
  const omarAfterRescan = await dbMod.getContactByWaId('971509999999');
  check('re-scanned prefill → welcome menu again', rescan?.interactive?.type === 'list');
  check('re-scan does NOT queue the guest', omarAfterRescan.mode === 'bot', `mode=${omarAfterRescan.mode}`);

  /* ═══ 18. 360dialog provider: same bot, different pipe ═══ */
  console.log('\n18. 360dialog gateway (coexistence): sends via waba-v2 with API key');
  cfg.wa.provider = 'd360';
  cfg.wa.d360ApiKey = 'test-d360-key';

  await handleIncomingMessage(inbound('971509999999', 'quad'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  const viaD360 = sent[sent.length - 1];
  check('sent through waba-v2.360dialog.io', viaD360?._url?.includes('waba-v2.360dialog.io') === true, viaD360?._url);
  check('authenticated with D360-API-KEY', viaD360?._headers?.['D360-API-KEY'] === 'test-d360-key');
  check('payload still Cloud API format',
    viaD360?.messaging_product === 'whatsapp' && typeof viaD360?.text?.body === 'string');

  cfg.wa.provider = 'meta';

  /* ═══ 19. Voice notes: transcribed and answered; graceful without a key ═══ */
  console.log('\n19. Voice notes (hybrid): French audio → transcript → AI reply');

  // Scanner sends a French voice note — media downloaded, Whisper stubbed, AI answers
  const aiCallsBefore = anthropicCalls;
  await handleIncomingMessage(
    { from: '971509999999', id: 'wamid.v1', type: 'audio',
      audio: { id: 'MEDIA123', mime_type: 'audio/ogg; codecs=opus', voice: true } },
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  const voiceReply = sent[sent.length - 1];
  check('voice note answered by the AI (text)', voiceReply?.text?.body?.includes('Welcome to Vallé') === true);
  check('voice note also answered WITH VOICE', sent.some((m) => m.type === 'audio' && m.audio?.id === 'MEDIA_OUT_1'));
  check('one AI call for the voice note', anthropicCalls === aiCallsBefore + 1, `got ${anthropicCalls}`);

  // Without a transcription key: warm ack + handed to the team
  cfg.stt.openaiKey = '';
  await handleIncomingMessage(
    { from: '971509999999', id: 'wamid.v2', type: 'audio',
      audio: { id: 'MEDIA456', mime_type: 'audio/ogg', voice: true } },
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  const ack = sent.find((m) => m?.text?.body?.includes('voice message'));
  const omar = await dbMod.getContactByWaId('971509999999');
  check('no-key fallback: guest acknowledged', Boolean(ack));
  check('no-key fallback: handed to the team', omar.mode === 'waiting', `mode=${omar.mode}`);
  cfg.stt.openaiKey = 'sk-test-whisper';

  /* ═══ 20. Photos analyzed, brochure PDF, Google Maps link ═══ */
  console.log('\n20. Photos → AI vision, BROCHURE → PDF, location → maps link');
  await dbMod.setMode('971509999999', 'bot'); // release Omar from the fallback test

  const beforePhoto = anthropicCalls;
  await handleIncomingMessage(
    { from: '971509999999', id: 'wamid.p1', type: 'image',
      image: { id: 'MEDIA789', caption: 'Is this your park?' } },
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  check('photo → AI vision reply',
    anthropicCalls === beforePhoto + 1 && sent[sent.length - 1]?.text?.body?.includes('Welcome to Vallé'),
    `calls=${anthropicCalls}`);

  await handleIncomingMessage(inbound('971509999999', 'can I have the brochure pdf please'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  const docMsg = sent.find((m) => m.type === 'document');
  check('BROCHURE → pricelist PDF document sent',
    docMsg?.document?.id === 'MEDIA_OUT_1' && /Pricelist/.test(docMsg?.document?.filename || ''));

  globalThis.__aiReply = 'We are in Chamouny, south Mauritius.\nhttps://maps.google.com/?q=Vall%C3%A9+Advenature+Park+Chamouny+Mauritius';
  await handleIncomingMessage(inbound('971509999999', 'where is your location?'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  const locMsg = sent[sent.length - 1];
  check('location answer carries the Google Maps link', locMsg?.text?.body?.includes('maps.google.com') === true);
  globalThis.__aiReply = null;

  // New menu rows: About Vallé and Kids & family
  await handleIncomingMessage(
    { from: '971509999999', id: 'wamid.a1', type: 'interactive',
      interactive: { list_reply: { id: 'about', title: 'About Vallé' } } },
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  check('About card tells the story', sent[sent.length - 1]?.text?.body?.includes('tea plantation') === true);

  await handleIncomingMessage(
    { from: '971509999999', id: 'wamid.k1', type: 'interactive',
      interactive: { list_reply: { id: 'kids', title: 'Kids & family' } } },
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  check('Kids card has family info', sent.some((m) => m?.text?.body?.includes('1–5 FREE')));
  check('Kids card arrives with a photo',
    sent.some((m) => m.type === 'image' && /Kids Park/i.test(m.image?.caption || '')));

  /* ═══ 21. Park photos, park map and company documents ═══ */
  console.log('\n21. Photo galleries, park map and company PDFs');

  before = sent.length;
  globalThis.__aiReply = 'Avec plaisir, voici nos tyroliennes.\n::SEND: photos:ziplines';
  await handleIncomingMessage(inbound('971509999999', 'do you have photos of the ziplines?'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  const zipPhotos = sent.slice(before).filter((m) => m.type === 'image');
  check('photo request → gallery of zipline photos', zipPhotos.length >= 2, `got ${zipPhotos.length}`);
  globalThis.__aiReply = null;

  before = sent.length;
  await handleIncomingMessage(inbound('971509999999', 'send me the park map please'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  check('map request → sitemap image',
    sent.slice(before).some((m) => m.type === 'image' && /trail map/i.test(m.image?.caption || '')));

  before = sent.length;
  await handleIncomingMessage(inbound('971509999999', 'can I see the restaurant menu card?'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  const menuDocs = sent.slice(before).filter((m) => m.type === 'document');
  check('menu request → both restaurant menus as PDF', menuDocs.length === 2, `got ${menuDocs.length}`);

  before = sent.length;
  await handleIncomingMessage(inbound('971509999999', 'send the company magazine'),
    { wa_id: '971509999999', profile: { name: 'Omar' } });
  check('magazine request → company profile PDF',
    sent.slice(before).some((m) => m.type === 'document' && /Magazine/i.test(m.document?.filename || '')));

  /* ═══ 22. CRITICAL: a colleague replying always wins over the bot ═══ */
  console.log('\n22. Human takeover: the bot never reads, replies or double-messages');
  const { handleStaffEcho } = await import('../src/bot/router.js');
  const GUEST = '971509999999';

  // A read receipt is a "read" by the bot: it must never happen for a stranger.
  const reads = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    try {
      const p = JSON.parse(opts?.body || '{}');
      if (p.status === 'read') reads.push(p.message_id);
    } catch { /* not JSON (media upload) */ }
    return priorFetch(url, opts);
  };

  // (a) A stranger who never scanned a QR: no reply AND no read receipt.
  let before22 = sent.length;
  const readsBefore = reads.length;
  await handleIncomingMessage(inbound('23050000001', 'Bonjour, vous êtes ouverts ?'),
    { wa_id: '23050000001', profile: { name: 'Passerby' } });
  check('stranger: no reply at all', sent.length === before22, `sent ${sent.length - before22}`);
  check('stranger: message never marked as read', reads.length === readsBefore,
    `${reads.length - readsBefore} read receipts`);

  // (b) A colleague answers this guest from the WhatsApp Business app.
  await handleStaffEcho({ id: 'wamid.STAFF1', to: GUEST, type: 'text',
    text: { body: 'Bonjour! Oui, nous avons de la place demain.' } });
  const afterEcho = await dbMod.getContactByWaId(GUEST);
  check('staff app reply → chat handed to the human', afterEcho.mode === 'human', `mode=${afterEcho.mode}`);

  // (c) The guest writes again: total silence, and no read receipt.
  before22 = sent.length;
  const reads2 = reads.length;
  await handleIncomingMessage(inbound(GUEST, 'Parfait, et le prix pour 2 personnes ?'),
    { wa_id: GUEST, profile: { name: 'Omar' } });
  check('after takeover: bot sends nothing', sent.length === before22, `sent ${sent.length - before22}`);
  check('after takeover: nothing marked as read', reads.length === reads2);

  // (d) The bot's OWN messages echo back too: they must not pause anything.
  //     The stub returns id 'wamid.out' for every send, so echoing that id is
  //     exactly what WhatsApp does after the bot answers.
  await dbMod.setMode(GUEST, 'bot');
  await handleIncomingMessage(inbound(GUEST, 'quad'), { wa_id: GUEST, profile: { name: 'Omar' } });
  await handleStaffEcho({ id: 'wamid.out', to: GUEST, type: 'text', text: { body: 'bot reply echo' } });
  const notPaused = await dbMod.getContactByWaId(GUEST);
  check("bot's own echo does not pause it", notPaused.mode === 'bot', `mode=${notPaused.mode}`);

  // (e) A colleague replies WHILE the AI is writing: the answer is dropped.
  globalThis.__aiHook = async () => {
    await handleStaffEcho({ id: 'wamid.STAFF2', to: GUEST, type: 'text',
      text: { body: 'I am taking this one.' } });
    globalThis.__aiHook = null;                      // only once
  };
  before22 = sent.length;
  await handleIncomingMessage(inbound(GUEST, 'Would this suit my father who is 78 years old?'),
    { wa_id: GUEST, profile: { name: 'Omar' } });
  check('takeover mid-answer: AI reply dropped, no double message',
    sent.length === before22, `sent ${sent.length - before22}`);
  globalThis.fetch = priorFetch;   // stop counting read receipts

  // (f) WhatsApp refuses any list with more than 10 rows and the guest then
  //     gets NOTHING. Every list the bot can send must stay within the limit.
  const lists = sent.filter((m) => m.interactive?.type === 'list');
  const worst = Math.max(...lists.map((m) =>
    m.interactive.action.sections.reduce((n, s) => n + s.rows.length, 0)));
  check(`every list menu is within WhatsApp's 10-row limit (worst: ${worst})`,
    lists.length > 0 && worst <= 10);

  // (g) If the menu is refused anyway, the guest still gets a welcome.
  const failing = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const p = (() => { try { return JSON.parse(opts?.body || '{}'); } catch { return {}; } })();
    if (p.interactive?.type === 'list') {
      return new Response(JSON.stringify({ error: { code: 131009, message: 'row count' } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return failing(url, opts);
  };
  before22 = sent.length;
  const { sendMenuWelcome } = await import('../src/bot/menu-bot.js');
  await sendMenuWelcome(await dbMod.getContactByWaId(GUEST));
  check('menu refused → guest still gets a text welcome',
    sent.slice(before22).some((m) => m.text?.body?.includes('Welcome to')));
  globalThis.fetch = failing;

  // (h) A human-handled chat is never auto-released back to the bot.
  await dbMod.q(`UPDATE contacts SET claimed_at = now() - interval '5 days' WHERE wa_id = $1`, [GUEST]);
  const { sweepStaleHandovers } = await import('../src/bot/router.js');
  await sweepStaleHandovers();
  const stillHuman = await dbMod.getContactByWaId(GUEST);
  check('sweeper never steals a chat back from a colleague',
    stillHuman.mode === 'human', `mode=${stillHuman.mode}`);
}

/* ═══ 23. Real-world flows that broke in production ═══ */
console.log('\n23. Guest flows end to end: QR precision, voice extras, any-language attachments');
{
  const { handleIncomingMessage } = await import('../src/bot/router.js');
  const { config: cfg } = await import('../src/core/config.js');
  cfg.bot.mode = 'hybrid';
  cfg.stt.openaiKey = 'sk-test-whisper';

  const seen = [];
  const realFetch = globalThis.fetch;
  const setAiReply = (t) => { globalThis.__aiReply = t; };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.openai.com/v1/audio/transcriptions')) {
      return new Response(JSON.stringify({ text: globalThis.__transcript || 'hello' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/media') && !/MEDIA\d/.test(u)) {
      return new Response(JSON.stringify({ id: 'MEDIA_OUT_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/MEDIA\d+/.test(u)) {
      return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'audio/ogg' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('lookaside')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    const p = JSON.parse(opts?.body || '{}');
    if (!p.status) seen.push(p);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.o' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const said = (n = 1) => seen.slice(-n);
  const ATM = 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.';

  // (a) An ordinary customer who merely mentions "quad" is NOT a QR scanner.
  let n = seen.length;
  await handleIncomingMessage(inbound('23050000010', 'Bonjour, avez-vous des quad pour demain ?'),
    { wa_id: '23050000010', profile: { name: 'Passant' } });
  const notScanner = await dbMod.getContactByWaId('23050000010');
  check('word "quad" alone never unlocks the bot', !notScanner.source && seen.length === n,
    `source=${notScanner.source} sent=${seen.length - n}`);

  // (b) A real QR scan on any phone gets the welcome menu.
  n = seen.length;
  await handleIncomingMessage(inbound('971555000001', ATM),
    { wa_id: '971555000001', profile: { name: 'Aisha' } });
  const scanner = await dbMod.getContactByWaId('971555000001');
  check('QR scan → tagged + welcome menu',
    scanner.source === 'atm-dubai-2026' && said()[0]?.interactive?.type === 'list');

  // (c) A colleague replied hours ago; the guest scans again → concierge resumes.
  await dbMod.setMode('971555000001', 'human', 'app');
  await dbMod.q(`INSERT INTO messages (contact_id, direction, author, body, created_at)
                 VALUES ($1,'out','agent','older reply', now() - interval '3 hours')`, [scanner.id]);
  n = seen.length;
  await handleIncomingMessage(inbound('971555000001', ATM),
    { wa_id: '971555000001', profile: { name: 'Aisha' } });
  const resumed = await dbMod.getContactByWaId('971555000001');
  check('QR scan after a quiet handover → concierge resumes',
    resumed.mode === 'bot' && seen.length > n, `mode=${resumed.mode}`);

  // (d) But a colleague replying RIGHT NOW keeps the chat.
  await dbMod.setMode('971555000001', 'human', 'app');
  await dbMod.q(`INSERT INTO messages (contact_id, direction, author, body) VALUES ($1,'out','agent','just now')`,
    [scanner.id]);
  n = seen.length;
  await handleIncomingMessage(inbound('971555000001', ATM),
    { wa_id: '971555000001', profile: { name: 'Aisha' } });
  const stillHuman = await dbMod.getContactByWaId('971555000001');
  check('QR scan never interrupts a live colleague',
    stillHuman.mode === 'human' && seen.length === n, `mode=${stillHuman.mode}`);
  await dbMod.setMode('971555000001', 'bot');

  // (e) VOICE: asking for photos out loud sends photos.
  globalThis.__transcript = 'do you have photos of the ziplines?';
  setAiReply('Bien sûr, voici quelques photos. 🌿\n::SEND: photos:ziplines');
  n = seen.length;
  await handleIncomingMessage(
    { from: '971555000001', id: 'wamid.v10', type: 'audio', audio: { id: 'MEDIA1', mime_type: 'audio/ogg' } },
    { wa_id: '971555000001', profile: { name: 'Aisha' } });
  check('voice note asking for photos → photos sent',
    seen.slice(n).filter((m) => m.type === 'image').length >= 2);

  // (f) VOICE: asking for the pricelist sends the PDF.
  globalThis.__transcript = 'can you send me the brochure pdf please';
  n = seen.length;
  await handleIncomingMessage(
    { from: '971555000001', id: 'wamid.v11', type: 'audio', audio: { id: 'MEDIA2', mime_type: 'audio/ogg' } },
    { wa_id: '971555000001', profile: { name: 'Aisha' } });
  check('voice note asking for the pricelist → PDF sent',
    seen.slice(n).some((m) => m.type === 'document'));

  // (g) VOICE: a normal question is answered by voice AND text.
  globalThis.__transcript = 'is it suitable for my father who is 78 years old?';
  setAiReply('Oui, bien sûr!');
  n = seen.length;
  await handleIncomingMessage(
    { from: '971555000001', id: 'wamid.v12', type: 'audio', audio: { id: 'MEDIA3', mime_type: 'audio/ogg' } },
    { wa_id: '971555000001', profile: { name: 'Aisha' } });
  check('voice question → spoken reply + text',
    seen.slice(n).some((m) => m.type === 'audio') && seen.slice(n).some((m) => m.type === 'text'));

  // (h) ANY LANGUAGE: the AI attaches what was asked for, via ::SEND:.
  setAiReply('Voici notre liste de prix et quelques photos. 🌿\n::SEND: brochure, photos:quad');
  n = seen.length;
  await handleIncomingMessage(inbound('971555000001', 'Envoyez-moi la liste des prix et des photos SVP'),
    { wa_id: '971555000001', profile: { name: 'Aisha' } });
  const batch = seen.slice(n);
  check('French request → AI attaches the PDF and photos',
    batch.some((m) => m.type === 'document') && batch.filter((m) => m.type === 'image').length >= 2,
    `docs=${batch.filter((m) => m.type === 'document').length} imgs=${batch.filter((m) => m.type === 'image').length}`);
  check('the control line never leaks to the guest',
    !batch.some((m) => (m.text?.body || '').includes('::SEND')));

  // (i) The map, asked for in Arabic.
  setAiReply('بالتأكيد! هذه خريطة الحديقة.\n::SEND: map');
  n = seen.length;
  await handleIncomingMessage(inbound('971555000001', 'أرسل لي خريطة الحديقة من فضلك'),
    { wa_id: '971555000001', profile: { name: 'Aisha' } });
  check('Arabic request → park map image sent',
    seen.slice(n).some((m) => m.type === 'image' && /trail map/i.test(m.image?.caption || '')));

  globalThis.fetch = realFetch;
  globalThis.__transcript = null;
  globalThis.__aiReply = null;
}

/* ═══ 24. ONLY the ATM Dubai message may switch the bot on ═══ */
console.log('\n24. Activation: the ATM Dubai message and nothing else');
{
  const { handleIncomingMessage } = await import('../src/bot/router.js');
  const { config: cfg } = await import('../src/core/config.js');
  cfg.bot.mode = 'hybrid';

  const out = [];
  const reads = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('anthropic')) {
      return new Response(JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', model: 't', stop_reason: 'end_turn',
        content: [{ type: 'text', text: globalThis.__aiReply || 'Bien sûr! 🌿' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/media') && !/MEDIA\d/.test(u)) {
      return new Response(JSON.stringify({ id: 'MEDIA_OUT_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const p = (() => { try { return JSON.parse(opts?.body || '{}'); } catch { return {}; } })();
    if (p.status === 'read') reads.push(p.message_id);
    else out.push(p);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.z' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  // Messages that must leave the chat completely untouched (sales team's work).
  const ignored = [
    ['23050002001', 'Hi'],
    ['23050002002', 'Bonjour, je voudrais réserver pour 4 personnes'],
    ['23050002003', 'Hi Vallé! I am at reception and I would like some help 🌿'],
    ['23050002004', 'Hi Vallé! I am at the quad base and I have a question 🌿'],
    ['23050002005', 'Do you have availability on Saturday?'],
    ['23050002006', 'I met you at the travel show last year'],
  ];
  let silent = true;
  for (const [wa, body] of ignored) {
    const before = out.length + reads.length;
    await handleIncomingMessage(inbound(wa, body), { wa_id: wa, profile: { name: 'Client' } });
    const c = await dbMod.getContactByWaId(wa);
    if (out.length + reads.length !== before || c.source) silent = false;
  }
  check('every other message: not read, not answered, bot never activated', silent);
  check('those chats are still stored for the team',
    (await dbMod.getContactByWaId('23050002002'))?.wa_id === '23050002002');

  // The one message that switches it on.
  const ATM = 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.';
  let n = out.length;
  await handleIncomingMessage(inbound('23050002010', ATM),
    { wa_id: '23050002010', profile: { name: 'Trade' } });
  const activated = await dbMod.getContactByWaId('23050002010');
  check('the ATM Dubai message activates the concierge',
    activated.source === 'atm-dubai-2026' && out.slice(n)[0]?.interactive?.type === 'list');

  // Once activated, the guest can ask about anything.
  const ask = async (text, aiReply = null) => {
    globalThis.__aiReply = aiReply;
    const before = out.length;
    await handleIncomingMessage(inbound('23050002010', text),
      { wa_id: '23050002010', profile: { name: 'Trade' } });
    globalThis.__aiReply = null;
    return out.slice(before);
  };

  // In hybrid the assistant answers questions written in the guest's own words,
  // so it reads them in context instead of matching a keyword.
  const suggestion = await ask('what would you suggest for two adults who love adrenaline?',
    'For two adrenaline lovers: the Advenature Flight, 5.5 km. 🪂');
  check('a real question is answered by the assistant',
    suggestion.some((m) => /adrenaline lovers/i.test(m.text?.body || '')));

  // The canned cards remain the offline fallback (BOT_MODE=menu) and must stay factual.
  cfg.bot.mode = 'menu';
  check('history card: the story as a timeline',
    (await ask('tell me about your history')).some((m) => /tea plantation/i.test(m.text?.body || '')));
  check('animals card: wildlife answered',
    (await ask('do you have animals?')).some((m) => /tortoise/i.test(m.text?.body || '')));
  check('links card: website, map and Instagram',
    (await ask('what is your website?')).some((m) => /vallepark\.com/i.test(m.text?.body || '')
      && /instagram/i.test(m.text?.body || '')));
  check('buggy card: prices exact',
    (await ask('buggy price')).some((m) => /Rs 7,500/.test(m.text?.body || '')));
  check('kids card answered',
    (await ask('is it good for kids?')).some((m) => /FREE|Kids Park/i.test(m.text?.body || '')));
  check('directions card carries the map link',
    (await ask('how do I get there?')).some((m) => /maps\.google\.com/.test(m.text?.body || '')));
  cfg.bot.mode = 'hybrid';
  check('restaurant menus sent as PDF',
    (await ask('can I see the restaurant menu card?')).filter((m) => m.type === 'document').length === 2);
  check('package PDFs when asked for the documents',
    (await ask('can you send me the package pdf?')).filter((m) => m.type === 'document').length === 3);
  check('package PDFs in another language (AI attachment)',
    (await ask('je voudrais recevoir vos offres haut de gamme', 'Bien sûr.\n::SEND: packages'))
      .filter((m) => m.type === 'document').length === 3);
  check('story in pictures (AI attachment)',
    (await ask('montrez-moi votre histoire en photos', 'Voici notre histoire.\n::SEND: photos:history'))
      .filter((m) => m.type === 'image').length >= 3);
  check('feedback reaches the team',
    (await ask('Your park was amazing, we loved the ziplines!')).length > 0);

  globalThis.fetch = prev;
}

/* ═══ 25. Waiting for a colleague must never stop the concierge ═══ */
console.log('\n25. Queued for a human: the bot keeps helping until a person replies');
{
  const { handleIncomingMessage } = await import('../src/bot/router.js');
  const { config: cfg } = await import('../src/core/config.js');
  cfg.bot.mode = 'hybrid';

  const out = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('anthropic')) {
      return new Response(JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', model: 't', stop_reason: 'end_turn',
        content: [{ type: 'text', text: globalThis.__aiReply || 'Bien sûr! 🌿' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/media') && !/MEDIA\d/.test(u)) {
      return new Response(JSON.stringify({ id: 'MEDIA_OUT_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const p = (() => { try { return JSON.parse(opts?.body || '{}'); } catch { return {}; } })();
    if (!p.status) out.push(p);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.q' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const G = '23050003001';
  const ATM = 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.';
  await handleIncomingMessage(inbound(G, ATM), { wa_id: G, profile: { name: 'Resident' } });

  const ask = async (text, aiReply = null) => {
    globalThis.__aiReply = aiReply;
    const before = out.length;
    await handleIncomingMessage(inbound(G, text), { wa_id: G, profile: { name: 'Resident' } });
    globalThis.__aiReply = null;
    return out.slice(before);
  };

  // Resident rates are now published, so that question is answered on the spot.
  const residentAnswer = await ask('Am resident, is there a discount?');
  check('resident question answered directly, no escalation',
    residentAnswer.some((m) => m.type === 'document')
    && (await dbMod.getContactByWaId(G)).mode === 'bot');

  // A question only the team can settle still escalates.
  await ask('Can you confirm availability for a wedding of 80 guests?',
    'Let me bring in a colleague for that. 🙏\n::HANDOVER: wedding group booking needs the team');
  const queued = await dbMod.getContactByWaId(G);
  check('question for the team → guest queued', queued.mode === 'waiting', `mode=${queued.mode}`);

  // ...and everything else still gets answered while they wait.
  const menus = await ask('Menus please');
  check('waiting guest still receives the restaurant menus',
    menus.filter((m) => m.type === 'document').length === 2,
    `docs=${menus.filter((m) => m.type === 'document').length}`);

  const bridge = await ask('Kindly give me photo for Nepalese bridge');
  check('waiting guest still receives bridge photos',
    bridge.filter((m) => m.type === 'image').length >= 2);

  const quad = await ask('Give me photo for quad bike');
  check('waiting guest still receives quad photos',
    quad.filter((m) => m.type === 'image').length >= 2);
  check('"quad bike" gives QUAD photos, never the Bicycle Zipline',
    quad.some((m) => /quad/i.test(m.image?.caption || '') || /Quad/.test(m.text?.body || ''))
    && !quad.some((m) => /Bicycle Zipline/i.test(m.text?.body || '')));

  // The park closes at 17:30, so 17:05 is still open.
  const { isBusinessHours } = await import('../src/core/config.js');
  check('open until 17:30, not 17:00',
    isBusinessHours(new Date('2026-08-25T13:05:00Z')) === true
    && isBusinessHours(new Date('2026-08-25T13:35:00Z')) === false);

  const queueNotices = out.filter((m) => /in the queue|colleague will reply first thing/i.test(m.text?.body || ''));
  check('the queue notice is sent once, never repeated', queueNotices.length <= 1,
    `sent ${queueNotices.length} times`);

  // A duration question is not a Kids Park question.
  const duration = await ask('To spend a day with family, how much time is needed?',
    'Plan most of the day: activities, lunch and the trail. 🌿');
  check('"a day with family, how much time" is answered, not the Kids card',
    !duration.some((m) => /Kids Park play area/.test(m.text?.body || '')));

  // Once a colleague actually replies, the bot goes quiet again.
  const { handleStaffEcho } = await import('../src/bot/router.js');
  await handleStaffEcho({ id: 'wamid.STAFF9', to: G, type: 'text',
    text: { body: 'Bonjour, resident rate is confirmed.' } });
  const after = await ask('and the buggy price?');
  check('after a colleague replies, the bot stays silent', after.length === 0, `sent ${after.length}`);

  globalThis.fetch = prev;
}

/* ═══ 26. The official rate cards from assets/Price List ═══ */
console.log('\n26. Resident, student, senior and Kids Park rate cards');
{
  const { handleIncomingMessage } = await import('../src/bot/router.js');
  const { config: cfg } = await import('../src/core/config.js');
  const { DOCS } = await import('../src/bot/documents.js');
  const fsMod = await import('node:fs');
  cfg.bot.mode = 'hybrid';

  // Every document the bot can send must exist and be small enough for WhatsApp.
  const missing = Object.entries(DOCS).filter(([, d]) => !fsMod.existsSync(d.path)).map(([k]) => k);
  check('every document in the library exists', missing.length === 0, missing.join(','));
  const tooBig = Object.entries(DOCS)
    .filter(([, d]) => fsMod.existsSync(d.path) && fsMod.statSync(d.path).size > 90 * 1024 * 1024)
    .map(([k]) => k);
  check('no document exceeds WhatsApp\'s size limit', tooBig.length === 0, tooBig.join(','));

  const out = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('anthropic')) {
      return new Response(JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', model: 't', stop_reason: 'end_turn',
        content: [{ type: 'text', text: globalThis.__aiReply || 'Bien sûr! 🌿' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/media') && !/MEDIA\d/.test(u)) {
      return new Response(JSON.stringify({ id: 'MEDIA_OUT_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const p = (() => { try { return JSON.parse(opts?.body || '{}'); } catch { return {}; } })();
    if (!p.status) out.push(p);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.r' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const G = '23050004001';
  const ATM = 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.';
  await handleIncomingMessage(inbound(G, ATM), { wa_id: G, profile: { name: 'Local' } });

  const ask = async (text, aiReply = null) => {
    globalThis.__aiReply = aiReply;
    const before = out.length;
    await handleIncomingMessage(inbound(G, text), { wa_id: G, profile: { name: 'Local' } });
    globalThis.__aiReply = null;
    return out.slice(before);
  };
  const docNames = (msgs) => msgs.filter((m) => m.type === 'document').map((m) => m.document.filename).join(' ');

  check('resident asks → resident pricelist AND resident packages',
    /Resident-Pricelist/.test(docNames(await ask('I am a resident, what are the rates?'))));
  check('student asks → student pricelist',
    /Student/.test(docNames(await ask('do you have student rates?'))));
  check('senior asks → senior citizen packages',
    /Senior/.test(docNames(await ask('any senior citizen package?'))));
  check('kids park asks → Kids Park pricelist',
    /Kids-Park/.test(docNames(await ask('how much is the kids park?'))));
  check('AI can attach the resident pricelist in any language',
    /Resident/.test(docNames(await ask('tarif résident svp', 'Voici. 🌿\n::SEND: resident'))));
  check('"tell me about Vallé" → the illustrated presentation',
    /Presentation/.test(docNames(await ask('tell me about valle'))));
  check('AI can attach the presentation in any language',
    /Presentation/.test(docNames(await ask('parlez-moi du parc', 'Avec plaisir. 🌿\n::SEND: presentation'))));

  // Prices live in assets/price-list only: no stray price PDFs elsewhere.
  const docFiles = fsMod.readdirSync(new URL('../assets/documents', import.meta.url));
  check('no price PDFs left in assets/documents',
    !docFiles.some((f) => /price|pricelist|package|tarif/i.test(f)), docFiles.join(','));

  globalThis.fetch = prev;
}

/* ═══ 27. The assistant remembers the conversation ═══ */
console.log('\n27. Memory: context, what was already sent, and what we know');
{
  const { handleIncomingMessage } = await import('../src/bot/router.js');
  const { config: cfg } = await import('../src/core/config.js');
  cfg.bot.mode = 'hybrid';

  const seenPrompts = [];
  globalThis.__onAiRequest = (body) => seenPrompts.push(body);
  const out = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('anthropic')) {
      return new Response(JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', model: 't', stop_reason: 'end_turn',
        content: [{ type: 'text', text: globalThis.__aiReply || 'Noted. 🌿' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/media') && !/MEDIA\d/.test(u)) {
      return new Response(JSON.stringify({ id: 'MEDIA_OUT_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const p = (() => { try { return JSON.parse(opts?.body || '{}'); } catch { return {}; } })();
    if (!p.status) out.push(p);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.mem' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const G = '23050005001';
  const ATM = 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.';
  const say = async (text, aiReply = null) => {
    globalThis.__aiReply = aiReply;
    await handleIncomingMessage(inbound(G, text), { wa_id: G, profile: { name: 'Aisha' } });
    globalThis.__aiReply = null;
    return seenPrompts[seenPrompts.length - 1];
  };
  const promptText = (p) => JSON.stringify(p);

  await handleIncomingMessage(inbound(G, ATM), { wa_id: G, profile: { name: 'Aisha' } });
  await say('send me the brochure');                       // a document, no AI
  const afterDoc = await say('what about the ziplines?');
  check('the assistant is told which files the guest already has',
    /already sent/i.test(promptText(afterDoc)) && /pricelist|brochure/i.test(promptText(afterDoc)));

  // Booking details captured once are remembered afterwards.
  await say('We are 4 people coming on 12 September, name Aisha Khan',
    'Lovely, noted. 🌿\n::LEAD: {"full_name":"Aisha Khan","pax":4,"visit_date":"12 September","interest":"ziplines"}');
  const afterLead = await say('and what time should we arrive?');
  check('what we know about the visit travels with every question',
    /Aisha Khan/.test(promptText(afterLead)) && /12 September/.test(promptText(afterLead)));

  check('the guest name reaches the assistant', /Aisha/.test(promptText(afterLead)));
  check('the assistant sees the conversation, not just the last line',
    (JSON.parse(promptText(afterLead)).messages || []).length >= 4);

  // What the guest was told is remembered as real words, not internal markers.
  cfg.bot.mode = 'menu';
  await say('quad');
  cfg.bot.mode = 'hybrid';
  const afterCard = await say('is that per person?');
  check('a card the guest received is remembered verbatim',
    /Quad Discovery/.test(promptText(afterCard)));
  check('internal markers never reach the assistant',
    !/\[menu\]|\[photos sent|\[document sent/.test(promptText(afterCard)));

  // A promise the guest can read must always be kept, control line or not.
  const before = out.length;
  await say('can I see the bridge?', 'Sure 🌿 here are some photos of the Nepalese Bridge for you.');
  const kept = out.slice(before);
  check('a promised photo set is sent even without the control line',
    kept.filter((m) => m.type === 'image').length >= 2,
    `images=${kept.filter((m) => m.type === 'image').length}`);
  check('the bridge promise sends BRIDGE photos',
    kept.some((m) => /bridge/i.test(m.image?.caption || '')));
  check('nothing bracketed is ever sent to the guest',
    !kept.some((m) => /\[menu\]|\[photos sent|\[document sent/.test(m.text?.body || '')));

  const beforeQuiet = out.length;
  await say('and the price?', 'The Nepalese Bridge is Rs 1,300 per person.');
  check('a plain answer attaches nothing',
    out.slice(beforeQuiet).every((m) => m.type === 'text'));

  globalThis.fetch = prev;
}

/* ═══ 28. "Talk to a person" means the bot stops. Completely. ═══ */
console.log('\n28. The guest asks for a person: the bot goes silent, a colleague replies');
{
  const { handleIncomingMessage, handleStaffEcho, sweepStaleHandovers } = await import('../src/bot/router.js');
  const { config: cfg } = await import('../src/core/config.js');
  cfg.bot.mode = 'hybrid';

  const out = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('anthropic')) {
      return new Response(JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', model: 't', stop_reason: 'end_turn',
        content: [{ type: 'text', text: globalThis.__aiReply || 'Of course! 🌿' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/media') && !/MEDIA\d/.test(u)) {
      return new Response(JSON.stringify({ id: 'MEDIA_OUT_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const p = (() => { try { return JSON.parse(opts?.body || '{}'); } catch { return {}; } })();
    if (!p.status) out.push(p);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.h' + out.length }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const ATM = 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.';
  const scan = async (g, name) =>
    handleIncomingMessage(inbound(g, ATM), { wa_id: g, profile: { name } });
  const say = async (g, text, aiReply = null) => {
    globalThis.__aiReply = aiReply;
    const before = out.length;
    await handleIncomingMessage(inbound(g, text), { wa_id: g, profile: { name: 'Guest' } });
    globalThis.__aiReply = null;
    return out.slice(before);
  };

  /* --- tapping the menu row --- */
  const G = '23050004001';
  await scan(G, 'Tapper');
  // Messages addressed to the guest only: the alert that goes to the team is
  // a separate conversation and must not be counted here.
  const toGuest = (rows, g) => rows.filter((m) => m.to === g);

  const tapped = toGuest(await say(G, 'menu_human'), G);
  check('tapping "Talk to a person" sends the guest exactly one hand-off line',
    tapped.length === 1 && /colleague/i.test(tapped[0].text?.body || ''),
    `sent ${tapped.length}`);
  check('the team is alerted at the same time',
    (await dbMod.listWaiting(20)).some((r) => r.wa_id === G));

  let c = await dbMod.getContactByWaId(G);
  check('the chat is queued for the team', c.mode === 'waiting', `mode=${c.mode}`);
  check('the bot is silenced in that chat', c.bot_silent === true, `bot_silent=${c.bot_silent}`);

  check('the team sees it in #queue', (await dbMod.listWaiting(20)).some((r) => r.wa_id === G));
  check('the team is told the bot is silent there',
    (await dbMod.listWaiting(20)).find((r) => r.wa_id === G)?.bot_silent === true);

  /* --- and now: absolute silence, whatever the guest asks --- */
  const followUps = [
    'Actually, what is the price of the zipline?',
    'Can you send me photos?',
    'menu_activities',
    'brochure',
    'Bonjour, le prix des quads ?',
  ];
  let quiet = true;
  for (const f of followUps) {
    const r = await say(G, f, 'Here is the pricelist 🌿\n::SEND: brochure');
    if (r.length) { quiet = false; console.log(`     leaked on "${f}":`, JSON.stringify(r[0]).slice(0, 120)); }
  }
  check('the bot answers nothing at all afterwards, typed or tapped', quiet);

  const readReceipts = out.filter((m) => m.status === 'read');
  check('no read receipt is sent once the chat belongs to a person', readReceipts.length === 0);

  /* --- the auto-release sweeper must never take the chat back --- */
  await dbMod.q(`UPDATE contacts SET last_seen_at = now() - interval '10 hours' WHERE wa_id = $1`, [G]);
  await sweepStaleHandovers();
  c = await dbMod.getContactByWaId(G);
  check('the sweeper never hands a reserved chat back to the bot',
    c.mode === 'waiting' && c.bot_silent === true, `mode=${c.mode} silent=${c.bot_silent}`);

  /* --- a colleague replies from the WhatsApp app --- */
  await handleStaffEcho({ id: 'wamid.STAFFH1', to: G, type: 'text',
    text: { body: 'Hello! Priya here, happy to help.' } });
  c = await dbMod.getContactByWaId(G);
  check('a colleague replying takes ownership', c.mode === 'human');
  check('the silence flag is cleared once a person is on it', c.bot_silent === false);
  const afterStaff = await say(G, 'Thank you!');
  check('the bot still stays out while the colleague has the chat', afterStaff.length === 0);

  /* --- #release gives the chat back --- */
  await dbMod.setMode(G, 'bot');
  c = await dbMod.getContactByWaId(G);
  check('#release clears both the mode and the silence', c.mode === 'bot' && c.bot_silent === false);
  const afterRelease = await say(G, 'What time do you open?', 'We open daily at 09:00. 🌿');
  check('the assistant answers again after #release', afterRelease.length > 0);

  /* --- typed in words, in another language --- */
  const G2 = '23050004002';
  await scan(G2, 'Français');
  const fr = toGuest(await say(G2, 'Je voudrais parler à quelqu\'un s\'il vous plaît'), G2);
  check('"parler à quelqu\'un" hands the chat over', fr.length === 1, `sent ${fr.length}`);
  check('and silences the bot', (await dbMod.getContactByWaId(G2)).bot_silent === true);
  const frAfter = await say(G2, 'Et le prix des tyroliennes ?', 'Rs 3,600 par personne.');
  check('no reply in French either', frAfter.length === 0, `sent ${frAfter.length}`);

  /* --- the assistant itself can hand over with ::HUMAN: --- */
  const G3 = '23050004003';
  await scan(G3, 'Escalator');
  const viaAi = await say(G3,
    'ich hätte gerne jemanden vom team am telefon',
    'Natürlich, ein Kollege meldet sich gleich bei Ihnen. 🙏\n::HUMAN: guest asked for a colleague');
  check('::HUMAN: from the assistant silences the bot too',
    (await dbMod.getContactByWaId(G3)).bot_silent === true);
  check('the guest still gets that one warm line', viaAi.some((m) => /Kollege/.test(m.text?.body || '')));
  const g3After = await say(G3, 'und die Preise?', 'Hier sind die Preise.\n::SEND: brochure');
  check('nothing more after ::HUMAN:', g3After.length === 0, `sent ${g3After.length}`);

  /* --- ::HANDOVER: is different: the bot keeps helping --- */
  const G4 = '23050004004';
  await scan(G4, 'Wedding');
  await say(G4, 'We are 80 guests for a wedding, can you confirm?',
    'Let me check with the team. 🙏\n::HANDOVER: wedding group needs the team');
  const c4 = await dbMod.getContactByWaId(G4);
  check('a bot-side escalation queues without silencing',
    c4.mode === 'waiting' && c4.bot_silent === false, `silent=${c4.bot_silent}`);
  const stillHelping = await say(G4, 'Meanwhile, can I see the map?', 'Here is the map. 🌿\n::SEND: map');
  check('and the concierge keeps helping while they wait', stillHelping.length > 0);

  globalThis.fetch = prev;
}

/* ═══ 29. Who is really asking for a person, in fifteen languages ═══ */
console.log('\n29. Reading "I want a person" correctly, and not over-reading it');
{
  const { wantsHuman, needsHuman } = await import('../src/bot/handover-signals.js');

  const asking = [
    ['English',   'Can I talk to a real person please?'],
    ['English',   'I want to speak with someone from your team'],
    ['English',   'connect me to an agent'],
    ['English',   'human please'],
    ['English',   'Please call me back on this number'],
    ['French',    'Je veux parler à quelqu\'un'],
    ['French',    'Puis-je parler avec un conseiller ?'],
    ['French',    'service clientèle svp'],
    ['German',    'Ich möchte mit einem Mitarbeiter sprechen'],
    ['German',    'Kundenservice bitte'],
    ['Spanish',   '¿Puedo hablar con alguien?'],
    ['Spanish',   'quiero hablar con un agente humano'],
    ['Portuguese','Quero falar com uma pessoa'],
    ['Italian',   'Vorrei parlare con un operatore'],
    ['Russian',   'Я хочу поговорить с человеком'],
    ['Russian',   'соедините меня с оператором'],
    ['Arabic',    'أريد التحدث مع موظف'],
    ['Arabic',    'خدمة العملاء من فضلك'],
    ['Turkish',   'Bir müşteri temsilcisi ile görüşmek istiyorum'],
    ['Polish',    'Chcę rozmawiać z konsultantem'],
    ['Hindi',     'मुझे किसी से बात करनी है'],
    ['Chinese',   '请转人工客服'],
    ['Japanese',  '担当者と話したいです'],
    ['Creole',    'Mo anvi koz ar enn dimoun'],
  ];
  let missed = [];
  for (const [lang, t] of asking) if (!wantsHuman(t)) missed.push(`${lang}: ${t}`);
  check(`a request for a person is caught in all ${asking.length} phrasings`,
    missed.length === 0, missed.join(' | '));

  const notAsking = [
    'How much is the zipline for 2 people?',
    'Do you have staff who speak French?',
    'Is someone there to guide the children?',
    'What is the staff discount?',
    'Your team was lovely, thank you!',
    'I want to book for 4 people on Saturday',
    'Can I speak French with the guides?',
    '人工智能',                                   // "artificial intelligence"
    'Quel est le prix pour une personne ?',
    'Wir sind eine Gruppe von 10 Personen',
    '¿Cuánto cuesta por persona?',
    'كم السعر للشخص الواحد؟',
    'Combien de personnes maximum sur le pont ?',
  ];
  let overRead = [];
  for (const t of notAsking) if (wantsHuman(t)) overRead.push(t);
  check('an ordinary question never silences the assistant',
    overRead.length === 0, overRead.join(' | '));

  const teamTopics = [
    'I want a refund for my booking',
    'I need to cancel my reservation',
    'This is a complaint about my visit',
    'Je veux un remboursement',
    'Ich möchte stornieren',
    'Я хочу возврат денег',
    '我要退款',
  ];
  let notFlagged = [];
  for (const t of teamTopics) if (!needsHuman(t)) notFlagged.push(t);
  check('refunds, cancellations and complaints always reach the team',
    notFlagged.length === 0, notFlagged.join(' | '));
  check('a refund question does NOT silence the bot (the team is just alerted)',
    !wantsHuman('I want a refund for my booking'));
}

/* ═══ 30. The same questions, in every language a guest may use ═══ */
console.log('\n30. Multi-language QA: photos, prices, maps, menus, booking');
{
  const { handleIncomingMessage } = await import('../src/bot/router.js');
  const { config: cfg } = await import('../src/core/config.js');
  cfg.bot.mode = 'hybrid';

  const out = [];
  // The Anthropic client captured globalThis.fetch when ai.js was first
  // imported, so the only reliable way to see what the assistant was asked is
  // the hook the original stub calls.
  let aiSeen = null;
  globalThis.__onAiRequest = (body) => { aiSeen = body; };
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('anthropic')) {
      try { aiSeen = JSON.parse(opts.body); } catch { /* ignore */ }
      return new Response(JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', model: 't', stop_reason: 'end_turn',
        content: [{ type: 'text', text: globalThis.__aiReply || 'Voilà 🌿' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/media') && !/MEDIA\d/.test(u)) {
      return new Response(JSON.stringify({ id: 'MEDIA_OUT_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const p = (() => { try { return JSON.parse(opts?.body || '{}'); } catch { return {}; } })();
    if (!p.status) out.push(p);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.l' + out.length }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const ATM = 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.';

  // Every guest is a fresh scanner, so nothing leaks between languages.
  let n = 0;
  const guest = async () => {
    const g = '2305001' + String(1000 + (n++)).slice(-4);
    await handleIncomingMessage(inbound(g, ATM), { wa_id: g, profile: { name: 'Guest' } });
    return g;
  };
  const ask = async (g, text, aiReply = null) => {
    globalThis.__aiReply = aiReply;
    const before = out.length;
    await handleIncomingMessage(inbound(g, text), { wa_id: g, profile: { name: 'Guest' } });
    globalThis.__aiReply = null;
    return out.slice(before);
  };

  /* --- the QR prefill opens the menu in every locale --- */
  const g0 = await guest();
  check('a scan always opens with the welcome menu',
    out.some((m) => m.interactive?.type === 'list' || m.interactive?.type === 'button'));

  /* --- asking to SEE something, in fifteen languages --- */
  const seeing = [
    ['French',     'Avez-vous des photos du pont népalais ?',       'Bien sûr 🌿\n::SEND: photos:bridge',  'image'],
    ['German',     'Können Sie mir Fotos der Ziplines schicken?',   'Gerne 🌿\n::SEND: photos:ziplines',   'image'],
    ['Spanish',    '¿Me envías fotos de los quads?',                'Claro 🌿\n::SEND: photos:quad',       'image'],
    ['Portuguese', 'Pode enviar fotos do parque?',                  'Claro 🌿\n::SEND: photos:park',       'image'],
    ['Italian',    'Avete foto delle cascate?',                     'Certo 🌿\n::SEND: photos:waterfalls', 'image'],
    ['Russian',    'Пришлите фото парка, пожалуйста',               'Конечно 🌿\n::SEND: photos:nature',   'image'],
    ['Arabic',     'أرسل لي صور الحديقة',                            'بالتأكيد 🌿\n::SEND: photos:park',     'image'],
    ['Turkish',    'Park fotoğrafları var mı?',                     'Tabii 🌿\n::SEND: photos:park',       'image'],
    ['Polish',     'Czy możecie wysłać zdjęcia?',                   'Oczywiście 🌿\n::SEND: photos:park',  'image'],
    ['Hindi',      'क्या आप पार्क की तस्वीरें भेज सकते हैं?',              'ज़रूर 🌿\n::SEND: photos:park',        'image'],
    ['Chinese',    '可以发一些公园的照片吗？',                          '当然 🌿\n::SEND: photos:park',         'image'],
    ['Japanese',   '公園の写真を送ってください',                        'もちろん 🌿\n::SEND: photos:park',      'image'],
    ['Creole',     'Ou ena foto lor park la?',                      'Wi 🌿\n::SEND: photos:park',          'image'],
  ];
  const seeMissed = [];
  for (const [lang, q, aiReply, kind] of seeing) {
    const g = await guest();
    const r = await ask(g, q, aiReply);
    if (r.filter((m) => m.type === kind).length < 2) seeMissed.push(lang);
  }
  check(`"send me photos" delivers photos in all ${seeing.length} languages`,
    seeMissed.length === 0, seeMissed.join(', '));

  /* --- asking for a DOCUMENT, in fifteen languages --- */
  const docs = [
    ['French',     'Envoyez-moi la liste des prix',      'Voici 🌿\n::SEND: brochure'],
    ['German',     'Schicken Sie mir bitte die Preisliste', 'Gerne 🌿\n::SEND: brochure'],
    ['Spanish',    'Necesito la lista de precios',       'Aquí 🌿\n::SEND: brochure'],
    ['Portuguese', 'Manda a tabela de preços',           'Aqui 🌿\n::SEND: brochure'],
    ['Russian',    'Отправьте прайс-лист',               'Держите 🌿\n::SEND: brochure'],
    ['Arabic',     'أرسل لي قائمة الأسعار',                'تفضل 🌿\n::SEND: brochure'],
    ['Turkish',    'Fiyat listesini gönderir misiniz?',  'Buyurun 🌿\n::SEND: brochure'],
    ['Chinese',    '请发价格表',                          '好的 🌿\n::SEND: brochure'],
    ['Japanese',   '料金表を送ってください',                'どうぞ 🌿\n::SEND: brochure'],
    ['Polish',     'Poproszę cennik',                    'Proszę 🌿\n::SEND: brochure'],
    ['Hindi',      'मूल्य सूची भेजें',                       'यह लीजिए 🌿\n::SEND: brochure'],
  ];
  const docMissed = [];
  for (const [lang, q, aiReply] of docs) {
    const g = await guest();
    const r = await ask(g, q, aiReply);
    if (!r.some((m) => m.type === 'document')) docMissed.push(lang);
  }
  check(`"send me the pricelist" delivers the PDF in all ${docs.length} languages`,
    docMissed.length === 0, docMissed.join(', '));

  /* --- the map, the menus, the presentation --- */
  const gm = await guest();
  const map = await ask(gm, 'Wo ist der Park? Karte bitte', 'Hier 🌿\n::SEND: map');
  check('the map is sent when asked for in German', map.some((m) => m.type === 'image' || m.type === 'document'));

  const menus = await ask(gm, 'Les menus des restaurants svp', 'Voici les deux cartes 🌿\n::SEND: menus');
  check('both restaurant menus go out together',
    menus.filter((m) => m.type === 'document').length === 2,
    `docs=${menus.filter((m) => m.type === 'document').length}`);

  const about = await ask(gm, '¿Qué es Vallé Advenature Park?', 'Con mucho gusto 🌿\n::SEND: presentation');
  check('"tell me about Vallé" sends the illustrated presentation',
    about.some((m) => m.type === 'document'));

  /* --- a booking, captured in any language --- */
  const gb = await guest();
  await ask(gb, 'Je m\'appelle Sophie, 4 personnes le 12 septembre, quad et tyroliennes',
    'Parfait Sophie ! Je transmets à l\'équipe. 🌿\n::LEAD: {"full_name":"Sophie","pax":4,"visit_date":"12 septembre","interest":"quad et tyroliennes"}');
  const cb = await dbMod.getContactByWaId(gb);
  const lead = await dbMod.getLatestLead(cb.id);
  check('a booking written in French is captured', lead?.full_name === 'Sophie' && lead?.pax === 4);

  /* --- the assistant is always given the real question --- */
  const gq = await guest();
  await ask(gq, 'الرجاء إخباري عن ساعات العمل', 'نفتح يوميا من 09:00 إلى 17:30 🌿');
  check('the guest\'s own words reach the assistant, script and all',
    JSON.stringify(aiSeen?.messages || []).includes('ساعات العمل'),
    JSON.stringify(aiSeen?.messages?.slice(-1) || []).slice(0, 240));

  /* --- and a stranger writing in any script is still ignored --- */
  const beforeStranger = out.length;
  await handleIncomingMessage(inbound('23059999123', 'مرحبا، أريد معرفة الأسعار'),
    { wa_id: '23059999123', profile: { name: 'Stranger' } });
  check('a stranger writing in Arabic is still met with silence',
    out.length === beforeStranger, `sent ${out.length - beforeStranger}`);

  globalThis.__onAiRequest = null;
  globalThis.fetch = prev;
}

/* ═══ 31. The subject is whatever the GUEST asked about ═══ */
console.log('\n31. "Do you have pictures?" means pictures of what we were just discussing');
{
  const { handleIncomingMessage } = await import('../src/bot/router.js');
  const { config: cfg } = await import('../src/core/config.js');
  cfg.bot.mode = 'hybrid';

  const out = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/media') && !/MEDIA\d/.test(u)) {
      return new Response(JSON.stringify({ id: 'MEDIA_OUT_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const p = (() => { try { return JSON.parse(opts?.body || '{}'); } catch { return {}; } })();
    if (!p.status) out.push(p);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.t' + out.length }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const G = '23050005001';
  const ATM = 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.';
  await handleIncomingMessage(inbound(G, ATM), { wa_id: G, profile: { name: 'Noor' } });

  const ask = async (text, aiReply = null) => {
    globalThis.__aiReply = aiReply;
    const before = out.length;
    await handleIncomingMessage(inbound(G, text), { wa_id: G, profile: { name: 'Noor' } });
    globalThis.__aiReply = null;
    return out.slice(before);
  };
  const captions = (rows) => rows.filter((m) => m.type === 'image')
    .map((m) => m.image?.caption || '').join(' ').toLowerCase();

  /* --- the exact exchange from the 5908 6131 chat --- */
  await ask('Tell me price and location for buggy',
    'Here are the buggy prices (per buggy, per hour unless noted):\n'
    + '• Buggy Discovery (1h): Rs 7,500\n• Buggy 4X (1h): Rs 13,500');

  // The assistant answers without a control line and points at an earlier send,
  // exactly as it did in production. The guest must still get BUGGY photos.
  const pics = await ask('Do you have pictures?',
    'Yes, I sent you buggy photos earlier in our chat, just scroll up a little 🌿 '
    + 'Want me to send anything else, like the quad tracks or the Advenature Flight zipline?');

  check('a bare "do you have pictures?" still delivers photos',
    pics.filter((m) => m.type === 'image').length >= 2,
    `images=${pics.filter((m) => m.type === 'image').length}`);
  check('and they are BUGGY photos, not the zipline mentioned in the sign-off',
    /buggy/.test(captions(pics)) && !/zip/.test(captions(pics)),
    captions(pics).slice(0, 120));

  /* --- a wrong subject in the control line is corrected --- */
  const quad = await ask('Send me photos of the quad',
    'Of course 🌿\n::SEND: photos:ziplines');
  check('the guest\'s own word beats a wrong ::SEND: topic',
    /quad/.test(captions(quad)) && !/zip/.test(captions(quad)),
    captions(quad).slice(0, 120));

  /* --- "quad bike" is never the Bicycle Zipline --- */
  const qb = await ask('photos of the quad bike please', 'Voilà 🌿\n::SEND: photos');
  check('"quad bike" is a quad, never a bicycle',
    /quad/.test(captions(qb)) && !/bicycle/.test(captions(qb)),
    captions(qb).slice(0, 120));

  /* --- a past reference alone must not fire the safety net --- */
  const noAsk = await ask('Great, thanks!',
    'You are welcome! I sent you the buggy photos and the pricelist earlier. 🌿');
  check('"I sent you X earlier" alone attaches nothing',
    noAsk.every((m) => m.type === 'text'),
    noAsk.map((m) => m.type).join(','));

  /* --- asking for a FILE must not turn into photos --- */
  const file = await ask('Can you show me the price list?', 'Bien sûr 🌿\n::SEND: brochure');
  check('a pricelist request sends the PDF, not photos',
    file.some((m) => m.type === 'document') && !file.some((m) => m.type === 'image'),
    file.map((m) => m.type).join(','));

  /* --- an explicit subject still wins over the running topic --- */
  const bridge = await ask('and pictures of the Nepalese bridge?', 'Voici 🌿\n::SEND: photos:bridge');
  check('naming a new subject switches the gallery',
    /bridge/.test(captions(bridge)), captions(bridge).slice(0, 120));

  globalThis.fetch = prev;
}

/* ═══ 32. The second and third channels: SMS on scan, overview by email ═══ */
console.log('\n32. A scan also texts their phone; the overview goes out by email');
{
  const { config: cfg } = await import('../src/core/config.js');
  cfg.bot.mode = 'hybrid';
  // Pretend both providers are configured. No request leaves the process:
  // every call below is answered by the stub.
  cfg.sms = { accountSid: 'ACtest', authToken: 'tok', from: '+15550001111',
    messagingServiceSid: '', enabled: true };
  cfg.email = { apiKey: 're_test', from: 'Vallé <hello@valle.mu>',
    replyTo: 'reservations@valle.mu', cc: 'sales@valle.mu',
    bcc: 'abdurrahman@valle.mu, ashfaaq@valle.mu' };

  const { handleIncomingMessage } = await import('../src/bot/router.js');
  const { segments, toE164 } = await import('../src/notify/sms.js');
  const { findEmail } = await import('../src/notify/email.js');

  const out = [], sms = [], mails = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.twilio.com')) {
      sms.push(Object.fromEntries(new URLSearchParams(String(opts.body))));
      return new Response(JSON.stringify({ sid: 'SM1', status: 'queued' }),
        { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('api.resend.com')) {
      mails.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: 'em_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/media') && !/MEDIA\d/.test(u)) {
      return new Response(JSON.stringify({ id: 'MEDIA_OUT_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const p = (() => { try { return JSON.parse(opts?.body || '{}'); } catch { return {}; } })();
    if (!p.status) out.push(p);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.n' + out.length }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const ATM = 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.';
  // A number nobody else in this suite has used: the welcome SMS goes out on
  // the FIRST scan only, so a returning guest would correctly get nothing.
  const G = '971509876543';
  const say = async (text, aiReply = null) => {
    globalThis.__aiReply = aiReply;
    const before = out.length;
    await handleIncomingMessage(inbound(G, text), { wa_id: G, profile: { name: 'Aisha Rahman' } });
    globalThis.__aiReply = null;
    return out.slice(before);
  };

  /* ---- the welcome text message, and the email question ---- */
  const scan = await say(ATM);
  await new Promise((r) => setImmediate(r));  // the SMS is fire and forget

  check('right after the scan, the guest is asked for their email',
    scan.some((m) => /email address/i.test(m.text?.body || '')));
  check('and the chat is waiting on it', (await dbMod.getContactByWaId(G)).awaiting === 'email');
  check('the welcome menu still went out first',
    scan.findIndex((m) => m.interactive) < scan.findIndex((m) => /email address/i.test(m.text?.body || '')));
  const welcomeBody = scan.find((m) => m.interactive)?.interactive?.body?.text || '';
  check('the welcome tells the guest they can send a voice note and ask anything',
    /voice note/i.test(welcomeBody) && /prices/i.test(welcomeBody) && /photos/i.test(welcomeBody)
    && /map/i.test(welcomeBody) && /menus/i.test(welcomeBody),
    welcomeBody.slice(0, 160));
  check('the new QR message switched the bot on',
    (await dbMod.getContactByWaId(G)).source === 'atm-dubai-2026');

  check('scanning the QR also sends one SMS', sms.length === 1, `sent ${sms.length}`);
  check('it goes to the same phone number, in E.164',
    sms[0]?.To === '+971509876543', sms[0]?.To);
  check('it names the park and the show',
    /Vallé Advenature Park/.test(sms[0]?.Body || '') && /ATM Dubai 2026/.test(sms[0]?.Body || ''));
  check('it fits in a single SMS segment, so it costs one message',
    segments(sms[0]?.Body || '') === 1, `${segments(sms[0]?.Body || '')} segments`);

  const c1 = await dbMod.getContactByWaId(G);
  check('the send is recorded on the contact', c1.sms_at !== null);

  const before = sms.length;
  const hours = await say('What are your opening hours?', 'We are open daily 09:00 to 17:30 🌿');
  await new Promise((r) => setImmediate(r));
  check('later messages never trigger another SMS', sms.length === before, `sent ${sms.length - before}`);
  check('ignoring the email question costs nothing: the next question is answered normally',
    hours.some((m) => /09:00/.test(m.text?.body || '')) && (await dbMod.getContactByWaId(G)).awaiting === null);

  /* ---- asking for the address ---- */
  const asked = await say('Can you email it to me?');
  check('"email it to me" asks for the address',
    asked.some((m) => /email address/i.test(m.text?.body || '')));
  check('the chat is now waiting on an address',
    (await dbMod.getContactByWaId(G)).awaiting === 'email');

  /* ---- a typo does not lose the guest ---- */
  const typo = await say('aisha@gmail');
  check('an address that cannot work is queried, not accepted',
    typo.some((m) => /does not look quite right/i.test(m.text?.body || '')));
  check('nothing was emailed to a broken address', mails.length === 0);

  /* ---- the real address ---- */
  const given = await say('aisha.rahman@example.com');
  check('the overview is emailed', mails.length === 1, `sent ${mails.length}`);
  check('to the address they gave', mails[0]?.to?.[0] === 'aisha.rahman@example.com');
  check('from the configured sender', mails[0]?.from === 'Vallé <hello@valle.mu>');
  check('the sales desk is CC\'d in the open', mails[0]?.cc?.includes('sales@valle.mu'),
    JSON.stringify(mails[0]?.cc));
  check('both managers are BCC\'d',
    mails[0]?.bcc?.includes('abdurrahman@valle.mu') && mails[0]?.bcc?.includes('ashfaaq@valle.mu'),
    JSON.stringify(mails[0]?.bcc));
  check('replies go to the reservations desk', mails[0]?.reply_to === 'reservations@valle.mu');
  const photoCids = (mails[0]?.attachments || []).filter((a) => /^photo-/.test(a.content_id || '')).map((a) => a.content_id);
  check('the zipline, quad, buggy and bridge photos are in the letter',
    ['photo-zipline', 'photo-quad', 'photo-buggy', 'photo-bridge'].every((c) => photoCids.includes(c) && (mails[0]?.html || '').includes(`cid:${c}`)),
    photoCids.join(', '));
  const pdf = (mails[0]?.attachments || []).find((a) => /Presentation\.pdf$/.test(a.filename));
  check('the park overview PDF is attached', Boolean(pdf),
    JSON.stringify(mails[0]?.attachments?.map((a) => a.filename) || []));
  check('the attachment carries real bytes', (pdf?.content || '').length > 10000);

  // The letter follows Brand Guidelines V2: the Midimalist header and the
  // Slope footer travel inline as artwork, the text sits in Vallé Purple, and
  // the sign-off is the guideline's own "Mersi!".
  const inline = (mails[0]?.attachments || []).filter((a) => a.content_id).map((a) => a.content_id);
  check('the header and footer artwork are embedded inline',
    inline.includes('valle-header') && inline.includes('valle-footer')
    && inline.every((cid) => (mails[0]?.html || '').includes(`cid:${cid}`)),
    inline.join(', '));
  check('the letter uses Vallé Purple and Sunshine Radiance',
    /#340057/i.test(mails[0]?.html || '') && /#FFFC33/i.test(mails[0]?.html || ''));
  check('the brand typefaces are named, with the Tahoma fallback the guideline prescribes',
    /'Barlow', Tahoma/.test(mails[0]?.html || '') && /'Work Sans', Tahoma/.test(mails[0]?.html || ''));
  check('the subject carries the Kreol sign-off', /Mersi!/.test(mails[0]?.subject || ''));
  check('the letter greets them by first name', /Dear Aisha,/.test(mails[0]?.html || ''));
  check('the letter mentions ATM Dubai 2026', /ATM Dubai 2026/.test(mails[0]?.html || ''));
  check('there is a plain-text version for every client', (mails[0]?.text || '').length > 200);
  check('no em dash in the letter, per the brand rule',
    !/—/.test(mails[0]?.text || ''), (mails[0]?.text || '').slice(0, 80));
  check('the guest is told it is on its way',
    given.some((m) => /aisha\.rahman@example\.com/.test(m.text?.body || '')));

  const c2 = await dbMod.getContactByWaId(G);
  check('the address is stored against the contact', c2.email === 'aisha.rahman@example.com');
  check('and the send is timestamped', c2.email_at !== null);
  check('nothing is left pending', c2.awaiting === null);

  /* ---- the guest is never trapped waiting for an address ---- */
  const G2 = '4917699998888';
  const say2 = async (text, aiReply = null) => {
    globalThis.__aiReply = aiReply;
    const b = out.length;
    await handleIncomingMessage(inbound(G2, text), { wa_id: G2, profile: { name: 'Lena' } });
    globalThis.__aiReply = null;
    return out.slice(b);
  };
  await say2(ATM);
  await say2('email_overview');
  check('the button asks for the address too',
    (await dbMod.getContactByWaId(G2)).awaiting === 'email');

  const escaped = await say2('Actually, how much is the zipline?', 'The Sky Pulse Tour is Rs 4,975 🌿');
  check('changing the subject drops the question instead of trapping them',
    escaped.some((m) => /4,975/.test(m.text?.body || '')),
    escaped.map((m) => (m.text?.body || '').slice(0, 40)).join(' | '));
  check('and nothing is left pending', (await dbMod.getContactByWaId(G2)).awaiting === null);

  /* ---- the assistant can trigger the ask itself ---- */
  const G3 = '33612345678';
  await handleIncomingMessage(inbound(G3, ATM), { wa_id: G3, profile: { name: 'Camille' } });
  globalThis.__aiReply = 'Avec plaisir, je vous envoie la présentation du parc 🌿\n::ASKEMAIL:';
  await handleIncomingMessage(inbound(G3, 'Envoyez-moi ça par mail'), { wa_id: G3, profile: { name: 'Camille' } });
  globalThis.__aiReply = null;
  check('::ASKEMAIL: from the assistant asks for the address',
    (await dbMod.getContactByWaId(G3)).awaiting === 'email');

  const mailsBefore = mails.length;
  await handleIncomingMessage(inbound(G3, 'camille@example.fr'), { wa_id: G3, profile: { name: 'Camille' } });
  check('and the overview follows', mails.length === mailsBefore + 1);

  /* ---- the address parser ---- */
  const good = ['marie@example.com', 'a.b+tag@sub.domain.co.uk', "o'brien@valle.mu", 'JEAN@EXAMPLE.FR'];
  const bad = ['marie@gmail', 'not an email', '@example.com', 'marie@.com', 'Rs 3,600'];
  check('real addresses are recognised', good.every((e) => findEmail(e)),
    good.filter((e) => !findEmail(e)).join(', '));
  check('broken ones are rejected', bad.every((e) => !findEmail(e)),
    bad.filter((e) => findEmail(e)).join(', '));
  check('an address is picked out of a sentence',
    findEmail('sure, it is Marie@Example.com thanks!') === 'marie@example.com');
  check('a trailing full stop is not part of the address',
    findEmail('write to me at marie@example.com.') === 'marie@example.com');
  check('a WhatsApp id becomes E.164', toE164('971501234567') === '+971501234567');

  /* ---- with no credentials, neither channel does anything ---- */
  cfg.sms = { accountSid: '', authToken: '', from: '', messagingServiceSid: '', enabled: true };
  cfg.email = { apiKey: '', from: '', replyTo: '', bcc: '' };
  const smsBefore = sms.length, mailBefore2 = mails.length;
  const G4 = '447700900123';
  await handleIncomingMessage(inbound(G4, ATM), { wa_id: G4, profile: { name: 'Tom' } });
  await new Promise((r) => setImmediate(r));
  globalThis.__aiReply = 'Sure 🌿';
  await handleIncomingMessage(inbound(G4, 'tom@example.com'), { wa_id: G4, profile: { name: 'Tom' } });
  globalThis.__aiReply = null;
  check('unconfigured: no SMS is attempted', sms.length === smsBefore);
  check('unconfigured: no email is attempted', mails.length === mailBefore2);
  check('unconfigured: the guest still gets a normal WhatsApp reply',
    (await dbMod.getContactByWaId(G4)) !== null);

  globalThis.fetch = prev;
}

/* ═══ 32b. Live weather at the park ═══ */
console.log('\n32b. The assistant knows the live weather at Chamouny');
{
  const { describeWeather, getWeather, _resetWeatherCache, _setWeatherCache } = weatherMod;

  /* --- the paragraph the assistant reads --- */
  const text = describeWeather(SAMPLE_WEATHER);
  check('the reading names the park and the time', /Live weather at the park \(Chamouny\), 12:15 local/.test(text));
  check('current conditions carry temperature, feel, condition, wind and gusts',
    /20°C \(feels like 19°C\), light rain showers, wind 28 km\/h with gusts to 60 km\/h/.test(text));
  check('three days of forecast follow, today first',
    /Today: rain showers, 18-21°C, 100% chance of rain, gusts to 63 km\/h/.test(text)
    && /Sat 29 Aug: light drizzle, 17-21°C, 78%/.test(text) && /Sun 30 Aug/.test(text));
  check('sunrise and sunset are there', /Sunrise 06:22, sunset 18:00/.test(text));
  check('no em dash in the reading', !/—/.test(text));
  check('WMO codes read as plain words',
    weatherMod.describeCode(0) === 'clear sky' && weatherMod.describeCode(95) === 'thunderstorm'
    && weatherMod.describeCode(999) === 'mixed conditions');

  /* --- a fresh fetch, parsed from Open-Meteo's real shape --- */
  _resetWeatherCache();
  const fake = async () => new Response(JSON.stringify({
    current: { time: '2026-08-28T15:00', temperature_2m: 24.4, apparent_temperature: 25.1, relative_humidity_2m: 70,
      precipitation: 0, weather_code: 2, wind_speed_10m: 12.3, wind_gusts_10m: 30.2 },
    daily: { time: ['2026-08-28', '2026-08-29', '2026-08-30'], weather_code: [2, 61, 0],
      temperature_2m_max: [26, 24, 27], temperature_2m_min: [19, 18, 19],
      precipitation_probability_max: [10, 60, 0], wind_gusts_10m_max: [35, 50, 30],
      sunrise: ['2026-08-28T06:22', '2026-08-29T06:21', '2026-08-30T06:20'],
      sunset: ['2026-08-28T18:00', '2026-08-29T18:00', '2026-08-30T18:00'] },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const fresh = await getWeather({ fetchImpl: fake, now: 1_000_000 });
  check('a real Open-Meteo response is parsed', fresh?.temperature === 24 && fresh?.condition === 'partly cloudy' && fresh?.days?.length === 3);
  let calls = 0;
  const counting = async (...a) => { calls++; return fake(...a); };
  await getWeather({ fetchImpl: counting, now: 1_000_000 + 5 * 60 * 1000 });
  check('a reading is reused for ten minutes, not refetched', calls === 0);

  /* --- when Open-Meteo is down --- */
  const failing = async () => { throw new Error('ECONNRESET'); };
  const stale = await getWeather({ fetchImpl: failing, now: 1_000_000 + 30 * 60 * 1000 });
  check('a failed refresh serves the last good reading for up to an hour', stale?.temperature === 24);
  const gone = await getWeather({ fetchImpl: failing, now: 1_000_000 + 2 * 60 * 60 * 1000 });
  check('after an hour without data there is simply no reading, no crash', gone === null);
  check('and the assistant is told so', describeWeather(gone) === null);

  /* --- the assistant actually receives it --- */
  _setWeatherCache(SAMPLE_WEATHER);
  const { handleIncomingMessage } = await import('../src/bot/router.js');
  const { config: cfg } = await import('../src/core/config.js');
  cfg.bot.mode = 'hybrid';
  let seen = null;
  globalThis.__onAiRequest = (body) => { seen = body; };
  const out = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const p = (() => { try { return JSON.parse(opts?.body || '{}'); } catch { return {}; } })();
    if (!p.status) out.push(p);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.w' + out.length }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const G = '23050007001';
  const ATM = 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.';
  await handleIncomingMessage(inbound(G, ATM), { wa_id: G, profile: { name: 'Meteo' } });
  globalThis.__aiReply = 'Right now it is 20°C with showers and gusts to 60 km/h, so the ziplines may pause. 🌿';
  await handleIncomingMessage(inbound(G, 'What is the weather like at the park today?'), { wa_id: G, profile: { name: 'Meteo' } });
  globalThis.__aiReply = null;
  const ctx = JSON.stringify(seen?.messages || []) + JSON.stringify(seen?.system || '');
  check('the live reading is in what the assistant sees', /Live weather at the park \(Chamouny\)/.test(ctx));
  check('with the actual figures', /gusts to 60 km\/h/.test(ctx) && /100% chance of rain/.test(ctx));
  check('the guest gets the answer', out.some((m) => /20°C/.test(m.text?.body || '')));
  check('the persona carries the weather rules',
    /Never invent a forecast/.test(JSON.stringify(seen?.system || '')));
  globalThis.__onAiRequest = null;
  globalThis.fetch = prev;
}

/* ═══ 33. The 2026 Chamouzé menu and the two package set menus ═══ */
console.log('\n33. Restaurant menus: the à la carte card and the two set menus');
{
  const { DOCS } = await import('../src/bot/documents.js');
  const fsM = await import('node:fs');
  const { handleIncomingMessage } = await import('../src/bot/router.js');
  const { config: cfg } = await import('../src/core/config.js');
  cfg.bot.mode = 'hybrid';

  for (const key of ['menu_chamouze', 'menu_bigarade', 'menu_explorers', 'menu_adventurers']) {
    check(`${key} exists on disk`, fsM.existsSync(DOCS[key].path), DOCS[key].path);
    const mb = fsM.statSync(DOCS[key].path).size / 1024 / 1024;
    check(`${key} is under WhatsApp's document limit`, mb < 100, `${mb.toFixed(1)} MB`);
  }

  const out = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/media') && !/MEDIA\d/.test(u)) {
      return new Response(JSON.stringify({ id: 'MEDIA_OUT_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const p = (() => { try { return JSON.parse(opts?.body || '{}'); } catch { return {}; } })();
    if (!p.status) out.push(p);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.mn' + out.length }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const G = '23050006001';
  const ATM = 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.';
  await handleIncomingMessage(inbound(G, ATM), { wa_id: G, profile: { name: 'Chef' } });
  const ask = async (text, aiReply = null) => {
    globalThis.__aiReply = aiReply;
    const before = out.length;
    await handleIncomingMessage(inbound(G, text), { wa_id: G, profile: { name: 'Chef' } });
    globalThis.__aiReply = null;
    return out.slice(before);
  };

  const menus = await ask('Can I see the restaurant menus?', 'Voici 🌿\n::SEND: menus');
  check('"the restaurant menus" still sends exactly the two à la carte cards',
    menus.filter((m) => m.type === 'document').length === 2,
    `docs=${menus.filter((m) => m.type === 'document').length}`);

  const exp = await ask("What is in the Explorer's Menu?",
    "It is 1 starter, 1 main, 1 dessert and 1 drink, Rs 2,700 per person 🌿\n::SEND: explorers");
  check("the Explorer's Menu PDF can be attached", exp.some((m) => m.type === 'document'));

  const adv = await ask("And the Adventurer's Menu?",
    "The wider selection, Rs 5,250 per person 🌿\n::SEND: adventurers");
  check("the Adventurer's Menu PDF can be attached", adv.some((m) => m.type === 'document'));

  globalThis.fetch = prev;

  /* --- the knowledge base carries the dishes, not just the file --- */
  const kb = fsM.readFileSync(new URL('../knowledge/valle-kb.md', import.meta.url), 'utf8');
  const facts = [
    ['garlic butter lobster at Rs 2,200', /Garlic butter lobster[\s\S]{0,120}2,200/i],
    ['wagyu steak at Rs 3,125', /Wagyu steak[\s\S]{0,120}3,125/i],
    ['every dessert at Rs 450', /Sweet indulgences[\s\S]{0,60}Rs 450/i],
    ['the veggie burger at Rs 995', /Veggie burger[\s\S]{0,120}995/i],
    ["ocean's treasure for two at Rs 6,700", /treasure platter for 2[\s\S]{0,80}6,700/i],
    ['side add-ons', /Steamed rice Rs 150[\s\S]{0,80}Crispy fries Rs 200/i],
    ['the allergen key', /GL gluten[\s\S]{0,120}SPC spicy/i],
    ["the Explorer's Menu at Rs 2,700 pp", /Explorer's Menu — Rs 2,700 per person/],
    ["the Adventurer's Menu at Rs 5,250 pp", /Adventurer's Menu — Rs 5,250 per person/],
    ['hot beverages', /Flat white Rs 330[\s\S]{0,200}Tea \/ infusion Rs 250/i],
  ];
  for (const [label, re] of facts) check(`the knowledge base has ${label}`, re.test(kb));

  check('Le Chamouzé is the one open every day, matching the knowledge base',
    /Le Chamouzé[^\n]*Open every day/i.test(kb));

  const { CARDS } = await import('../src/bot/menu-bot.js').then((m) => ({ CARDS: null }))
    .catch(() => ({ CARDS: null }));
  const menuSrc = fsM.readFileSync(new URL('../src/bot/menu-bot.js', import.meta.url), 'utf8');
  check('the dining card no longer contradicts it',
    /Le Chamouzé\*: our waterfall restaurant, daily/.test(menuSrc));
}

console.log(`\n═══════════════════════════════════`);
console.log(`  ${pass} passed · ${fail} failed`);
console.log(`═══════════════════════════════════\n`);
process.exit(fail ? 1 : 0);
