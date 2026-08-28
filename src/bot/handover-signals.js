/**
 * WHEN DOES A CHAT BELONG TO A PERSON?
 *
 * Two very different signals, deliberately kept apart:
 *
 *   wantsHuman(text)  the guest is asking to be put through to somebody.
 *                     That is a promise: the bot writes nothing more in that
 *                     chat and a colleague answers.
 *
 *   needsHuman(text)  the subject is one only a colleague can settle (money,
 *                     a change to an existing booking, a complaint). The team
 *                     is alerted, but the bot keeps helping with everything
 *                     else the guest asks meanwhile.
 *
 * Guests at ATM Dubai write in fifteen languages, so both lists are
 * multilingual. They are also deliberately narrow: every pattern needs an
 * asking verb next to the person, so "is someone there?", "do you have staff
 * who speak French?" or "人工智能" never silence the assistant by accident.
 */

/** Who the guest wants to reach. */
const PERSON = '(person|human|agent|someone|somebody|staff|advisor|adviser|consultant'
  + '|representative|operator|receptionist|manager)';

/** "a real live", "an actual", "the" — optional dressing in front of PERSON. */
const A = '(a |an |the )?(real |actual |live |proper )?';

const WANTS_HUMAN_PATTERNS = [
  /* ---------- English ---------- */
  `(talk|speak|chat|deal)(ing)? (to|with) ${A}${PERSON}`,
  `(want|need|like|prefer|rather) (to (talk|speak|chat) (to|with) )?${A}${PERSON}\\b`,
  '(connect|transfer|put|pass|redirect) me (to|with|through|over)',
  '(can|could|may|would) (i|you) (talk|speak|chat|connect|transfer|put)',
  'human (agent|being|support|operator|assistance)',
  '(real|actual|live|proper) (person|human|agent)',
  '(customer|client) (service|support|care)',
  '(please )?call me( back)?\\b',
  '(no|not a|stop the|skip the) (bot|robot|ai)\\b',
  '\\b(human|person|agent|operator) (please|now)\\b',

  /* ---------- French ---------- */
  'parler (a|à|avec) (un|une|quelqu|quelqu.un)',
  '(un|une) (vrai|vraie|v[ée]ritable) (personne|humain|agent|conseill)',
  'je (veux|voudrais|souhaite|aimerais) parler',
  'passez[- ]moi|mettez[- ]moi en relation|un humain',
  'service (client|client[eè]le)',

  /* ---------- Spanish ---------- */
  'hablar con (una|un|alguien)',
  '(quiero|necesito|puedo) hablar',
  'persona real|agente humano|atenci[oó]n al cliente',

  /* ---------- Portuguese ---------- */
  'falar com (uma|um|algu[eé]m)',
  '(quero|preciso|posso) falar',
  'atendente (humano|real)?|pessoa real',

  /* ---------- German ---------- */
  'mit (einem|einer|einen) (mitarbeiter|menschen|mensch|berater|kollegen|kollegin|agenten)',
  '(echten|richtigen) (menschen|mitarbeiter)',
  'ich (m[oö]chte|will) (mit )?(jemandem|einem mitarbeiter)',
  'kundenservice|kundendienst|kundenbetreuung',

  /* ---------- Italian ---------- */
  'parlare con (una|un) (persona|operatore|umano|addetto)',
  'operatore umano|assistenza clienti',

  /* ---------- Russian ---------- */
  '(оператор|поговорить с человеком|живо(й|го) человек|связаться с человеком'
  + '|служба поддержки|хочу поговорить|нужен человек|позовите)',

  /* ---------- Arabic ---------- */
  '(التحدث مع|اريد التحدث|أريد التحدث|أريد شخص|شخص حقيقي|خدمة العملاء'
  + '|موظف خدمة|تحويلي|مع موظف)',

  /* ---------- Turkish ---------- */
  '(insan|yetkili|temsilci|m[uü][sş]teri temsilcisi|biriyle|canlı destek)'
  + ' ?(ile |la |le )?(g[oö]r[uü][sş]|konu[sş]|ba[gğ]lan)',
  'canlı destek|m[uü][sş]teri hizmetleri',

  /* ---------- Polish ---------- */
  'z (człowiekiem|konsultantem|osobą|pracownikiem)',
  'chcę (rozmawiać|porozmawiać)|obsługa klienta',

  /* ---------- Hindi ---------- */
  '(इंसान से|व्यक्ति से बात|एजेंट से|किसी से बात|आदमी से बात)',

  /* ---------- Chinese ---------- */
  // "人工" alone is a trap: it is also half of 人工智能 (= AI).
  '(转人工|人工客服|人工服务|真人|客服人员|联系客服|找客服)',

  /* ---------- Japanese ---------- */
  '(担当者|オペレーター|人と話|係の方|有人)',

  /* ---------- Mauritian Creole ---------- */
  'koz (ar|ek) (enn|en) (dimoun|dimounn|kikenn)',
  'mo anvi koz ar',
];

const NEEDS_HUMAN_PATTERNS = [
  '\\b(complaint|complain|refund|charge ?back|dispute|money back'
  + '|cancel (my|our|the) (booking|reservation|ticket)'
  + '|reschedule (my|our|the)|change (my|our) (booking|reservation|date))\\b',
  '\\b(r[ée]clamation|remboursement|annuler (ma|notre|la) r[ée]servation|reporter ma)\\b',
  '\\b(beschwerde|erstattung|stornieren|umbuchen)\\b',
  '\\b(queja|reembolso|cancelar mi|reclama[cç][aã]o|cancelar minha)\\b',
  '(жалоба|возврат (денег|средств)|отменить бронь)',
  '(شكوى|استرداد|إلغاء الحجز)',
  '(投诉|退款|取消预订)',
  '([sş]ikayet|iade|rezervasyon iptal)',
];

export const WANTS_HUMAN = new RegExp(WANTS_HUMAN_PATTERNS.join('|'), 'i');
export const NEEDS_HUMAN = new RegExp(NEEDS_HUMAN_PATTERNS.join('|'), 'i');

/**
 * Sentences that LOOK like a request for a person but are not: questions about
 * our team, our guides, or the languages our staff speak. Checked first, so a
 * curious guest keeps the assistant.
 */
const NOT_A_REQUEST = new RegExp([
  'who (is|are) (the|your)',
  'how many (people|staff|guides)',
  'do you have (staff|guides|someone|a guide|anyone) (who|that)',
  'your (staff|team|guides) (speak|are|is)',
  '(staff|resident|student|senior) (discount|rate|price|pricing|tarif)',
  'is (someone|anyone) (there|available)',
  '(speak|talk) (english|french|german|russian|arabic|hindi|chinese|creole|spanish)',
].join('|'), 'i');

/** True when the guest is explicitly asking to be put through to a person. */
export function wantsHuman(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (NOT_A_REQUEST.test(t)) return false;
  return WANTS_HUMAN.test(t);
}

/** True when the subject belongs to a colleague, whatever the guest asked for. */
export function needsHuman(text) {
  return NEEDS_HUMAN.test(String(text || ''));
}
