#!/usr/bin/env node
/**
 * Register (or update) the bot's webhook URL at 360dialog.
 *
 *   node set-webhook-d360.js https://your-public-host
 *
 * 360dialog will then POST every incoming WhatsApp event to <url>/webhook,
 * attaching the X-Valle-Token header so server.js can authenticate it.
 * Requires D360_API_KEY and VERIFY_TOKEN in .env.
 */
import 'dotenv/config';

const base = process.argv[2];
if (!base) {
  console.error('Usage: node set-webhook-d360.js https://your-public-host');
  process.exit(1);
}
if (!process.env.D360_API_KEY) {
  console.error('D360_API_KEY is not set in .env');
  process.exit(1);
}

const url = `${base.replace(/\/+$/, '')}/webhook`;

const res = await fetch('https://waba-v2.360dialog.io/v1/configs/webhook', {
  method: 'POST',
  headers: {
    'D360-API-KEY': process.env.D360_API_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    url,
    headers: { 'X-Valle-Token': process.env.VERIFY_TOKEN },
  }),
});

const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`❌ Failed (${res.status}):`, JSON.stringify(data));
  process.exit(1);
}
console.log(`✅ 360dialog webhook set to ${url}`);
console.log(JSON.stringify(data, null, 2));
