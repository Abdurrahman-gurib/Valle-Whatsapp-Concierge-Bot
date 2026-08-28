#!/usr/bin/env node
/**
 * EMAIL ARTWORK — renders the parts of the overview email that email clients
 * cannot draw themselves: the 4-degree Slope, the tilted Barlow headline, the
 * Adrena-lines and the logo lockups. Everything comes out as PNG and is
 * embedded in the email inline, so the letter looks the same in every client.
 *
 *   npm run email:assets
 *
 * Follows Vallé Brand Guidelines V2 (March 2025):
 *   · Midimalist layout (11.5): the system for corporate communication
 *   · The Slope (9.2/9.3): 7% incline, edge to edge, 0° when at the bottom
 *   · The Adrena-lines (9.5): one colour, always at an angle, never a pattern fill
 *   · Barlow ExtraBold Italic headlines at a 4° tilt, 80% leading (8.1, 8.5)
 *   · Logo lockup and URL lockup used as supplied, never redrawn (5.3, 6.1)
 *   · Colour combinations from 7.2: white and green on Vallé Purple
 *
 * Needs Google Chrome (for the fonts) and the artwork in assets/marketing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKETING = path.join(ROOT, 'assets', 'marketing');
const TMP = path.join(ROOT, 'logs', 'email-assets');
fs.mkdirSync(TMP, { recursive: true });

/* Vallé palette, Brand Guidelines 7.1 */
const PURPLE = '#340057';
const GREEN = '#33FF74';
const WHITE = '#FFFFFF';

const WIDTH = 600;

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('Google Chrome not found; set CHROME_PATH');
  return hit;
}

const dataUri = (file, mime) => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;

/** Purple-on-white artwork from the guideline, turned into white-on-transparent. */
async function whiteVersion(src, out) {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const darkness = 255 - Math.round((r + g + b) / 3);   // purple ≈ dark, paper ≈ light
    px[i * 4] = 255; px[i * 4 + 1] = 255; px[i * 4 + 2] = 255; px[i * 4 + 3] = darkness;
  }
  await sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(out);
  return out;
}

/** The wordmark from vallepark.com's SVG, in any flat colour. */
function wordmark(colour, out) {
  const svg = fs.readFileSync(path.join(MARKETING, 'valle-logo.svg'), 'utf8').replace(/#FFFC33/gi, colour);
  fs.writeFileSync(out, svg);
  return out;
}

async function render(name, html, height) {
  const file = path.join(TMP, `${name}.html`);
  const png = path.join(MARKETING, `email-${name}.png`);
  fs.writeFileSync(file, html);
  execFileSync(chromePath(), [
    // 3x: the letter is fluid, so on a wide reading pane the header can be
    // shown at 1,000px and more without going soft.
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=3',
    `--window-size=${WIDTH},${height}`, '--virtual-time-budget=10000',
    `--screenshot=${png}`, `file:///${file.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore' });
  const meta = await sharp(png).metadata();
  console.log(`  ${path.basename(png)}  ${meta.width}x${meta.height}`);
}

const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Barlow:ital,wght@1,800&family=Work+Sans:wght@400;700&family=Chivo+Mono:wght@400&display=swap" rel="stylesheet">`;
const HEAD = `font-family:'Barlow',Tahoma,sans-serif;font-style:italic;font-weight:800;text-transform:uppercase`;
const BODY = `font-family:'Work Sans',Tahoma,sans-serif`;
const MONO = `font-family:'Chivo Mono',Consolas,monospace`;

(async () => {
  console.log('Rendering email artwork');

  const lockupPurple = path.join(MARKETING, 'valle-lockup-purple.png');
  const urlPurple = path.join(MARKETING, 'valle-url-lockup-purple.png');
  const urlWhite = await whiteVersion(urlPurple, path.join(TMP, 'url-white.png'));
  const markWhite = wordmark(WHITE, path.join(TMP, 'wordmark-white.svg'));
  const photo = path.join(ROOT, 'assets', 'photos', 'home-overview.jpg');

  /* ── Header: lockup, the drone shot, the tilted headline ── */
  const headerHeight = 500;
  await render('header', `<!doctype html><html><head><meta charset="utf-8">${FONTS}
<style>
  html,body{margin:0;padding:0;background:${WHITE};width:${WIDTH}px;height:${headerHeight}px;overflow:hidden}
  .top{height:96px;display:flex;align-items:center;justify-content:space-between;padding:0 32px}
  .top img{height:58px;width:auto}
  .tag{${MONO};font-size:12px;letter-spacing:.14em;color:${PURPLE};text-align:right;line-height:1.5}
  .photo{height:270px;background:url(${dataUri(photo, 'image/jpeg')}) center 45%/cover no-repeat}
  .head{padding:36px 32px 0}
  h1{${HEAD};font-size:66px;line-height:.8;margin:0;color:${PURPLE};transform:rotate(-4deg);transform-origin:left bottom;letter-spacing:-.01em}
  h1 span{display:block;font-size:34px;line-height:.9;margin-top:10px}
</style></head><body>
  <div class="top"><img src="${dataUri(lockupPurple, 'image/png')}" alt="Vallé Advenature Park"><div class="tag">ATM DUBAI 2026<br>STAND FOLLOW-UP</div></div>
  <div class="photo"></div>
  <div class="head"><h1>Mersi!<span>for stopping by our stand</span></h1></div>
</body></html>`, headerHeight);

  /* ── Footer: the primary Slope at 0°, the wordmark, the Adrena-lines, the URL lockup ── */
  const footerHeight = 190;
  await render('footer', `<!doctype html><html><head><meta charset="utf-8">${FONTS}
<style>
  html,body{margin:0;padding:0;background:${WHITE};width:${WIDTH}px;height:${footerHeight}px;overflow:hidden;position:relative}
  /* 7% slope: over 600px the top edge rises 42px, and it runs edge to edge */
  .slope{position:absolute;left:0;right:0;bottom:0;height:${footerHeight}px;background:${PURPLE};clip-path:polygon(0 42px,100% 0,100% 100%,0 100%)}
  /* Adrena-lines: one colour, at an angle, in their own corner. Never under text (9.8). */
  .lines{position:absolute;right:0;top:0;width:200px;height:96px;
    background:repeating-linear-gradient(-38deg,${GREEN} 0 11px,transparent 11px 30px);
    clip-path:polygon(0 14px,100% 0,100% 100%,0 100%)}
  .mark{position:absolute;left:28px;bottom:24px;width:290px;height:auto}
  .url{position:absolute;right:28px;bottom:26px;width:160px;height:auto}
</style></head><body>
  <div class="slope"></div>
  <div class="lines"></div>
  <img class="mark" src="${dataUri(markWhite, 'image/svg+xml')}" alt="VALLÉ">
  <img class="url" src="${dataUri(urlWhite, 'image/png')}" alt="vallepark.com">
</body></html>`, footerHeight);

  /* ── Eight photos, each a different place and mood, for a 2-up grid.
        Sized for retina in a fluid layout (up to ~800px per cell). ── */
  const PHOTOS = [
    ['zipline', 'zipline-waterfall.jpg'],                      // flying past the falls
    ['bicycle', 'bicycle-joy.jpg'],                            // the Bicycle Zipline, unique to Mauritius
    ['quad', 'quad-river.jpg'],                                // river crossing
    ['buggy', 'buggy-forest.jpg'],                             // forest track
    ['bridge', 'bridge-family.jpg'],                           // a family on the Nepalese Bridge
    ['luge', 'luge-race.jpg'],                                 // the Mountain Luge Kart
    ['waterfall', 'valle-waterfall-nature-trail-mauritius.jpg'], // guests at the waterfall
    ['tortoise', 'valle-giant-tortoise-park-mauritius.jpg'],   // the giant tortoises
  ];
  for (const [key, file] of PHOTOS) {
    const out = path.join(MARKETING, `email-photo-${key}.jpg`);
    await sharp(path.join(ROOT, 'assets', 'photos', file))
      .resize(800, 560, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: 76, mozjpeg: true })
      .toFile(out);
    console.log(`  ${path.basename(out)}  ${Math.round(fs.statSync(out).size / 1024)} KB`);
  }

  console.log('Done. Artwork in assets/marketing/email-*.png and email-photo-*.jpg');
})().catch((err) => { console.error(err.message); process.exit(1); });
