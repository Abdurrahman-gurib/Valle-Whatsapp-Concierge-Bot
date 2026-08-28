/**
 * DOCUMENT LIBRARY — the official Vallé PDFs the bot can send on WhatsApp.
 *
 * Source of truth: assets/documents. Files come from the park's own rate cards
 * (assets/Price List) and marketing pack; oversized exports were rasterised to
 * a few hundred KB so WhatsApp accepts them and guests receive them instantly.
 * Uploaded once per file and cached (WhatsApp media ids last ~30 days).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadMedia, sendDocument } from '../whatsapp/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, '..', '..', 'assets');
/** Marketing and information documents. */
const doc = (name) => path.join(ASSETS, 'documents', name);
/** Official rate cards: the single source of truth for prices. */
const rate = (name) => path.join(ASSETS, 'price-list', name);

export const DOCS = {
  /* ── Rate cards ─────────────────────────────────────────────── */
  // The official rate card is the one and only pricelist we send.
  brochure: {
    path: rate('pricelist-standard-2026.pdf'),
    filename: 'Valle-Advenature-Park-Pricelist-2026-2027.pdf',
    caption: 'Vallé · Advenature Park™ · Pricelist, valid 1 July 2026 to 30 June 2027 🌿',
  },
  pricelist_resident: {
    path: rate('pricelist-resident-2026.pdf'),
    filename: 'Valle-Resident-Pricelist-2026-2027.pdf',
    caption: 'Resident pricelist. Rates apply on presentation of a valid Mauritian ID or permit.',
  },

  /* ── Packages ───────────────────────────────────────────────── */
  pkg_exclusive: {
    path: rate('package-exclusive-2026.pdf'),
    filename: 'Valle-Exclusive-Packages-2026.pdf',
    caption: 'Exclusive packages: Light, Standard, Bronze, Silver, Gold and Platinum.',
  },
  pkg_vip: {
    path: rate('package-vip-2026.pdf'),
    filename: 'Valle-VIP-Ultimate-2026.pdf',
    caption: 'VIP Ultimate: all inclusive, with private guide and butler service.',
  },
  pkg_diamond: {
    path: rate('package-diamond-2026.pdf'),
    filename: 'Valle-Diamond-Package-2026.pdf',
    caption: 'The Diamond Package: our ultimate day at Vallé.',
  },
  pkg_resident: {
    path: rate('package-resident-2026.pdf'),
    filename: 'Valle-Resident-Packages-2026.pdf',
    caption: 'Resident packages: Adventure Lust, Ventu Rush, Triple Thrill and Elysian Escape.',
  },
  pkg_student: {
    path: rate('package-student-2026.pdf'),
    filename: 'Valle-Student-Pricelist-2026.pdf',
    caption: 'Student rates for pre-primary, primary and secondary students, with lunch menu.',
  },
  pkg_senior: {
    path: rate('package-senior-citizen-2026.pdf'),
    filename: 'Valle-Senior-Citizen-Packages-2026.pdf',
    caption: 'Senior citizen packages, ages 55 and above, lunch and tea break included.',
  },

  /* ── Vallé Kids Park ────────────────────────────────────────── */
  kidspark: {
    path: rate('kidspark-pricelist-2026.pdf'),
    filename: 'Valle-Kids-Park-Pricelist-2026.pdf',
    caption: 'Vallé Kids Park: mini quad, mini excavator, pirate ship, roller coaster and more.',
  },
  kidspark_resident: {
    path: rate('kidspark-pricelist-resident-2026.pdf'),
    filename: 'Valle-Kids-Park-Resident-Pricelist-2026.pdf',
    caption: 'Vallé Kids Park, resident rates and points card.',
  },
  kidspark_student: {
    path: rate('kidspark-pricelist-student-2026.pdf'),
    filename: 'Valle-Kids-Park-Student-Pricelist-2026.pdf',
    caption: 'Vallé Kids Park, student rates.',
  },

  /* ── Restaurants ────────────────────────────────────────────── */
  menu_chamouze: {
    path: doc('menu-le-chamouze.pdf'),
    filename: 'Le-Chamouze-Menu-2026.pdf',
    caption: 'Le Chamouzé, our waterfall restaurant: the full à la carte menu, 2026.',
  },
  menu_bigarade: {
    path: doc('menu-la-bigarade.pdf'),
    filename: 'La-Bigarade-Menu.pdf',
    caption: 'La Bigarade: authentic Indian and Mauritian cuisine.',
  },

  /* ── Set menus that come with a package ─────────────────────── */
  // Chosen from the Chamouzé kitchen: one starter, one main, one dessert and
  // one drink. Included in the matching package, never sold separately.
  menu_explorers: {
    path: doc('menu-explorers.pdf'),
    filename: 'Valle-Explorers-Menu.pdf',
    caption: "The Explorer's Menu: 1 starter, 1 main, 1 dessert and 1 drink, "
      + 'chosen from our Chamouzé selection.',
  },
  menu_adventurers: {
    path: doc('menu-adventurers.pdf'),
    filename: 'Valle-Adventurers-Menu.pdf',
    caption: "The Adventurer's Menu: 1 starter, 1 main, 1 dessert and 1 drink, "
      + 'with the full Chamouzé selection including lobster, wagyu and venison.',
  },

  /* ── About the park ─────────────────────────────────────────── */
  presentation: {
    path: doc('valle-presentation.pdf'),
    filename: 'Valle-Advenature-Park-Presentation.pdf',
    caption: 'Vallé · Advenature Park™ in pictures: the 23 Coloured Earth, waterfalls, '
      + 'ziplines, quad and buggy, the Nepalese Bridge, dining and the Kids Park.',
  },
  profile: {
    path: doc('valle-magazine.pdf'),
    filename: 'Valle-Advenature-Park-Magazine.pdf',
    caption: 'Our story, our experiences and the spirit of Advenature.',
  },
  factsheet: {
    path: doc('valle-factsheet.pdf'),
    filename: 'Valle-Advenature-Park-Factsheet.pdf',
    caption: 'Every activity in detail: descriptions, durations and requirements.',
  },
};

const cache = new Map();

async function mediaIdFor(key, force = false) {
  if (!force && cache.has(key)) return cache.get(key);
  const id = await uploadMedia(fs.readFileSync(DOCS[key].path), 'application/pdf');
  cache.set(key, id);
  return id;
}

/** Send one of the DOCS by key. Returns false if the file is missing. */
export async function sendDoc(to, key, caption) {
  const d = DOCS[key];
  if (!d || !fs.existsSync(d.path)) return false;
  const payload = { filename: d.filename, caption: caption ?? d.caption };
  try {
    await sendDocument(to, { id: await mediaIdFor(key), ...payload });
  } catch {
    await sendDocument(to, { id: await mediaIdFor(key, true), ...payload });
  }
  return true;
}
