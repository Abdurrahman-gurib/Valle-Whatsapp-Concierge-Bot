#!/usr/bin/env node
/**
 * PREPARE ASSETS — makes new park material sendable on WhatsApp.
 *
 *   npm run assets                       # prepare everything that needs it
 *   npm run assets -- --check            # report only, change nothing
 *
 * Designers export beautiful PDFs that can run to hundreds of megabytes;
 * WhatsApp refuses anything over 100 MB and guests will not wait for 20 MB.
 * This rasterises oversized PDFs at print quality (keeping their orientation)
 * and converts AVIF/WebP photographs to the JPEG that WhatsApp accepts.
 *
 * Drop new files into:
 *   source-material/originals/price-list-original/   rate cards
 *   source-material/originals/                       brochures, presentations
 *   source-material/original-images/                 photographs
 * then run this script; prepared files land in assets/price-list,
 * assets/documents and assets/photos.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');
const sharp = require('sharp');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');
const MAX_PDF_MB = 8;          // anything larger is rasterised
const TMP = path.join(ROOT, 'source-material', '.prepare-tmp');

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

function chromePath() {
  for (const p of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ]) if (fs.existsSync(p)) return p;
  throw new Error('Chrome not found: needed to rebuild oversized PDFs');
}

/** Rasterise a heavy PDF into a light one, keeping page orientation. */
async function shrinkPdf(src, out) {
  fs.mkdirSync(TMP, { recursive: true });
  const parser = new PDFParse({ data: fs.readFileSync(src) });
  const shot = await parser.getScreenshot({ scale: 2 });
  await parser.destroy();

  const imgs = [];
  let landscape = false;
  for (const [i, pg] of (shot.pages || []).entries()) {
    const raw = pg.data ?? pg.image ?? pg.dataUrl;
    const buf = typeof raw === 'string'
      ? Buffer.from(String(raw).replace(/^data:image\/\w+;base64,/, ''), 'base64')
      : Buffer.from(raw);
    const meta = await sharp(buf).metadata();
    if (i === 0) landscape = meta.width > meta.height;
    const jpg = await sharp(buf)
      .resize({ width: landscape ? 2339 : 1654, withoutEnlargement: true })
      .jpeg({ quality: 76, mozjpeg: true })
      .toBuffer();
    imgs.push(jpg.toString('base64'));
  }

  const [w, h] = landscape ? [1123, 794] : [794, 1123];
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 0; }
html,body{margin:0;padding:0}
.p{width:${w}px;height:${h}px;page-break-after:always}
.p:last-child{page-break-after:auto}
.p img{width:100%;height:100%;object-fit:contain;display:block;background:#fff}
</style></head><body>${
    imgs.map((b) => `<div class="p"><img src="data:image/jpeg;base64,${b}"></div>`).join('')
  }</body></html>`;

  const htmlPath = path.join(TMP, 'page.html').split(path.sep).join('/');
  fs.writeFileSync(htmlPath, html);
  execFileSync(chromePath(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--virtual-time-budget=45000',
    `--print-to-pdf=${out}`, '--no-pdf-header-footer', `file:///${htmlPath}`,
  ], { stdio: 'ignore' });
}

/** Copy a PDF into place, rasterising it first when it is too heavy to send. */
async function preparePdf(src, out) {
  const size = fs.statSync(src).size;
  if (size <= MAX_PDF_MB * 1024 * 1024) {
    if (!CHECK_ONLY) fs.copyFileSync(src, out);
    return `copied (${mb(size)} MB)`;
  }
  if (CHECK_ONLY) return `WOULD SHRINK (${mb(size)} MB)`;
  await shrinkPdf(src, out);
  return `${mb(size)} MB → ${mb(fs.statSync(out).size)} MB`;
}

/** Convert one photograph to the JPEG WhatsApp accepts. */
async function preparePhoto(src, out) {
  if (CHECK_ONLY) return 'would convert';
  await sharp(src).rotate().resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true }).toFile(out);
  return `${mb(fs.statSync(out).size)} MB`;
}

async function run() {
  const jobs = [
    {
      label: 'rate cards',
      from: path.join(ROOT, 'source-material', 'originals', 'price-list-original'),
      to: path.join(ROOT, 'assets', 'price-list'),
      match: /\.pdf$/i, prepare: preparePdf, rename: (f) => f,
    },
    {
      label: 'documents',
      from: path.join(ROOT, 'source-material', 'originals'),
      to: path.join(ROOT, 'assets', 'documents'),
      match: /\.pdf$/i, prepare: preparePdf, rename: (f) => f,
      shallow: true,
    },
    {
      label: 'photographs',
      from: path.join(ROOT, 'source-material', 'original-images'),
      to: path.join(ROOT, 'assets', 'photos'),
      match: /\.(avif|webp|png|jpe?g)$/i, prepare: preparePhoto,
      rename: (f) => f.replace(/\.[^.]+$/, '.jpg'),
    },
  ];

  for (const job of jobs) {
    if (!fs.existsSync(job.from)) continue;
    fs.mkdirSync(job.to, { recursive: true });
    const files = fs.readdirSync(job.from, { withFileTypes: true })
      .filter((e) => e.isFile() && job.match.test(e.name))
      .map((e) => e.name);
    console.log(`\n${job.label}: ${files.length} file(s) in ${path.relative(ROOT, job.from)}`);
    for (const f of files) {
      const out = path.join(job.to, job.rename(f));
      if (fs.existsSync(out) && !CHECK_ONLY) { console.log(`  · ${f} — already prepared`); continue; }
      try {
        console.log(`  · ${f} — ${await job.prepare(path.join(job.from, f), out)}`);
      } catch (err) {
        console.error(`  ! ${f} — ${err.message}`);
      }
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(CHECK_ONLY ? '\nCheck complete, nothing changed.' : '\nAssets ready.');
}

run().catch((err) => { console.error(err); process.exit(1); });
