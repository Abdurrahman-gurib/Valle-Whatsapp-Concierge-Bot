/**
 * MENU BOT: deterministic concierge (BOT_MODE=menu)
 *
 * No AI. Every reply is a fixed text taken from valle-kb.md (ATM 2026 pack).
 * Buttons, lists and keywords guide the guest; anything the menu can't answer
 * is offered to a human.
 *
 * handleMenuMessage() returns:
 *   'done'     :fully handled, nothing else to do
 *   'human'    :guest explicitly asked for a person. The router queues the chat
 *                AND silences the bot there: a colleague answers, not us.
 *   'lead'     :free-text booking/enquiry; ack already sent (router queues silently)
 *   'unhandled': free text the menu didn't match, and handleFreeText=false
 *                 (hybrid mode: the router passes it to the AI instead)
 */
import * as db from '../core/db.js';
import { sendText, sendButtons, sendList } from '../whatsapp/client.js';
import { sendDoc } from './documents.js';
import { sendPhoto, sendGallery, hasImages } from './images.js';

const FOOTER = '\n\nReply *BOOK* to reserve · *MENU* for options · *AGENT* for a person 🌿';

// English-only on purpose: greetings and keywords in other languages fall
// through to the AI, which replies in the guest's own language.
const GREETINGS = ['hi', 'hello', 'hey', 'menu', 'start'];

/* ═══════════════════════ CANNED CARDS (from valle-kb.md) ═══════════════════════ */

const CARDS = {
  prices:
    `*Quick prices* 🌿\n` +
    `• Admission: Rs 550 (6–11 yrs Rs 325 · under 6 free)\n` +
    `• Ziplines: from Rs 1,375 (flagship 5.5 km Rs 5,650)\n` +
    `• Quad: from Rs 3,600 · Buggy: from Rs 7,500\n` +
    `• Luge Kart: from Rs 700 · Nepalese Bridge: Rs 1,300 · Bicycle Zipline: Rs 1,150\n` +
    `• Combos from Rs 7,400 · Full packages (admission + lunch) from Rs 11,100\n` +
    `Prices VAT inclusive, valid 1 Jul 2026 – 30 Jun 2027.\n\n` +
    `Prices above are our standard rates. Special rates exist for *residents*, ` +
    `*students* and *seniors*: just say which applies to you.\n` +
    `Reply *BROCHURE* for the full pricelist as a PDF 📄`,

  admission:
    `*Admission* 🎟\n` +
    `• 12 yrs & above: Rs 550\n` +
    `• 6–11 yrs: Rs 325\n` +
    `• 1–5 yrs: FREE\n` +
    `Admission is charged in addition to activities: unless you take a package (all packages include it).`,

  ziplines:
    `*Ziplines* 🪂 (per person)\n` +
    `• The Plunge: 500 m · Rs 1,375\n` +
    `• Waterfall Zipline: 300 m, 2 lines · Rs 1,950\n` +
    `• The Signature: 1.5 km · Rs 2,850\n` +
    `• Adventure Tour: 2.4 km, 6 lines · Rs 2,950\n` +
    `• Discovery Tour: 1.6 km, 7 lines · Rs 3,600\n` +
    `• 10 Flight Trail: 3.5 km, 10 lines · Rs 4,150\n` +
    `• Sky Pulse Tour: 3.1 km, 7 lines · Rs 4,975\n` +
    `• Advenature Flight ⭐: 5.5 km, 11 lines · Rs 5,650\n\n` +
    `⭐ Flagship: 2 h–2 h 30 over waterfalls, forest and the 23 Coloured Earth.\n` +
    `Min height 1 m 10 (Signature: 1 m 40 & 40 kg min). Admission Rs 550 extra unless in a package.`,

  bicycle:
    `*Bicycle Zipline* 🚲: Rs 1,150\n` +
    `Unique in Mauritius: ride 18 m above ground for 15 min, with views of the south coast, ` +
    `Savanne mountains, lake and waterfall.\n` +
    `Min height 1 m 40 · max weight 99 kg.`,

  bridge:
    `*Nepalese Bridge* 🌉: Rs 1,300\n` +
    `A 350 m walk, 80–100 m above the ground: from dense forest to open coastal views. ` +
    `Duration 20–25 min.\n` +
    `Min height 1 m 10 · max weight 150 kg.`,

  quad:
    `*Quad* 🏍 (price per quad · Single = 1 rider, Double = 2 sharing)\n` +
    `• Quad Discovery (1 h): Standard Rs 3,600 / 4,700 · Exclusive Rs 7,600 / 8,300\n` +
    `• Quad Adventure (1 h): Standard Rs 3,950 / 5,150 · Exclusive Rs 7,900 / 8,625\n` +
    `• Advenature Tour (2 h): Standard Rs 5,250 / 6,250 · Exclusive Rs 9,225 / 9,975\n\n` +
    `Driver 16+ · passenger min 1 m 20. Automatic gearbox, helmets provided, ` +
    `safety briefing + test drive before every tour.`,

  buggy:
    `*Buggy* 🚙\n` +
    `• Buggy Discovery (1 h): Rs 7,500\n` +
    `• Buggy 4X (1 h): Rs 13,500\n` +
    `• Buggy Exclusive 2 pax (1 h 30): Rs 15,500\n` +
    `• Buggy Exclusive 4 pax (1 h 30): Rs 19,500\n` +
    `Driver 16+ · passengers from 6 yrs. Automatic, helmets provided.`,

  luge:
    `*Mountain Luge Kart* 🛷\n` +
    `• 1 ride: Rs 700 · 2 rides: Rs 1,025 · 3 rides: Rs 1,300\n` +
    `15 min, family-friendly, you set your own pace. Min height 1 m 10. ` +
    `Helmets and safety gear provided.`,

  drive:
    `*Explorer's Drive* 🚐 (1 h, guided)\n` +
    `• Private Vallé Expedition: 1 pax Rs 3,800 · 2 pax Rs 4,250 · 3 pax Rs 4,550 · 4 pax Rs 4,650\n` +
    `• Elite Expedition: Rs 8,000\n` +
    `• The Peak: Rs 4,900\n` +
    `• Group Expedition (min 5 pax): Rs 1,350 per person`,

  dining:
    `*Dining at Vallé* 🍽\n` +
    `• *Le Chamouzé*: our waterfall restaurant, daily 11:30–16:30 · starters from ` +
    `Rs 600, burgers from Rs 995, mains to Rs 3,700\n` +
    `• *La Bigarade*: Indian & Mauritian by the river, 11:30–16:30 (not open daily) · from Rs 400\n` +
    `• *Le Palmiste*: cafeteria, daily 09:00–17:30 · from Rs 150\n` +
    `• *Kazmaël*: juice point with 360° views, daily 09:00–17:30 · from Rs 100\n` +
    `Set menus with a package: Explorer's Rs 2,700 pp, Adventurer's Rs 5,250 pp.\n` +
    `Private dining with butler service available at Top of the Hill & La Tour.`,

  cinematic:
    `*Cinematic Experience* 🎬\n` +
    `• Koi Pond Experience: Rs 4,000\n` +
    `• Swing Experience: Rs 2,500 (with dress Rs 4,000)\n` +
    `• Cinematic Package: 1 activity Rs 12,000 · 2 for Rs 14,000 · 3 for Rs 16,000\n` +
    `• Full Day: Rs 20,000\n` +
    `GoPro rental also available in the park (photography is not allowed on ziplines or the bridge).`,

  info:
    `*Practical info* 📍\n` +
    `• Open *daily 09:00–17:30*\n` +
    `• B102, Mare Anguilles, Chamouny: south of Mauritius\n` +
    `• 🗺 https://maps.google.com/?q=Vall%C3%A9+Advenature+Park+Chamouny+Mauritius\n` +
    `• ☎ +230 660 44 77 · www.vallepark.com\n` +
    `• Payment: cash, Visa, MasterCard, Amex, Juice, bank transfer, online\n` +
    `• Wear closed shoes & comfortable clothes: safety gear is provided\n` +
    `• Cancellation: free 48 h+ before · 50% at 24 h · 100% same day (extreme weather excepted)`,

  about:
    `*About Vallé · Advenature Park™*\n` +
    `Vallé began as a family tea plantation in Chamouny, in the south of Mauritius. ` +
    `The discovery of 23 hues of Mauritian soil on the land, the famous *23 Coloured Earth*, ` +
    `inspired its transformation into an adventure park where nature is preserved, not replaced: ` +
    `waterfalls, endemic trees and wild deer are part of the experience.\n\n` +
    `Today Vallé offers ziplines up to 5.5 km, quad and buggy trails, the Nepalese Bridge, ` +
    `the mountain luge and two restaurants.\n\n` +
    `*Your Advenature Begins Here. Feel the pulse of Mauritius.* 🌿`,

  kids:
    `*Kids & family*\n` +
    `• Admission: children 1–5 FREE · 6–11 yrs Rs 325\n` +
    `• Kids Park play area on site\n` +
    `• Discovery Tour ziplines (1.6 km, guided): suitable for all ages, children included\n` +
    `• Mountain Luge Kart: from 1 m 10\n` +
    `• Buggy: passengers from 6 years\n` +
    `• Quad: passengers from 1 m 20\n` +
    `Tell us the ages of your children and we will happily suggest the best family plan.`,

  history:
    `*Our story* 🌿\n` +
    `1. A family tea plantation in Chamouny, south Mauritius.\n` +
    `2. The discovery: 23 hues of Mauritian soil, the *23 Coloured Earth*.\n` +
    `3. A natural path to a waterfall becomes the first quad trail.\n` +
    `4. Ocean views inspire the first ziplines, today up to 5.5 km.\n` +
    `5. Nature kept, not cleared: wild deer, giant tortoises, 50+ endemic tree species.\n` +
    `6. The Nepalese Bridge, Bicycle Zipline, Luge Kart, The Peak, Kids Park, restaurants.\n` +
    `7. Today: recognised by the World Luxury Travel Awards, open daily 09:00–17:30.\n\n` +
    `"Never say adventure is impossible, make it unforgettable." (our founder)\n` +
    `Reply *PRESENTATION* for our picture tour of the park, *PHOTOS* for the story in `
    + `pictures, or *MAGAZINE* for the full magazine.`,

  animals:
    `*Animals & nature* 🦌\n` +
    `• Giant tortoises you can meet along the trail\n` +
    `• Wild Java deer roaming freely, and rare albino deer\n` +
    `• Souris, our friendly domesticated deer, at Le Palmiste café\n` +
    `• Over 50 endemic tree species, including Black Ebony and Bois de Natte\n` +
    `• The 23 Coloured Earth, three waterfalls, the lake and the Rock Garden\n` +
    `Nature is preserved here, not replaced: the wildlife lives freely across the park.`,

  links:
    `*Vallé online* 🔗\n` +
    `• Website & online booking: www.vallepark.com\n` +
    `• Directions: https://maps.google.com/?q=Vall%C3%A9+Advenature+Park+Chamouny+Mauritius\n` +
    `• Instagram: instagram.com/valleadvenaturepark\n` +
    `• ☎ +230 660 44 77 · sales@vallepark.com`,

  book:
    `Great choice! 🎉 To arrange your visit, send me *in one message*: \n\n` +
    `1️⃣ Your name\n` +
    `2️⃣ Date of visit\n` +
    `3️⃣ Number of people (ages if children)\n` +
    `4️⃣ The activities or package you'd like\n\n` +
    `A colleague will then confirm availability and payment right here. 🌿`,

  pkg_combo:
    `*Combo Packages* 🎯\n` +
    `*Ace*: Quad Adventure (1 h) + Discovery Tour ziplines (1.6 km, 7 lines)\n` +
    `Single Rs 7,400 · Double Rs 12,100\n\n` +
    `*Conqueror*: Quad Adventure (1 h) + Sky Pulse Tour (3.1 km, 7 lines)\n` +
    `Single Rs 8,900 · Double Rs 14,975`,

  pkg_light:
    `*Exclusive Packages* ✨ (admission + lunch included)\n` +
    `*Light*: Single Rs 11,100 · Double Rs 19,450\n` +
    `Quad Adventure (1 h) · Discovery Tour (7 lines) · Nepalese Bridge · Lunch\n\n` +
    `*Standard*: Single Rs 11,950 · Double Rs 21,750\n` +
    `Quad Adventure (1 h) · Sky Pulse Tour (includes the Signature) · Nepalese Bridge · Lunch`,

  pkg_bronze:
    `*Bronze*: Single Rs 16,575 · Double Rs 21,625\n` +
    `Admission · Quad Discovery · The Peak · Waterfall Zipline (300 m) · Nepalese Bridge · ` +
    `Luge (1 ride) · GoPro rental (full day)\n\n` +
    `*Silver*: Single Rs 17,200 · Double Rs 23,075\n` +
    `As Bronze, with the 1.5 km *Signature Zipline* instead of the Waterfall Zipline.`,

  pkg_gold:
    `*Gold*: Single Rs 19,400 · Double Rs 27,300\n` +
    `Admission · Quad Adventure · The Peak · Sky Pulse Tour (3.1 km) · Nepalese Bridge · ` +
    `Luge (1 ride) · GoPro rental (full day)\n\n` +
    `*Platinum*: Single Rs 23,800 · Double Rs 32,175\n` +
    `Admission · Exclusive Quad Adventure · The Peak · Advenature Flight (5.5 km ⭐) · ` +
    `Nepalese Bridge · Luge · GoPro\n\n` +
    `Add-ons: Bicycle Zipline · Stone Cooking lunch · Full-day Cinematic video`,

  pkg_vip:
    `*VIP Ultimate: All Inclusive* 👑\n` +
    `Single Rs 49,225 · Double Rs 75,175\n` +
    `Private guide, transfer & butler · Exclusive Quad Adventure · Advenature Flight (5.5 km) · ` +
    `Nepalese Bridge · Bicycle Zipline · Luge (3 rides) · The Peak · Snacks & beverages in any outlet · ` +
    `GoPro full day + free photos · Lunch\n` +
    `Add-on: Full-day Cinematic Rs 20,000. A special souvenir gift is offered.`,

  pkg_diamond:
    `*Diamond Package* 💎\n` +
    `Single Rs 120,000 · Double Rs 149,000\n` +
    `Everything in VIP Ultimate, plus: Stone Cooking lunch at Le Chamouzé · ` +
    `3-hour Hunting Expedition · Cinematic video of your complete day.\n` +
    `A special souvenir gift is offered.`,
};

/* ═══════════════════ TYPED-KEYWORD RULES (order matters) ═══════════════════ */

// A typed request for pictures ("do you have photos?", "show me the ziplines").
const PHOTO_RULES = [
  { match: /\b(photo|photos|picture|pictures|image|images|gallery|show me)\b/i },
];

// Which image topic (images.js) illustrates which info card.
const CARD_PHOTOS = {
  ziplines: 'ziplines', bicycle: 'bicycle', bridge: 'bridge', quad: 'quad',
  buggy: 'buggy', luge: 'luge', drive: 'expedition', dining: 'dining',
  kids: 'kids', about: 'nature', info: 'map',
  history: 'history', animals: 'animals',
};

/** Rules that hand over a file rather than a canned answer. */
const DOC_KEYS = new Set(['brochure', 'map', 'packages']);

/**
 * Words that mean the guest is asking about something specific in the park.
 * When one appears, a generic file is the wrong answer: the assistant replies
 * about that thing (and attaches a document itself if it helps).
 */
const ACTIVITY_WORDS = /\b(quad|buggy|zip ?line|zipline|ziplines|luge|kart|bridge|nepal|bicycle|peak|expedition|explorer|kids?|child|children|animal|tortoise|deer|waterfall|coloured earth|track|tracks|trail|dining|restaurant|lunch|cinematic|gopro|admission|entrance)\b/i;

const RULES = [
  // Most specific first: "the package pdf" must beat the generic "pdf".
  // Asking to be SENT the packages gives the PDFs; asking about them shows the list.
  { match: /\b(packages?|forfaits?)\b[\s\S]*\b(pdf|documents?|brochure)\b|\b(pdf|documents?)\b[\s\S]*\b(packages?|forfaits?)\b/i, key: 'doc_packages' },
  { match: /brochure|catalog|catalogue|price ?list|\bpdf\b/i, key: 'brochure' },
  { match: /\b(magazine|company profile)\b/i, key: 'doc_profile' },
  { match: /\bfact ?sheet\b/i, key: 'doc_factsheet' },
  { match: /\bresident|\brr\b|mauritian (rate|price)/i, key: 'doc_resident' },
  { match: /\bstudent|school (group|rate|trip)/i, key: 'doc_student' },
  { match: /\bsenior|\b55\+|pensioner|third age/i, key: 'doc_senior' },
  { match: /kids? park|children.s park|\bvkp\b|mini quad|pirate ship|mini excavator/i, key: 'doc_kidspark' },
  // "menus" (plural) or an explicit food menu means the restaurant menus.
  // A bare "menu" stays the bot's own menu (see GREETINGS).
  { match: /\bmenus\b|\bmenu (card|carte)\b|food menu|restaurant menu|[àa] la carte|what.s on the menu/i, key: 'doc_menus' },
  { match: /\b(map|sitemap|site map)\b/i, key: 'map' },
  // A guest asking to know Vallé gets the illustrated presentation.
  { match: /\bpresentation\b|\bslides?\b|(tell|know) me (more )?about (vall|the park)|show me (vall|the park)/i, key: 'doc_presentation' },
  { match: /\babout\b|who are you/i, key: 'about' },
  { match: /\b(story|history|timeline|founded|founder|origin)\b/i, key: 'history' },
  { match: /\b(animal|animals|wildlife|tortoise|tortoises|deer|birds?|nature)\b/i, key: 'animals' },
  { match: /\b(website|link|links|instagram|facebook|social|online booking)\b/i, key: 'links' },
  // Deliberately not a bare "family": "a day with family, how much time?" is a
  // question about duration, not about the Kids Park.
  { match: /\bkids?\b|child|children|toddler|family (activities|package|plan|friendly)/i, key: 'kids' },
  { match: /\b(book|booking|reserv)/i, key: 'book' },
  // Order matters: "quad bike" is a quad, not the Bicycle Zipline.
  { match: /quad/i, key: 'quad' },
  { match: /buggy/i, key: 'buggy' },
  { match: /\bbicycle\b|bike zip|zip.*\bbike\b|cycling/i, key: 'bicycle' },
  { match: /zip|flight trail|sky pulse|plunge|signature/i, key: 'ziplines' },
  { match: /bridge|nepal/i, key: 'bridge' },
  { match: /luge|kart/i, key: 'luge' },
  { match: /peak|expedition|explorer/i, key: 'drive' },
  { match: /package|pack\b|combo|vip|diamond|gold|platinum|silver|bronze|all.?inclusive/i, key: 'packages' },
  { match: /restaurant|food|eat|lunch|dining|dinner|bigarade|chamouz|palmiste|kazma/i, key: 'dining' },
  // Deliberately NOT a bare "photo": a guest asking for photos of the park is
  // not asking about our paid photo-shoot packages.
  { match: /gopro|cinematic|photo ?shoot|photo package|video|film|koi pond|swing experience/i, key: 'cinematic' },
  { match: /admission|entry|entrance|ticket/i, key: 'admission' },
  { match: /\b(open|hour|time)\b/i, key: 'info' },
  { match: /where|location|address|direction|map|reach you|get to (you|the park)|how (do i|to|can i|can we) (get|reach|come|find)/i, key: 'info' },
  { match: /\bpay(ment|ing)?\b|juice|credit card|visa|mastercard|cash/i, key: 'info' },
  { match: /wear|shoe|cloth|dress code/i, key: 'info' },
  { match: /price|prices|cost|how much|rate/i, key: 'prices' },
];

/* ═══════════════════════ MENUS ═══════════════════════ */

export async function sendMenuWelcome(contact) {
  try {
    await sendWelcomeList(contact);
  } catch (err) {
    // A guest who just scanned our QR code must NEVER be met with silence:
    // if the interactive menu is refused, greet them in plain text instead.
    console.error('[menu] welcome list failed, falling back to text', err.message);
    await sendText(contact.wa_id,
      `Welcome to *Vallé · Advenature Park*. I am the Vallé Advenature assistant. 🌿\n\n` +
      `Ziplines up to 5.5 km, quad and buggy trails, the Nepalese Bridge and the ` +
      `23 Coloured Earth, in the south of Mauritius. Open daily 09:00–17:30.\n\n` +
      `Ask me anything, by text or *voice note* 🎙, in your own language: prices, ` +
      `activities, menus, location and map, photos, PDF brochures, bookings and more. Or reply:\n` +
      `*ACTIVITIES* · *PACKAGES* · *PHOTOS* · *BROCHURE* · *BOOK* · *AGENT* for a person`);
    await log(contact, '[menu] welcome (text fallback)');
  }
}

async function sendWelcomeList(contact) {
  const name = contact.profile_name ? `, ${contact.profile_name.split(' ')[0]}` : '';
  const opener = contact.source === 'atm-dubai-2026'
    ? `A pleasure to meet you at *ATM Dubai 2026*${name}. I am the Vallé Advenature assistant. 🌿\n\n`
    : `Welcome to *Vallé · Advenature Park*${name}. I am the Vallé Advenature assistant. 🌿\n\n`;

  await sendList(contact.wa_id, {
    body:
      opener +
      `Ziplines up to 5.5 km, quad and buggy trails, the Nepalese Bridge and the ` +
      `23 Coloured Earth, in the south of Mauritius. Open daily 09:00–17:30.\n\n` +
      `Ask me anything, by text or *voice note* 🎙, in your own language: prices, ` +
      `activities, restaurant menus, location and map, photos, PDF brochures, ` +
      `bookings and more. Or choose from the menu below.`,
    footer: 'Vallé · Chamouny · Mauritius',
    buttonText: 'Menu',
    sections: [
      { title: 'Discover', rows: [
        { id: 'about', title: 'About Vallé', description: 'Our story and the 23 Coloured Earth' },
        { id: 'menu_activities', title: 'Activities & prices', description: 'Ziplines, quad, buggy, luge and more' },
        { id: 'menu_packages', title: 'Packages', description: 'Combos to Diamond, admission included' },
        { id: 'kids', title: 'Kids & family', description: 'Under 5 free · Kids Park · family rides' },
        { id: 'animals', title: 'Animals & nature', description: 'Tortoises, deer, waterfalls, 23 Coloured Earth' },
      ]},
      // WhatsApp allows 10 rows in total across all sections: keep it at 10.
      { title: 'See the park', rows: [
        { id: 'photos', title: 'Photos of Vallé', description: 'A glimpse of the park and its colours' },
      ]},
      { title: 'Plan your visit', rows: [
        { id: 'menu_book', title: 'Book a visit', description: 'Availability confirmed by our team' },
        { id: 'act_info', title: 'Hours & directions', description: 'Open daily 09:00–17:30 · map' },
        { id: 'brochure', title: 'Pricelist (PDF)', description: 'The full brochure, sent right here' },
      ]},
      { title: 'Assistance', rows: [
        { id: 'menu_human', title: 'Talk to a person', description: 'A colleague replies to you here' },
      ]},
    ],
  });
  await log(contact, '[menu] welcome');
}

async function sendActivitiesList(contact) {
  await sendList(contact.wa_id, {
    header: 'Our activities',
    body: 'Pick one for details, prices and requirements.',
    footer: 'Vallé: Chamouny',
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
        { id: 'act_drive', title: "Explorer's Drive", description: 'From Rs 1,350 pp · guided 1 h' },
      ]},
      // Keep the total at 10 rows: WhatsApp rejects a longer list outright.
      { title: 'More', rows: [
        { id: 'act_packages', title: 'Packages', description: 'Combos to Diamond, from Rs 7,400' },
        { id: 'act_dining', title: 'Dining & menus', description: '2 restaurants, 2 cafeterias' },
        { id: 'act_info', title: 'Hours & directions', description: 'Open daily 09:00–17:30, Chamouny' },
      ]},
    ],
  });
  await log(contact, '[menu] activities list');
}

async function sendPackagesList(contact) {
  await sendList(contact.wa_id, {
    header: 'Packages',
    body: 'All full packages include admission. Pick one for details.',
    footer: 'Vallé: Chamouny',
    buttonText: 'See packages',
    sections: [
      { title: 'Packages', rows: [
        { id: 'pkg_combo', title: 'Combos: Ace, Conqueror', description: 'Quad + ziplines · from Rs 7,400' },
        { id: 'pkg_light', title: 'Light & Standard', description: 'Incl. lunch · from Rs 11,100' },
        { id: 'pkg_bronze', title: 'Bronze & Silver', description: 'Incl. GoPro · from Rs 16,575' },
        { id: 'pkg_gold', title: 'Gold & Platinum', description: 'Top experiences · from Rs 19,400' },
        { id: 'pkg_vip', title: 'VIP Ultimate', description: 'All inclusive + butler · Rs 49,225' },
        { id: 'pkg_diamond', title: 'Diamond', description: 'The ultimate day · Rs 120,000' },
      ]},
    ],
  });
  await log(contact, '[menu] packages list');
}

/* ═══════════════════════ MAIN HANDLER ═══════════════════════ */

export async function handleMenuMessage(contact, text, {
  handleFreeText = true, handlePhotoRequests = true, topicCards = true,
} = {}) {
  const t = text.trim().toLowerCase();

  /* --- greetings & menu buttons --- */
  if (GREETINGS.includes(t)) { await sendMenuWelcome(contact); return 'done'; }
  if (t === 'menu_activities') { await sendActivitiesList(contact); return 'done'; }
  if (t === 'menu_packages' || t === 'act_packages') { await sendPackagesList(contact); return 'done'; }
  if (t === 'menu_human') return 'human';
  if (t === 'brochure') { await sendBrochure(contact); return 'done'; }
  if (t === 'kidspark') { await sendBrochure(contact, 'kidspark'); return 'done'; }
  if (t === 'photos') { await sendPhotosThenCard(contact, 'park', null); return 'done'; }
  if (t === 'map') { await sendPhotosThenCard(contact, 'map', 'info'); return 'done'; }
  if (t === 'doc_profile') { await sendBrochure(contact, 'profile'); return 'done'; }
  if (t === 'act_menus') {
    await sendBrochure(contact, 'menu_chamouze');
    await sendBrochure(contact, 'menu_bigarade');
    return 'done';
  }

  /* --- list-row taps → cards --- */
  const BY_ID = {
    act_ziplines: 'ziplines', act_bicycle: 'bicycle', act_bridge: 'bridge',
    act_quad: 'quad', act_buggy: 'buggy', act_luge: 'luge', act_drive: 'drive',
    act_dining: 'dining', act_info: 'info',
    about: 'about', kids: 'kids', menu_book: 'book',
    history: 'history', animals: 'animals', links: 'links',
    pkg_combo: 'pkg_combo', pkg_light: 'pkg_light', pkg_bronze: 'pkg_bronze',
    pkg_gold: 'pkg_gold', pkg_vip: 'pkg_vip', pkg_diamond: 'pkg_diamond',
  };
  if (BY_ID[t]) {
    const key = BY_ID[t];
    const topic = CARD_PHOTOS[key];
    if (topic && hasImages(topic)) {
      await sendPhoto(contact.wa_id, topic).catch((e) => console.error('[menu] photo', e.message));
    }
    await sendCard(contact, key);
    return 'done';
  }

  /* --- long message with numbers = booking details / concrete request --- */
  // Checked before keywords so "Marie, 4 pax, 12 Sept, Gold package" becomes a
  // lead for the team instead of triggering the "package" info card.
  // In hybrid mode the AI handles it instead (it collects the booking properly).
  if (text.length >= 20 && /\d/.test(text)) {
    if (!handleFreeText) return 'unhandled';
    await sendText(contact.wa_id,
      `Thank you! 📝 I've passed this to our team: a colleague will get back to you ` +
      `right here to confirm the details. 🌿`);
    await log(contact, '[menu] enquiry → human');
    return 'lead';
  }

  /* --- photo requests ("do you have photos of the ziplines?") --- */
  if (PHOTO_RULES.some((r) => r.match.test(text))) {
    const topicRule = RULES.find((r) => r.match.test(text) && CARD_PHOTOS[r.key]);
    // "photos of the ziplines" names its subject: answer instantly with that
    // gallery. Anything vaguer, or mixed with another request ("the pricelist
    // and some photos"), goes to the AI, which understands any language and can
    // attach several things at once.
    if (topicRule || handlePhotoRequests) {
      const topic = topicRule ? CARD_PHOTOS[topicRule.key] : 'park';
      await sendPhotosThenCard(contact, topic, topicRule?.key);
      return 'done';
    }
    return 'unhandled';
  }

  /* --- typed keywords --- */
  // "Send me the brochure" is a plain file request and is answered instantly.
  // "Give me the price list of quad" or "quad map track" only look like file
  // requests: the guest is asking about an ACTIVITY, and deserves a real answer
  // about it. Whenever an activity is named, the assistant takes the message.
  const namesActivity = ACTIVITY_WORDS.test(text);
  // Rules that name their own document ("restaurant menu", "kids park pricelist")
  // stay instant. Only the GENERIC ones (pricelist, map, packages) step aside
  // when the guest names an activity.
  const rule = RULES.find((r) => r.match.test(text) && (
    topicCards || r.key.startsWith('doc_') || (DOC_KEYS.has(r.key) && !namesActivity)
  ));
  if (rule) {
    if (rule.key === 'packages') { await sendPackagesList(contact); return 'done'; }
    if (rule.key === 'brochure') { await sendBrochure(contact); return 'done'; }
    if (rule.key === 'doc_profile') { await sendBrochure(contact, 'profile'); return 'done'; }
    if (rule.key === 'doc_presentation') { await sendBrochure(contact, 'presentation'); return 'done'; }
    if (rule.key === 'doc_resident') {
      await sendBrochure(contact, 'pricelist_resident');
      await sendBrochure(contact, 'pkg_resident');
      return 'done';
    }
    if (rule.key === 'doc_student') { await sendBrochure(contact, 'pkg_student'); return 'done'; }
    if (rule.key === 'doc_senior') { await sendBrochure(contact, 'pkg_senior'); return 'done'; }
    if (rule.key === 'doc_kidspark') { await sendBrochure(contact, 'kidspark'); return 'done'; }
    if (rule.key === 'doc_packages') {
      for (const key of ['pkg_exclusive', 'pkg_vip', 'pkg_diamond']) await sendBrochure(contact, key);
      return 'done';
    }
    if (rule.key === 'doc_factsheet') { await sendBrochure(contact, 'factsheet'); return 'done'; }
    if (rule.key === 'doc_menus') {
      await sendBrochure(contact, 'menu_chamouze');
      await sendBrochure(contact, 'menu_bigarade');
      return 'done';
    }
    if (rule.key === 'map') { await sendPhotosThenCard(contact, 'map', 'info'); return 'done'; }
    await sendCard(contact, rule.key);
    return 'done';
  }

  /* --- free text the menu can't answer --- */
  if (!handleFreeText) return 'unhandled';

  if (text.length >= 20) {
    await sendText(contact.wa_id,
      `Thank you! 📝 I've passed this to our team: a colleague will get back to you ` +
      `right here with an answer. 🌿`);
    await log(contact, '[menu] enquiry → human');
    return 'lead';
  }

  /* --- fallback --- */
  await sendButtons(
    contact.wa_id,
    `I want to make sure you get the right answer 🌿\n\n` +
    `Tap below, or reply *AGENT* and a colleague will help you personally.`,
    [
      { id: 'menu_activities', title: '🎢 Activities' },
      { id: 'menu_packages', title: '📦 Packages' },
      { id: 'menu_human', title: '💬 Talk to a person' },
    ]
  );
  await log(contact, '[menu] fallback');
  return 'done';
}

/** Send a PDF from the document library; fall back to the price card. */
async function sendBrochure(contact, key = 'brochure') {
  try {
    const ok = await sendDoc(contact.wa_id, key);
    if (!ok) throw new Error('document missing');
    await log(contact, `[menu] document sent: ${key}`);
  } catch (err) {
    console.error('[menu] document failed', key, err.message);
    await sendCard(contact, 'prices');
  }
}

/** Send a few park photos for a topic, then the matching info card. */
async function sendPhotosThenCard(contact, topic, cardKey) {
  try {
    await sendGallery(contact.wa_id, topic, 3);
    await log(contact, `[menu] photos sent: ${topic}`);
  } catch (err) {
    console.error('[menu] photos failed', topic, err.message);
  }
  if (cardKey && CARDS[cardKey]) await sendCard(contact, cardKey);
}

async function sendCard(contact, key) {
  const body = CARDS[key] + FOOTER;
  await sendText(contact.wa_id, body);
  // Store what the guest was actually told, so the assistant can build on it
  // later instead of repeating it.
  await log(contact, body);
}

async function log(contact, body) {
  await db.logMessage({ contactId: contact.id, direction: 'out', author: 'bot', body });
}
