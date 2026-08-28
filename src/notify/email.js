/**
 * EMAIL — Resend.
 *
 * A guest who gives us their address gets the illustrated Vallé overview as a
 * PDF, with a proper letter around it. That address is the one thing WhatsApp
 * never gives us and the one thing worth keeping: WhatsApp only allows a
 * free-form reply within 24 hours of the guest's last message, so months after
 * the show the mailbox is how we reach the people we met at ATM Dubai.
 *
 * THE LETTER FOLLOWS VALLÉ BRAND GUIDELINES V2 (MARCH 2025)
 *   · Layout: Midimalist (11.5), the system for corporate communication:
 *     white ground, reduced colour, the lockup up top, the purple Slope with
 *     the wordmark and the URL lockup at the bottom.
 *   · Colour (7.1): Vallé Purple #340057 for all text; Lavender Mist #EBE2FF
 *     from the pastel palette (7.3) for the one panel; Sunshine Radiance
 *     #FFFC33 on purple for the button, an approved combination (7.2).
 *   · Type (8.x): Barlow ExtraBold Italic headlines, Work Sans body at 120%
 *     leading, Chivo Mono for technical details, Tahoma as the system fallback
 *     the guideline names for email (8.6).
 *   · The Slope, the tilted headline, the Adrena-lines and both lockups are
 *     images, rendered by scripts/make-email-assets.js, because no email
 *     client can draw a 4-degree tilt. They travel inside the message.
 *   · Voice (1.5): Kreol warmth. "Mersi!" is the guideline's own sign-off.
 *
 * Switched on purely by configuration: with no RESEND_API_KEY the module is
 * inert and nothing is ever sent. Resend's REST API takes JSON with base64
 * attachments, so no SDK is needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../core/config.js';
import { DOCS } from '../bot/documents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://api.resend.com/emails';
const MARKETING = path.join(__dirname, '..', '..', 'assets', 'marketing');

/** Which PDF goes out as "the overview". */
const OVERVIEW = 'presentation';

/** Rendered by `npm run email:assets`, embedded inline by content id. */
const ARTWORK = [
  { cid: 'valle-header', file: path.join(MARKETING, 'email-header.png') },
  { cid: 'valle-footer', file: path.join(MARKETING, 'email-footer.png') },
  ...['zipline', 'bicycle', 'quad', 'buggy', 'bridge', 'luge', 'waterfall', 'tortoise']
    .map((k) => ({ cid: `photo-${k}`, file: path.join(MARKETING, `email-photo-${k}.jpg`) })),
];

/**
 * Eight photos in the letter, each a different place and a different mood:
 * high pulse and low pulse, water, forest, earth, and people in all of them.
 */
const PHOTOS = [
  { cid: 'photo-zipline', title: 'Ziplines', line: 'Eight courses, up to 5.5 km, past the falls' },
  { cid: 'photo-bicycle', title: 'Bicycle Zipline', line: 'Pedal 18 m above the lake, unique in Mauritius' },
  { cid: 'photo-quad', title: 'Quad', line: 'River crossings on the Adventure Track' },
  { cid: 'photo-buggy', title: 'Buggy', line: 'Forest trails, up to four seats' },
  { cid: 'photo-bridge', title: 'Nepalese Bridge', line: '350 m long, up to 100 m above the ground' },
  { cid: 'photo-luge', title: 'Mountain Luge Kart', line: 'Gravity, curves and a lot of laughing' },
  { cid: 'photo-waterfall', title: 'The Waterfalls', line: 'Chamouzé, Vacoas and Cheveux d\'Ange' },
  { cid: 'photo-tortoise', title: 'The Wildest Locals', line: 'Giant tortoises, deer and endemic forest' },
];

const MAPS = 'https://maps.google.com/?q=Vall%C3%A9+Advenature+Park+Chamouny+Mauritius';
const SITE = 'https://www.vallepark.com';

/** True when Resend is configured. */
export const emailEnabled = () => Boolean(config.email.apiKey && config.email.from);

/**
 * A plausible address, checked before we spend a send on it. Deliberately
 * permissive about the domain and strict about the shape: guests type these
 * on a phone, so "marie@gmail" must fail and "o'brien@vallepark.com" must pass.
 */
const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/i;

/** The first address in a message, lowercased, or null. */
export function findEmail(text) {
  const hit = String(text || '').match(EMAIL_RE);
  if (!hit) return null;
  const addr = hit[0].toLowerCase().replace(/[.,;:]+$/, '');
  // A trailing dot in the domain, or a domain with no letters, is a typo.
  return /\.[a-z]{2,24}$/.test(addr) ? addr : null;
}

/* ─────────────────────── the Vallé palette, Brand Guidelines 7.1 and 7.3 ─────────────────────── */
const PURPLE = '#340057';        // Vallé Purple, Pantone 2617 C
const YELLOW = '#FFFC33';        // Sunshine Radiance, Pantone 803 C
const LAVENDER = '#EBE2FF';      // Lavender Mist, Pantone 263 C
const WHITE = '#FFFFFF';

/* Type, Brand Guidelines 8.1 to 8.6. Tahoma is the named system fallback. */
const HEAD = "'Barlow', Tahoma, Arial, sans-serif";
const BODY = "'Work Sans', Tahoma, Arial, sans-serif";
const MONO = "'Chivo Mono', Consolas, 'Courier New', monospace";

/* ─────────────────────── the letter ─────────────────────── */

function html(firstName) {
  const hello = firstName ? `Dear ${escapeHtml(firstName)},` : 'Hello,';
  const P = `margin:0 0 16px;font-family:${BODY};font-size:16px;line-height:1.5;color:${PURPLE}`;
  const SUB = `margin:0 0 8px;font-family:${HEAD};font-style:italic;font-weight:800;font-size:18px;letter-spacing:.02em;text-transform:uppercase;color:${PURPLE}`;
  const LI = `font-family:${BODY};font-size:15px;line-height:1.55;color:${PURPLE}`;
  const ACCENT = `font-family:${MONO};font-size:13px;line-height:1.7;color:${PURPLE}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Barlow:ital,wght@1,800&family=Work+Sans:wght@400;700&family=Chivo+Mono:wght@400&display=swap" rel="stylesheet">
<title>Your Vallé Advenature Park overview</title></head>
<body style="margin:0;padding:0;background:${WHITE}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${WHITE};padding:0 0 24px">
<tr><td align="center">
<!-- fluid: the letter fills the reading pane edge to edge, as the Slope must (9.3) -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${WHITE}">

  <!-- header: lockup, the park from above, the tilted headline (image, Midimalist) -->
  <tr><td style="padding:0;line-height:0">
    <img src="cid:valle-header" alt="Vallé Advenature Park. Mersi for stopping by our stand at ATM Dubai 2026." style="display:block;width:100%;height:auto;border:0">
  </td></tr>

  <!-- letter -->
  <tr><td style="padding:8px 32px 0">
    <p style="${P}">${hello}</p>
    <p style="${P}">It was a pleasure to meet you at <strong>ATM Dubai 2026</strong>. As promised, the full overview of Vallé is attached as a PDF.</p>
    <p style="${P}">Vallé began as a family tea plantation in Chamouny, in the south of Mauritius. The discovery of 23 hues of coloured earth on the estate turned it into something else entirely: a place where serenity and thrill coexist, and where you are not an observer but part of the story.</p>
  </td></tr>

  <!-- eight photos, 2-up (photography 12.3: the attractions in motion, the park, the guests) -->
  <tr><td style="padding:6px 32px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${PHOTOS.reduce((rows, ph, i) => { if (i % 2 === 0) rows.push([]); rows[rows.length - 1].push(ph); return rows; }, []).map((row) => `<tr>${row.map((ph, i) => `
        <td width="50%" valign="top" style="padding:0 ${i ? 0 : 8}px 18px ${i ? 8 : 0}px">
          <img src="cid:${ph.cid}" alt="${ph.title}" style="display:block;width:100%;height:auto;border:0">
          <p style="margin:8px 0 0;font-family:${HEAD};font-style:italic;font-weight:800;font-size:15px;letter-spacing:.03em;text-transform:uppercase;color:${PURPLE}">${ph.title}</p>
          <p style="margin:2px 0 0;font-family:${MONO};font-size:12px;line-height:1.5;color:${PURPLE}">${ph.line}</p>
        </td>`).join('')}</tr>`).join('')}
    </table>
  </td></tr>

  <!-- High Pulse / Low Pulse: the brand descriptor's two halves (5.1), on Lavender Mist (7.4) -->
  <tr><td style="padding:12px 32px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${LAVENDER}">
      <tr>
        <td width="50%" valign="top" style="padding:24px 16px 20px 24px">
          <p style="${SUB}">High Pulse</p>
          <ul style="margin:0;padding-left:18px">
            <li style="${LI}">Eight zipline courses, up to 5.5 km over eleven lines</li>
            <li style="${LI}">Quad and buggy trails through forest, river and waterfall</li>
            <li style="${LI}">The Nepalese Bridge, 350 m long, 80 to 100 m up</li>
            <li style="${LI}">Mountain Luge Kart and the Bicycle Zipline</li>
          </ul>
        </td>
        <td width="50%" valign="top" style="padding:24px 24px 20px 16px">
          <p style="${SUB}">Low Pulse</p>
          <ul style="margin:0;padding-left:18px">
            <li style="${LI}">The 23 Coloured Earth and the Rock Garden</li>
            <li style="${LI}">Three waterfalls and the walking trail</li>
            <li style="${LI}">Le Chamouz&eacute; by the falls, La Bigarade by the river</li>
            <li style="${LI}">The Kids Park, tortoises and deer</li>
          </ul>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- the practical line, in the accent typeface (8.3) -->
  <tr><td style="padding:22px 32px 0">
    <p style="${ACCENT}">Open daily 09:00 - 17:30<br>B102, Mare Anguilles, Chamouny &nbsp;|&nbsp; +230 660 4477</p>
    <p style="${P}">For group, tour operator or corporate rates, simply reply to this email and our reservations team will take care of it.</p>
  </td></tr>

  <!-- call to action: Sunshine Radiance on Vallé Purple (7.2) -->
  <tr><td style="padding:10px 32px 30px">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="background:${PURPLE};padding:0"><a href="${SITE}" style="display:inline-block;padding:14px 26px;font-family:${HEAD};font-style:italic;font-weight:800;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:${YELLOW};text-decoration:none">Visit vallepark.com</a></td>
      <td style="padding-left:18px"><a href="${MAPS}" style="font-family:${BODY};font-size:14px;color:${PURPLE};text-decoration:underline">Find us on the map</a></td>
    </tr></table>
  </td></tr>

  <!-- footer: the Slope, the wordmark, the Adrena-lines, the URL lockup (image) -->
  <tr><td style="padding:0;line-height:0">
    <img src="cid:valle-footer" alt="VALLÉ. vallepark.com" style="display:block;width:100%;height:auto;border:0">
  </td></tr>

  <tr><td style="padding:18px 32px 0">
    <p style="${ACCENT};font-size:12px;margin:0">Vall&eacute; Advenature&trade; Park &middot; B102, Mare Anguilles, Chamouny, Mauritius<br>
    T +230 660 4477 &nbsp; E <a href="mailto:sales@vallepark.com" style="color:${PURPLE}">sales@vallepark.com</a> &nbsp; W <a href="${SITE}" style="color:${PURPLE}">vallepark.com</a></p>
    <p style="font-family:${BODY};font-size:12px;line-height:1.6;color:#7A6A8C;margin:10px 0 0">You are receiving this because you asked us for it on WhatsApp at ATM Dubai 2026.</p>
  </td></tr>

</table></td></tr></table></body></html>`;
}

function plain(firstName) {
  return `VALLÉ ADVENATURE™ PARK · MAURITIUS

MERSI! FOR STOPPING BY OUR STAND

${firstName ? `Dear ${firstName},` : 'Hello,'}

It was a pleasure to meet you at ATM Dubai 2026. As promised, the full overview of
Vallé is attached as a PDF.

Vallé began as a family tea plantation in Chamouny, in the south of Mauritius. The
discovery of 23 hues of coloured earth on the estate turned it into something else
entirely: a place where serenity and thrill coexist, and where you are not an observer
but part of the story.

HIGH PULSE
- Eight zipline courses, up to 5.5 km over eleven lines
- Quad and buggy trails through forest, river and waterfall
- The Nepalese Bridge, 350 m long, 80 to 100 m up
- Mountain Luge Kart and the Bicycle Zipline

LOW PULSE
- The 23 Coloured Earth and the Rock Garden
- Three waterfalls and the walking trail
- Le Chamouzé by the falls, La Bigarade by the river
- The Kids Park, tortoises and deer

Open daily 09:00 - 17:30 | B102, Mare Anguilles, Chamouny | +230 660 4477

For group, tour operator or corporate rates, simply reply to this email and our
reservations team will take care of it.

Visit: ${SITE}
Find us: ${MAPS}

Vallé Advenature™ Park
B102, Mare Anguilles, Chamouny, Mauritius
T +230 660 4477 · E sales@vallepark.com · W vallepark.com

You are receiving this because you asked us for it on WhatsApp at ATM Dubai 2026.`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ─────────────────────── sending ─────────────────────── */

/**
 * Send the overview to one guest. Returns true when Resend accepted it.
 * Never throws: a failed email must not break the WhatsApp conversation.
 */
export async function sendOverviewEmail({ to, name }) {
  if (!emailEnabled()) return false;

  const firstName = String(name || '').trim().split(/\s+/)[0] || '';
  const doc = DOCS[OVERVIEW];

  const payload = {
    from: config.email.from,
    to: [to],
    subject: 'Mersi! Your Vallé Advenature Park overview',
    html: html(firstName),
    text: plain(firstName),
    attachments: [],
  };
  if (config.email.replyTo) payload.reply_to = config.email.replyTo;
  // CC the sales desk in the open; BCC the people who want to see every lead.
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (config.email.cc) payload.cc = list(config.email.cc);
  if (config.email.bcc) payload.bcc = list(config.email.bcc);

  // The artwork travels inside the message: no remote-image prompt, no
  // dependence on vallepark.com being up, identical in every client.
  for (const art of ARTWORK) {
    if (!fs.existsSync(art.file)) {
      console.warn(`[email] artwork missing: ${art.file} (run: npm run email:assets)`);
      continue;
    }
    payload.attachments.push({
      filename: path.basename(art.file),
      content: fs.readFileSync(art.file).toString('base64'),
      content_id: art.cid,
    });
  }

  if (doc && fs.existsSync(doc.path)) {
    payload.attachments.push({
      filename: doc.filename,
      content: fs.readFileSync(doc.path).toString('base64'),
    });
  } else {
    console.warn('[email] overview PDF missing, sending the letter without it');
  }

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.email.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error(`[email] not sent to ${to}: ${data.message || res.status}`);
      return false;
    }
    console.log(`[email] overview sent to ${to} (id ${data.id})`);
    return true;
  } catch (err) {
    console.error('[email] failed', err.message);
    return false;
  }
}
