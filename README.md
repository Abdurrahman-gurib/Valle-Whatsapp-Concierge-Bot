# Vallé · Advenature Park™ — WhatsApp Concierge

A WhatsApp concierge for Vallé Advenature Park (Chamouny, Mauritius). Guests who scan a
Vallé QR code get instant answers about activities, prices, packages and bookings, in their
own language, by text or voice note. Everyone else is left to the team: the bot never
interrupts an existing conversation.

Runs on **+230 5292 8841** through 360dialog **coexistence**, so the team keeps using the
WhatsApp Business app on the same number.

---

## Getting started

```bash
npm install
docker compose up -d          # local Postgres
npm run migrate               # create the schema
npm start                     # start the bot on :3000
```

Copy the environment template into `.env` and fill it in (see **Configuration**).

| Command | What it does |
|---|---|
| `npm start` | Run the bot |
| `npm run dev` | Run with auto-reload |
| `npm test` | Full end-to-end suite (134 checks, no network needed) |
| `npm run migrate` | Apply the database schema |
| `npm run seed:agents` | Add staff to the back office |
| `npm run qr` | Regenerate every QR code into `assets/qr/` |
| `npm run up` | Laptop hosting: run the bot AND the tunnel under a supervisor that restarts either when it dies (logs in `logs/supervisor.log`). A launcher in the Windows Startup folder (`Valle WhatsApp Bot.vbs`) runs this at every logon, because Kaspersky reboots this laptop several times a day |
| `npm run email:assets` | Re-render the email header and footer artwork (Slope, tilted headline, lockups) after changing the photo or the wording |
| `npm run poster` | Re-render the ATM Dubai stand poster (PNG + PDF) in the brand identity with the current QR message |
| `npm run tunnel` | Laptop hosting: expose the local bot publicly and register the webhook. Tries Cloudflare first when `bin/cloudflared.exe` exists (download `cloudflared-windows-amd64.exe` from github.com/cloudflare/cloudflared/releases and rename it); then serveo, pinggy, localtunnel. Probes the public URL every 30 s and rotates when it dies |
| `npm run assets` | Prepare new PDFs and photos for WhatsApp (`-- --check` to preview) |

---

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `D360_API_KEY` | 360dialog key. When set, the bot sends and receives through 360dialog. |
| `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID` | Meta Cloud API credentials (used when no 360dialog key). |
| `VERIFY_TOKEN` | Shared secret. Also sent as `X-Valle-Token` on 360dialog webhooks. |
| `APP_SECRET` | Meta app secret, used to verify Meta's webhook signature. |
| `ANTHROPIC_API_KEY` | Claude, the concierge's brain. |
| `OPENAI_API_KEY` | Voice: Whisper transcription in, TTS voice replies out. |
| `DATABASE_URL`, `DB_SSL` | Postgres connection. |
| `BOT_MODE` | `hybrid` (menus + AI, recommended), `menu` (no AI) or `ai`. |
| `QR_ONLY` | `true` = only guests who scanned a QR get replies. |
| `ADMIN_NUMBERS` | Staff numbers allowed to use the WhatsApp back office. |
| `DASHBOARD_KEY` | Secret in the dashboard URL. Empty disables the dashboard. |
| `HANDOVER_TIMEOUT_MIN` | Minutes before an unanswered chat returns to the bot. |
| `OPEN_HOUR`, `CLOSE_HOUR`, `TIMEZONE` | Opening hours used in replies. |

---

## Project layout

```
src/
  server.js            Express app: webhook in, per-sender queues, health check
  core/                config.js (env + business hours) · db.js (Postgres)
  whatsapp/            client.js (send/receive, media) · voice.js (transcribe, speak)
  bot/                 router.js (the decision flow) · menu-bot.js (menus & cards)
                       ai.js (Claude concierge) · admin.js (in-WhatsApp back office)
                       images.js · documents.js (what the bot can attach)
  web/dashboard.js     read-only live dashboard
knowledge/valle-kb.md  everything the assistant knows and quotes
assets/
  price-list/          official rate cards: THE source of truth for prices
  documents/           presentation, magazine, factsheet, restaurant menus
  photos/              park photography, WhatsApp-ready JPEG
  qr/  marketing/      generated QR codes and printed pieces
source-material/       untouched originals (heavy exports, AVIF/WebP photos)
scripts/               migrate · seed:agents · qr · assets · tunnel · webhook:set
tests/e2e-test.mjs     the whole flow, against an in-memory Postgres
db/schema.sql
```

Prices come from `assets/price-list` only. Drop a new rate card into
`source-material/originals/price-list-original/`, run `npm run assets`, and it is
prepared (oversized exports are rasterised so WhatsApp accepts them). Update
`knowledge/valle-kb.md` in the same breath so quoted figures match the PDF.

## Rules the bot never breaks

These are enforced in code and covered by the test suite:

1. **Only QR scanners are served.** A guest is unlocked the moment one of their
   messages matches a Vallé QR prefill; the source is stored permanently. For everyone
   else the bot does *nothing at all* — no reply, no typing indicator, and no read
   receipt — whatever state the chat is in. Their messages are still stored so the team
   sees them in the back office and dashboard.
2. **A colleague always wins.** The moment a person answers a guest, the bot steps out of
   that conversation: it stops reading, stops typing and stops replying. This works both
   ways a colleague can reply:
   - from the **WhatsApp Business app** — WhatsApp echoes that message to the webhook and
     the bot pauses itself automatically (`handleStaffEcho`);
   - from the **back office** with `#claim`.
   The chat stays with the human until someone runs `#release` (`HUMAN_TAKEOVER_MINUTES=0`).
   The bot's own messages echo back too and are recognised, so it never pauses itself.
3. **No double messages.** Incoming webhooks are deduplicated by WhatsApp message id;
   messages from one guest are processed strictly one at a time; and because writing an
   AI answer or transcribing a voice note takes seconds, the bot re-checks ownership
   immediately before sending and drops its answer if a colleague replied meanwhile.
   The "you're in the queue" notice is sent once, never repeated.

## How a conversation flows

1. A guest scans a QR code and sends the prefilled message.
2. The bot recognises the QR wording, tags the guest with its source, and greets them with
   the menu. Anyone who never scanned a QR is stored but receives no reply (`QR_ONLY`).
3. Menu taps and keywords answer instantly from `knowledge/valle-kb.md`: prices, activities,
   packages, dining, kids, hours, the park map, photos and PDFs.
4. Anything else goes to Claude, which replies in the guest's own language, sees photos they
   send, and captures booking details as leads.
5. Voice notes are transcribed, answered in the same language, and answered *with* a voice
   note as well as text.
6. When a person is needed, the chat is queued and every active agent is alerted on their own
   WhatsApp. `#claim` takes it; the bot stays silent until released, and an unanswered chat
   returns to the bot automatically.

---

## Back office (from any admin's WhatsApp)

`#help` · `#stats` · `#waiting` · `#claim <number>` · `#release` · `#note <text>` ·
`#info <number>` · `#ask <question>` · `#boton` / `#botoff`

A read-only web view is available at `/dashboard?key=<DASHBOARD_KEY>`: live counters, the
waiting queue, captured leads, recent conversations and the latest messages.

---

## Deployment

The bot needs a public HTTPS URL for the webhook. In production, deploy the Docker image and
point 360dialog at `https://<host>/webhook`:

```bash
npm run webhook:set https://your-host
```

**During development on this office network**, tunnels are unreliable: DNS resolves
`trycloudflare.com` to the router and SSH on port 22 is intermittently blocked. `npm run
tunnel` works around it by cycling through localtunnel → pinggy (port 443) → serveo until one
connects, then registering the webhook automatically and re-registering whenever the URL
changes. It is a development bridge, not a production setup.
