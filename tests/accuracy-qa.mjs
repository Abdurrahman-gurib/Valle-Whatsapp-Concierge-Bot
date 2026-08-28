/**
 * LIVE ACCURACY PASS
 *
 * Puts real guest questions to the real assistant (real Claude call, real
 * knowledge base) and checks the answer against the facts we published. The
 * WhatsApp side is stubbed: nothing is ever sent to a guest.
 *
 *   npm run test:accuracy            all of it
 *   npm run test:accuracy -- prices  only the groups whose name matches
 *
 * Each case says what MUST appear in the answer (`must`), what must NOT
 * (`never`), and which attachment the assistant is expected to send (`sends`).
 */
import 'dotenv/config';
import { generateReply } from '../src/bot/ai.js';

const filter = (process.argv[2] || '').toLowerCase();

/* ─────────── the battery ─────────── */

const CASES = [
  /* ---------- prices, the thing guests ask first ---------- */
  { group: 'prices', q: 'How much is the Sky Pulse zipline tour?',
    must: [/4[,.]?975/], never: [/i (don'?t|do not) know/i] },
  { group: 'prices', q: 'What is the entrance fee?',
    must: [/550/, /325/] },
  { group: 'prices', q: 'How much is the Advenature Flight, the 5.5 km one?',
    must: [/5[,.]?650/] },
  { group: 'prices', q: 'What does the buggy cost for two people sharing?',
    must: [/\d[\d,.]{3,}/] },
  { group: 'prices', q: 'Price for the quad discovery for one person?',
    must: [/3[,.]?600|3 600/] },
  { group: 'prices', q: 'Is the entrance fee included in the packages?',
    must: [/includ/i] },
  { group: 'prices', q: 'I am a Mauritian resident, do I get a better rate?',
    must: [/resident/i], sends: [/resident|pricelist|brochure/i] },
  { group: 'prices', q: 'Do you have student rates?',
    must: [/student/i], sends: [/student/i] },
  { group: 'prices', q: 'My father is 68, is there a senior rate?',
    must: [/senior/i], sends: [/senior/i] },

  /* ---------- activities and the rules that go with them ---------- */
  { group: 'activities', q: 'How long is the longest zipline?',
    must: [/5[.,]5|5500|5[ ,.]?5\s?km/i] },
  { group: 'activities', q: 'What is the minimum age for the quad?',
    must: [/\b(16|18)\b/] },
  { group: 'activities', q: 'Is there a weight limit on the ziplines?',
    must: [/\d{2,3}\s?kg/i] },
  { group: 'activities', q: 'What is the Nepalese Bridge?',
    must: [/bridge/i] },
  { group: 'activities', q: 'Tell me about the Mountain Luge Kart',
    must: [/luge|kart/i] },
  { group: 'activities', q: 'Can my 7 year old do the zipline with me?',
    must: [/\d/] },

  /* ---------- practical ---------- */
  { group: 'practical', q: 'What time do you open and close?',
    must: [/0?9[:.]00|9\s?am/i, /17[:.]30|5[:.]30\s?pm/i] },
  { group: 'practical', q: 'Where exactly are you located?',
    must: [/chamouny|mauritius/i] },
  { group: 'practical', q: 'Do you take credit cards?',
    must: [/card|cash|visa|master/i] },
  { group: 'practical', q: 'Are you open on Sundays?',
    must: [/daily|every day|sunday|7\/7/i] },
  { group: 'practical', q: 'How long should I plan for a full visit?',
    must: [/hour|day|journ/i] },

  /* ---------- the restaurant menu ---------- */
  { group: 'dining', q: 'How much is the garlic butter lobster?',
    must: [/2[,.]?200/] },
  { group: 'dining', q: 'What burgers do you have and how much?',
    must: [/995|1[,.]?010|1[,.]?100|1[,.]?200/] },
  { group: 'dining', q: 'Do you have vegan options at the restaurant?',
    must: [/couscous|vegan|tofu|veggie/i] },
  { group: 'dining', q: 'My wife is allergic to nuts, what can she eat?',
    must: [/allerg|nut/i] },
  { group: 'dining', q: 'How much are the desserts?',
    must: [/450/] },
  { group: 'dining', q: "What is the Explorer's Menu and what does it cost?",
    must: [/2[,.]?700/, /starter/i] },
  { group: 'dining', q: "What is the difference between the Explorer's and Adventurer's menus?",
    must: [/5[,.]?250|2[,.]?700/] },
  { group: 'dining', q: 'Is Le Chamouzé open every day?',
    must: [/every day|daily/i] },
  { group: 'dining', q: 'Can I get the restaurant menu as a PDF?',
    sends: [/menu/i] },
  { group: 'dining', q: 'How much is a cappuccino?',
    must: [/295/] },

  /* ---------- live weather ---------- */
  { group: 'weather', q: 'What is the weather like at Vallé right now?',
    must: [/\d+\s?°C/], never: [/cannot see|not available/i] },
  { group: 'weather', q: 'Will it rain at the park tomorrow?',
    must: [/%|rain|dry|shower|clear|cloud/i] },
  { group: 'weather', q: 'What will the weather be at Vallé on 20 December?',
    must: [/forecast|closer|not (yet|out)|beyond/i], never: [/\d+% chance of rain on 20 December/i] },

  /* ---------- families, kids, animals, nature ---------- */
  { group: 'family', q: 'What can my kids do there, they are 5 and 9?',
    must: [/kids|child|famil/i] },
  { group: 'family', q: 'Do you have animals in the park?',
    must: [/tortoise|deer|animal|wildlife/i] },
  { group: 'family', q: 'Tell me about the 23 coloured earth',
    must: [/coloured earth|23/i] },

  /* ---------- documents and photos ---------- */
  { group: 'assets', q: 'Can you send me your price list?',
    sends: [/brochure|pricelist/i] },
  { group: 'assets', q: 'Do you have photos of the ziplines?',
    sends: [/photos/i] },
  { group: 'assets', q: 'Send me the park map please',
    sends: [/map/i] },
  { group: 'assets', q: 'What are the restaurant menus?',
    sends: [/menu/i] },
  { group: 'assets', q: 'Tell me all about Vallé Advenature Park',
    sends: [/presentation|magazine|profile/i] },

  /* ---------- the handover rules ---------- */
  { group: 'handover', q: 'Can I speak to a real person please?',
    human: true },
  { group: 'handover', q: 'I want a refund, my booking was wrong',
    handover: true },
  { group: 'handover', q: 'We are 80 people for a corporate day, can you quote?',
    handover: true },
  { group: 'handover', q: 'How much is the zipline?',
    human: false, handover: false },

  /* ---------- languages: the answer must come back in the same one ---------- */
  { group: 'languages', q: 'Bonjour, quel est le prix des tyroliennes ?',
    lang: /\b(le|la|les|des|vous|prix|tyrolienne)\b/i },
  { group: 'languages', q: 'Guten Tag, was kostet der Eintritt?',
    lang: /\b(der|die|das|ist|Eintritt|Preis|kostet)\b/i },
  { group: 'languages', q: '¿Cuánto cuesta la tirolina?',
    lang: /\b(el|la|los|es|precio|cuesta|tirolina)\b/i },
  { group: 'languages', q: 'Quanto custa a entrada?',
    lang: /\b(a|o|de|é|entrada|preço|custa)\b/i },
  { group: 'languages', q: 'Сколько стоит зиплайн?',
    lang: /[Ѐ-ӿ]{4,}/ },
  { group: 'languages', q: 'كم سعر تذكرة الدخول؟',
    lang: /[؀-ۿ]{3,}/ },
  { group: 'languages', q: '门票多少钱？',
    lang: /[一-鿿]{2,}/ },
  { group: 'languages', q: '入場料はいくらですか？',
    lang: /[぀-ヿ一-鿿]{2,}/ },
  { group: 'languages', q: 'Giriş ücreti ne kadar?',
    lang: /(ücret|fiyat|giriş|kişi|yaş)/i },
  { group: 'languages', q: 'Ile kosztuje bilet wstępu?',
    lang: /\b(jest|kosztuje|bilet|cena|wstęp)\b/i },
  { group: 'languages', q: 'प्रवेश शुल्क कितना है?',
    lang: /[ऀ-ॿ]{3,}/ },
  { group: 'languages', q: 'Ki pri pou zipline la?',
    lang: /\b(pri|zipline|rupi|rs|pou|ena)\b/i },

  /* ---------- the things that must never happen ---------- */
  { group: 'discipline', q: 'Do you have a helicopter transfer from the airport?',
    never: [/yes,? we (have|offer) (a )?helicopter/i] },
  { group: 'discipline', q: 'Can I bring my dog?',
    never: [/^\s*yes\b.*dog.*(allowed|welcome)/i] },
  { group: 'discipline', q: 'What is the price of the zipline?',
    never: [/—/, /\[.*\]/] },
];

/* ─────────── run it ─────────── */

const groups = [...new Set(CASES.map((c) => c.group))].filter((g) => !filter || g.includes(filter));
let pass = 0, fail = 0;
const failures = [];

console.log('\n═══ VALLÉ — LIVE ACCURACY PASS ═══\n');

for (const group of groups) {
  console.log(`\n── ${group} ──`);
  const cases = CASES.filter((c) => c.group === group);

  // Ask them in parallel: each case is a fresh guest with no history.
  const answers = await Promise.all(cases.map(async (c) => {
    try {
      return await generateReply({
        history: [], userText: c.q, profileName: 'Guest', source: 'atm-dubai-2026',
      });
    } catch (err) {
      return { reply: '', error: err.message };
    }
  }));

  cases.forEach((c, i) => {
    const r = answers[i];
    const problems = [];

    if (r.error) problems.push(`API error: ${r.error}`);
    for (const re of c.must || []) if (!re.test(r.reply)) problems.push(`missing ${re}`);
    for (const re of c.never || []) if (re.test(r.reply)) problems.push(`contains ${re}`);
    if (c.lang && !c.lang.test(r.reply)) problems.push(`answered in the wrong language`);
    if (c.sends) {
      const tokens = (r.send || []).join(' ');
      for (const re of c.sends) if (!re.test(tokens)) problems.push(`no attachment matching ${re} (sent: ${tokens || 'nothing'})`);
    }
    if (c.human === true && !r.guestAsked) problems.push('should have used ::HUMAN:');
    if (c.human === false && r.guestAsked) problems.push('used ::HUMAN: on an ordinary question');
    if (c.handover === true && !r.handover) problems.push('should have escalated');
    if (c.handover === false && r.handover) problems.push('escalated an ordinary question');

    if (problems.length) {
      fail++;
      failures.push({ q: c.q, problems, reply: r.reply, send: r.send });
      console.log(`  ❌ ${c.q}`);
      problems.forEach((p) => console.log(`       ${p}`));
    } else {
      pass++;
      console.log(`  ✅ ${c.q}`);
    }
  });
}

if (failures.length) {
  console.log('\n─── what the assistant actually said ───');
  for (const f of failures) {
    console.log(`\nQ: ${f.q}`);
    console.log(`A: ${f.reply.slice(0, 500)}`);
    if (f.send?.length) console.log(`   ::SEND: ${f.send.join(', ')}`);
  }
}

console.log(`\n═══════════════════════════════════`);
console.log(`  ${pass} passed · ${fail} failed`);
console.log(`═══════════════════════════════════\n`);
process.exit(fail ? 1 : 0);
