#!/usr/bin/env node
/**
 * ATM DUBAI POSTER — the stand poster with the QR code, as PNG and PDF.
 *
 *   npm run poster
 *
 * Built to Vallé Brand Guidelines V2 (March 2025), Maximalist layout, Style 2
 * (11.4: logo and descriptor lockup, headline as the hero):
 *   · Vallé Purple on white, Sunshine Radiance for the wordmark on purple,
 *     Neon Emerald for the Slope at the top and the Adrena-lines (7.1, 7.2)
 *   · Barlow ExtraBold Italic headline at the 4° tilt, 80% leading (8.1, 8.5)
 *   · Work Sans body, Chivo Mono for the practical details (8.2, 8.3)
 *   · The Slope edge to edge, 180° at the top and 0° at the bottom (9.3)
 *   · Adrena-lines in one colour, at an angle, never under text (9.8)
 *   · Logo lockup and URL lockup as supplied (5.3, 6.1)
 *
 * The QR encodes the same wa.me link as assets/qr/valle-atm-dubai.png, drawn
 * in Vallé Purple. Needs Google Chrome for the fonts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKETING = path.join(ROOT, 'assets', 'marketing');
const TMP = path.join(ROOT, 'logs', 'poster');
fs.mkdirSync(TMP, { recursive: true });

const NUMBER = process.env.BUSINESS_NUMBER || '23052928841';
const MESSAGE = 'Greetings! It was lovely meeting you at ATM Dubai 2026. I am excited to discover more about Vallé Advenature Park and the unforgettable experiences it offers in Mauritius.';
const LINK = `https://wa.me/${NUMBER}?text=${encodeURIComponent(MESSAGE)}`;

/* Vallé palette, 7.1: the primary and all four secondary colours */
const PURPLE = '#340057';   // Vallé Purple, Pantone 2617 C
const SCARLET = '#FF3358';  // Scarlet Rush, Pantone 1787 C
const INDIGO = '#7333FF';   // Tropical Indigo, Pantone 2665 C
const YELLOW = '#FFFC33';   // Sunshine Radiance, Pantone 803 C
const GREEN = '#33FF74';    // Neon Emerald, Pantone 802 C
const WHITE = '#FFFFFF';

function chromePath() {
  const c = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  const hit = c.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('Google Chrome not found; set CHROME_PATH');
  return hit;
}
const dataUri = (file, mime) => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;

/** Purple-on-white guideline artwork as white-on-transparent. */
async function whiteVersion(src, out) {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const a = 255 - Math.round((data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3);
    px[i * 4] = 255; px[i * 4 + 1] = 255; px[i * 4 + 2] = 255; px[i * 4 + 3] = a;
  }
  await sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(out);
  return out;
}

(async () => {
  console.log('Rendering the ATM Dubai poster');
  const qr = await QRCode.toDataURL(LINK, { errorCorrectionLevel: 'H', width: 900, margin: 1, color: { dark: PURPLE, light: WHITE } });
  const lockup = dataUri(path.join(MARKETING, 'valle-lockup-purple.png'), 'image/png');
  const urlWhite = dataUri(await whiteVersion(path.join(MARKETING, 'valle-url-lockup-purple.png'), path.join(TMP, 'url-white.png')), 'image/png');
  const wordmarkYellow = dataUri(path.join(MARKETING, 'valle-logo.svg'), 'image/svg+xml');

  // A4 at 96 dpi: 794 x 1123 CSS px. Rendered at 3x for print (2382 x 3369).
  const W = 794, H = 1123;
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Barlow:ital,wght@1,800&family=Work+Sans:wght@400;600;700&family=Chivo+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  @page { size: A4 portrait; margin: 0; }
  html,body{margin:0;padding:0;background:${WHITE};width:${W}px;height:${H}px;overflow:hidden;position:relative;
    font-family:'Work Sans',Tahoma,sans-serif;color:${PURPLE};-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .head{font-family:'Barlow',Tahoma,sans-serif;font-style:italic;font-weight:800;text-transform:uppercase}
  .mono{font-family:'Chivo Mono',Consolas,monospace}
  /* the Slope at the top, 180°: 7% fall from left to right, edge to edge (9.3) */
  .slope-top{position:absolute;left:0;right:0;top:0;height:96px;background:${GREEN};clip-path:polygon(0 0,100% 0,100% 40px,0 96px)}
  /* a flexible secondary Slope in Scarlet Rush under the primary one (9.2) */
  .slope-top2{position:absolute;left:0;right:0;top:0;height:112px;background:${SCARLET};clip-path:polygon(0 96px,100% 40px,100% 54px,0 110px)}
  .lockup{position:absolute;left:56px;top:124px;width:150px}
  .eyebrow{position:absolute;right:56px;top:130px;text-align:right;font-size:12px;letter-spacing:.16em;line-height:1.6;color:${SCARLET};font-weight:600}
  /* headline: Barlow ExtraBold Italic, 4° tilt, 80% leading (8.1, 8.5) */
  h1{position:absolute;left:56px;top:232px;margin:0;font-size:82px;line-height:.8;letter-spacing:-.01em;transform:rotate(-4deg);transform-origin:left bottom;color:${PURPLE};width:640px}
  h1 small{display:block;font-size:28px;line-height:1;margin-top:16px;letter-spacing:.01em;color:${INDIGO}}
  /* two columns below the headline: words on the left, the QR on the right */
  /* left column ends 32px before the QR card (card spans 488 to 738) */
  .lead{position:absolute;left:56px;top:452px;width:396px;font-size:16px;line-height:1.5}
  .lead b{font-weight:700}
  .asks{position:absolute;left:56px;top:556px;width:396px}
  .asks .k{font-size:22px;letter-spacing:.02em;margin-bottom:8px;color:${SCARLET}}
  .asks ul{margin:0;padding:0;list-style:none;font-size:14px;line-height:1.7}
  .asks li::before{content:'\\2192  ';color:${INDIGO};font-weight:700}
  .card{position:absolute;right:56px;top:452px;width:250px;box-sizing:border-box;background:${WHITE};border:3px solid ${INDIGO};padding:16px 16px 14px;text-align:center}
  .card .t{font-size:12px;letter-spacing:.08em;margin-bottom:10px;color:${SCARLET}}
  .card img{width:100%;display:block}
  .card .n{font-size:14px;font-weight:600;margin-top:10px;letter-spacing:.04em}
  .card .s{font-size:10.5px;margin-top:6px;line-height:1.45}
  .features{position:absolute;left:56px;right:56px;top:842px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;line-height:1.6;white-space:nowrap}
  /* the primary Slope at the bottom, 0° (9.3), with the wordmark in Sunshine Radiance (7.2) */
  .slope{position:absolute;left:0;right:0;bottom:0;height:250px;background:${PURPLE};clip-path:polygon(0 56px,100% 0,100% 100%,0 100%)}
  .lines{position:absolute;right:0;top:${H - 250}px;width:250px;height:120px;background:repeating-linear-gradient(-38deg,${GREEN} 0 14px,transparent 14px 38px);clip-path:polygon(0 22px,100% 0,100% 100%,0 100%)}
  .mark{position:absolute;left:52px;bottom:76px;width:380px}
  /* "MAURITIUS" under the wordmark, aligned to its left edge */
  .sub{position:absolute;left:58px;bottom:44px;font-size:19px;letter-spacing:.3em;color:${WHITE}}
  .url{position:absolute;right:56px;bottom:46px;width:210px}
  .foot{position:absolute;left:56px;right:56px;bottom:14px;display:flex;justify-content:space-between;font-size:10.5px;letter-spacing:.06em;color:${WHITE};opacity:.85}
</style></head><body>
  <div class="slope-top"></div>
  <div class="slope-top2"></div>
  <img class="lockup" src="${lockup}" alt="Vallé Advenature Park">
  <div class="eyebrow mono">ARABIAN TRAVEL MARKET<br>DUBAI &middot; 2026</div>

  <h1 class="head">We met at<br>ATM Dubai<small>Let's keep the conversation going.</small></h1>

  <div class="lead">Scan, say hello on WhatsApp, and our <b>Advenature assistant</b> answers straight away, in your own language, by text or voice note.</div>

  <div class="asks">
    <div class="k head">Ask it anything</div>
    <ul>
      <li>Prices, packages and the full pricelist PDF</li>
      <li>Ziplines, quad, buggy, luge, the Nepalese Bridge</li>
      <li>Restaurant menus, opening hours, location and map</li>
      <li>Photos of the park, sent right into the chat</li>
      <li>Send a <b>voice note</b>, get a spoken reply</li>
      <li>Book a visit, or ask for a person</li>
    </ul>
  </div>

  <div class="card">
    <div class="t head">Scan to chat on WhatsApp</div>
    <img src="${qr}" alt="QR code">
    <div class="n mono">+230 5292 8841</div>
    <div class="s">WhatsApp opens with your message ready. Press send.</div>
  </div>

  <div class="features mono">Ziplines to 5.5 km &middot; Quad &amp; Buggy &middot; Nepalese Bridge &middot; 23 Coloured Earth &middot; Luge &middot; Kids Park</div>

  <div class="slope"></div>
  <div class="lines"></div>
  <img class="mark" src="${wordmarkYellow}" alt="VALLÉ">
  <div class="sub head">Mauritius</div>
  <img class="url" src="${urlWhite}" alt="vallepark.com">
  <div class="foot mono"><span>B102, MARE ANGUILLES, CHAMOUNY, MAURITIUS</span><span>WHERE NATURE &amp; ADVENTURE COLLIDE</span></div>
</body></html>`;

  const file = path.join(TMP, 'poster.html');
  fs.writeFileSync(file, html);
  const chrome = chromePath();
  const png = path.join(MARKETING, 'valle-atm-dubai-poster.png');
  const pdf = path.join(MARKETING, 'valle-atm-dubai-poster.pdf');
  const fileUrl = `file:///${file.replace(/\\/g, '/')}`;
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=3',
    `--window-size=${W},${H}`, '--virtual-time-budget=10000', `--screenshot=${png}`, fileUrl], { stdio: 'ignore' });
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=10000',
    `--print-to-pdf=${pdf}`, fileUrl], { stdio: 'ignore' });
  const meta = await sharp(png).metadata();
  console.log(`  ${path.basename(png)}  ${meta.width}x${meta.height}`);
  console.log(`  ${path.basename(pdf)}  ${Math.round(fs.statSync(pdf).size / 1024)} KB`);
  console.log(`  QR encodes: ${LINK.slice(0, 80)}...`);
})().catch((err) => { console.error(err.message); process.exit(1); });
