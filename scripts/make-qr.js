#!/usr/bin/env node
/**
 * QR GENERATOR — Vallé WhatsApp
 *
 *   npm run qr                       → all placements
 *   npm run qr -- --only=reception   → just one
 *
 * Each QR encodes a wa.me deep link with a DIFFERENT prefilled message.
 * Two reasons that matters:
 *   1. The guest only has to press send — no typing.
 *   2. The wording tells the bot which sign they scanned, so you get
 *      analytics per placement and a tailored greeting.
 *
 * Output: assets/qr/*.png (print, 1200 px), /qr/*.svg (vector, any size), /qr/index.html (preview)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'assets', 'qr');

// Digits only, country code included. +230 5292 8841 → 23052928841
const NUMBER = (process.env.BUSINESS_NUMBER || '23052928841').replace(/\D/g, '');

// Vallé brand colours — deep forest green on white scans reliably.
const DARK = '#14432A';
const LIGHT = '#FFFFFF';

const PLACEMENTS = [
  {
    slug: 'atm-dubai',
    label: 'ATM Dubai 2026 — trade show stand & badges',
    text: 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.',
  },
  {
    slug: 'reception',
    label: 'Reception / Ticket desk',
    text: 'Hi Vallé! I am at reception and I would like some help 🌿',
  },
  {
    slug: 'general',
    label: 'General — website, email signature, social',
    text: 'Hi Vallé! I would like to know more about your activities and prices 🌿',
  },
  {
    slug: 'flyer',
    label: 'Flyer / Brochure / Print ad',
    text: 'Hi Vallé! I saw your flyer and I would like more information 🌿',
  },
  {
    slug: 'zipline',
    label: 'Zipline departure point',
    text: 'Hi Vallé! I am at the zipline point and I have a question 🌿',
  },
  {
    slug: 'quad',
    label: 'Quad & buggy base',
    text: 'Hi Vallé! I am at the quad base and I have a question 🌿',
  },
  {
    slug: 'restaurant',
    label: 'Restaurant tables (La Bigarade / Le Chamouzé)',
    text: 'Hi Vallé! I am at the restaurant and I would like some help 🌿',
  },
  {
    slug: 'hotel',
    label: 'Hotel partners / concierge desks',
    text: 'Hi Vallé! My hotel recommended you — I would like to book 🌿',
  },
];

function waLink({ text }) {
  return `https://wa.me/${NUMBER}?text=${encodeURIComponent(text)}`;
}

async function main() {
  const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
  const list = only ? PLACEMENTS.filter((p) => p.slug === only) : PLACEMENTS;

  if (!list.length) {
    console.error(`No placement "${only}". Options: ${PLACEMENTS.map((p) => p.slug).join(', ')}`);
    process.exit(1);
  }

  await fs.mkdir(OUT, { recursive: true });

  const rows = [];

  for (const p of list) {
    const url = waLink(p);

    // PNG for print — 1200 px, wide quiet zone, high error correction so a
    // logo can be dropped in the middle without breaking the scan.
    await QRCode.toFile(path.join(OUT, `valle-${p.slug}.png`), url, {
      errorCorrectionLevel: 'H',
      type: 'png',
      width: 1200,
      margin: 4,
      color: { dark: DARK, light: LIGHT },
    });

    // SVG for designers — scales to a billboard with no pixelation.
    const svg = await QRCode.toString(url, {
      errorCorrectionLevel: 'H',
      type: 'svg',
      margin: 4,
      color: { dark: DARK, light: LIGHT },
    });
    await fs.writeFile(path.join(OUT, `valle-${p.slug}.svg`), svg);

    const dataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'H', width: 300, margin: 2,
      color: { dark: DARK, light: LIGHT },
    });

    rows.push({ ...p, url, dataUrl });
    console.log(`✅ ${p.slug.padEnd(12)} → valle-${p.slug}.png / .svg`);
    console.log(`   ${url}\n`);
  }

  await fs.writeFile(path.join(OUT, 'index.html'), preview(rows));
  console.log(`📄 Preview sheet: assets/qr/index.html  (open it, then print)`);
}

function preview(rows) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Vallé — WhatsApp QR codes</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;600;800&display=swap');
  *{box-sizing:border-box} 
  body{font-family:Outfit,system-ui,sans-serif;margin:0;padding:48px 32px;background:#F7F5F0;color:#14432A}
  h1{font-weight:800;font-size:30px;margin:0 0 6px;letter-spacing:-.02em}
  .sub{color:#6B7F72;margin:0 0 40px;font-weight:300}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:28px}
  .card{background:#fff;border:1px solid #E3E0D8;border-radius:20px;padding:28px;text-align:center;
        page-break-inside:avoid;box-shadow:0 1px 3px rgba(20,67,42,.06)}
  .card img{width:100%;max-width:230px;display:block;margin:0 auto 18px}
  .label{font-weight:600;font-size:16px;margin-bottom:8px}
  .msg{font-size:12.5px;color:#6B7F72;font-style:italic;line-height:1.5;margin-bottom:14px;font-weight:300}
  .cta{font-weight:800;font-size:13px;letter-spacing:.09em;text-transform:uppercase}
  code{font-size:10px;color:#9AA89F;word-break:break-all;display:block;margin-top:10px;font-weight:300}
  @media print{body{background:#fff;padding:0}.card{border:1px solid #ccc;box-shadow:none}}
</style></head><body>
<h1>Vallé — WhatsApp QR codes</h1>
<p class="sub">Scan → WhatsApp opens with the message ready → guest presses send → the bot replies instantly.</p>
<div class="grid">
${rows.map((r) => `  <div class="card">
    <img src="${r.dataUrl}" alt="QR — ${r.label}">
    <div class="label">${r.label}</div>
    <div class="msg">"${r.text}"</div>
    <div class="cta">Scan to chat with us</div>
    <code>${r.url}</code>
  </div>`).join('\n')}
</div>
</body></html>`;
}

main().catch((e) => { console.error(e); process.exit(1); });
