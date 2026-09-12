#!/usr/bin/env node
/**
 * TWILIO SETUP — the welcome SMS, from the command line.
 *
 * Reads TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN from .env (or the environment)
 * and talks to Twilio's REST API directly, so the whole sender setup can be
 * done and checked without clicking through the console.
 *
 *   node scripts/twilio-setup.js status
 *       account type (trial or upgraded), balance, numbers owned, Messaging
 *       Services and their senders, and what the bot would use right now.
 *
 *   node scripts/twilio-setup.js numbers GB [--type mobile|local|tollfree]
 *       SMS-capable numbers for sale in a country (ISO code), with prices.
 *
 *   node scripts/twilio-setup.js buy +447700900123 --yes
 *       buy one of them (charged monthly to the Twilio balance).
 *
 *   node scripts/twilio-setup.js service --name "Valle" [--alpha VALLE] [--number +447700900123]
 *       create the Messaging Service (reused if one with that name exists),
 *       add an alphanumeric sender and/or a number to its sender pool, and
 *       print the SID to put in TWILIO_MESSAGING_SERVICE_SID.
 *
 *   node scripts/twilio-setup.js test +23052928841 ["custom text"]
 *       send the welcome SMS to one phone through the configured sender and
 *       follow its delivery status for half a minute.
 */
import 'dotenv/config';
import { WELCOME_SMS, segments, senderFor } from '../src/notify/sms.js';

const SID = process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const SERVICE = process.env.TWILIO_MESSAGING_SERVICE_SID || '';
const FROM = process.env.TWILIO_FROM || '';
const PUBLIC = process.env.PUBLIC_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');

const REST = `https://api.twilio.com/2010-04-01/Accounts/${SID}`;
const MSG = 'https://messaging.twilio.com/v1';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const has = (name) => rest.includes(`--${name}`);
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

if (!SID || !TOKEN) {
  console.error('Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env first (Twilio Console → Account Info).');
  process.exit(1);
}

async function call(method, url, form) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const kyc = /compliance profile|KYC/i.test(data.message || '')
      ? '\n  → Complete the KYC form first: Twilio Console → Trust Hub → Customer profiles'
        + ' (https://console.twilio.com/us1/account/trust-hub/customer-profiles).'
        + ' Nothing can be sent or bought until it is approved.'
      : '';
    throw new Error(`${method} ${url.replace(SID, 'AC…')} → ${res.status} ${data.message || ''}${data.code ? ` (code ${data.code})` : ''}${kyc}`);
  }
  return data;
}
const get = (url) => call('GET', url);
const post = (url, form) => call('POST', url, form);
const money = (v, cur = 'USD') => `${cur} ${Number(v).toFixed(2)}`;

async function status() {
  const acct = await get(`${REST}.json`);
  const bal = await get(`${REST}/Balance.json`).catch(() => null);
  console.log(`Account   ${acct.friendly_name} — ${acct.type === 'Trial' ? 'TRIAL (texts only verified numbers, with a trial prefix)' : 'upgraded (' + acct.type + ')'}, status ${acct.status}`);
  if (bal) console.log(`Balance   ${money(bal.balance, bal.currency)}`);

  const nums = await get(`${REST}/IncomingPhoneNumbers.json?PageSize=50`);
  console.log(`\nNumbers owned: ${nums.incoming_phone_numbers.length}`);
  for (const n of nums.incoming_phone_numbers) {
    console.log(`  ${n.phone_number}  ${n.friendly_name}  sms=${n.capabilities?.sms ? 'yes' : 'NO'}  sid ${n.sid}`);
  }

  const svcs = await get(`${MSG}/Services?PageSize=50`);
  console.log(`\nMessaging Services: ${svcs.services.length}`);
  for (const s of svcs.services) {
    const [alpha, phones] = await Promise.all([
      get(`${MSG}/Services/${s.sid}/AlphaSenders`), get(`${MSG}/Services/${s.sid}/PhoneNumbers`),
    ]);
    console.log(`  ${s.sid}  "${s.friendly_name}"`);
    for (const a of alpha.alpha_senders) console.log(`      alpha sender  ${a.alpha_sender}`);
    for (const p of phones.phone_numbers) console.log(`      number        ${p.phone_number}`);
    if (!alpha.alpha_senders.length && !phones.phone_numbers.length) console.log('      (no senders yet)');
  }

  console.log('\nWhat a guest would see as the sender (senderFor, exactly the bot\'s routing):');
  for (const [label, n] of [['Mauritius', '+23052928841'], ['UK', '+447700900123'], ['France', '+33612345678'],
    ['India', '+919876543210'], ['Spain', '+34612345678'], ['UAE', '+971501234567'], ['USA', '+12125551234']]) {
    const s = senderFor(n);
    console.log(`  ${label.padEnd(10)} ${s.skip ? 'skipped: ' + s.skip : s.none ? 'NO SENDER: ' + s.none
      : s.messagingServiceSid ? 'Messaging Service ' + s.messagingServiceSid : s.from}`);
  }
  console.log('Delivery reports go to:', PUBLIC ? `${PUBLIC}/twilio/status` : 'nowhere (no PUBLIC_URL / RAILWAY_PUBLIC_DOMAIN here; Railway has one)');
  console.log(`Welcome text: ${WELCOME_SMS.length} characters, ${segments(WELCOME_SMS)} segment(s)`);
}

async function numbers() {
  const iso = (positional[0] || 'GB').toUpperCase();
  const type = { mobile: 'Mobile', local: 'Local', tollfree: 'TollFree' }[(flag('type') || (iso === 'GB' ? 'mobile' : 'local')).toLowerCase()];
  const data = await get(`${REST}/AvailablePhoneNumbers/${iso}/${type}.json?SmsEnabled=true&PageSize=10`);
  const prices = await get(`https://pricing.twilio.com/v1/PhoneNumbers/Countries/${iso}`).catch(() => null);
  console.log(`SMS-capable ${type} numbers for sale in ${iso}:`);
  for (const n of data.available_phone_numbers) console.log(`  ${n.phone_number}  ${n.friendly_name}  ${n.locality || ''}`);
  if (!data.available_phone_numbers.length) console.log('  none right now (try another --type, or the console may need an address/regulatory bundle for this country)');
  if (prices) for (const p of prices.phone_number_prices) console.log(`  monthly price, ${p.number_type}: ${money(p.current_price, prices.price_unit)}`);
}

async function buy() {
  const number = positional[0];
  if (!number?.startsWith('+')) throw new Error('give the number in E.164, e.g. buy +447700900123 --yes');
  if (!has('yes')) throw new Error('this charges the account monthly; add --yes to confirm');
  const n = await post(`${REST}/IncomingPhoneNumbers.json`, { PhoneNumber: number, FriendlyName: 'Vallé welcome SMS' });
  console.log(`Bought ${n.phone_number} (sid ${n.sid}). Put it in TWILIO_FROM, or add it to the Messaging Service:`);
  console.log(`  node scripts/twilio-setup.js service --name "Valle" --number ${n.phone_number}`);
}

async function service() {
  const name = flag('name') || 'Valle';
  const svcs = await get(`${MSG}/Services?PageSize=50`);
  let svc = svcs.services.find((s) => s.friendly_name === name);
  if (svc) console.log(`Reusing Messaging Service ${svc.sid} "${name}"`);
  else {
    svc = await post(`${MSG}/Services`, {
      FriendlyName: name,
      ...(PUBLIC ? { StatusCallback: `${PUBLIC}/twilio/status` } : {}),
    });
    console.log(`Created Messaging Service ${svc.sid} "${name}"`);
  }
  const alpha = flag('alpha');
  if (alpha) {
    try {
      const a = await post(`${MSG}/Services/${svc.sid}/AlphaSenders`, { AlphaSender: alpha });
      console.log(`  added alphanumeric sender "${a.alpha_sender}" (used automatically where the destination country allows it)`);
    } catch (err) { console.log(`  alphanumeric sender: ${err.message}`); }
  }
  const number = flag('number');
  if (number) {
    const nums = await get(`${REST}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`);
    const owned = nums.incoming_phone_numbers[0];
    if (!owned) throw new Error(`${number} is not a number on this account; buy it first`);
    try {
      const p = await post(`${MSG}/Services/${svc.sid}/PhoneNumbers`, { PhoneNumberSid: owned.sid });
      console.log(`  added number ${p.phone_number} to the sender pool`);
    } catch (err) { console.log(`  number: ${err.message}`); }
  }
  console.log(`\nSet on Railway and in .env:\n  TWILIO_MESSAGING_SERVICE_SID=${svc.sid}`);
}

async function test() {
  const to = positional[0];
  if (!to?.startsWith('+')) throw new Error('give the phone in E.164, e.g. test +23052928841');
  const body = positional[1] || WELCOME_SMS;
  // Exactly the bot's routing: the sender this guest would see, or the skip.
  const sender = senderFor(to);
  if (sender.skip) throw new Error(`the bot would skip ${to}: ${sender.skip} (SMS_SKIP_COUNTRIES=none forces it)`);
  if (sender.none) throw new Error(sender.none);
  console.log(`Sending to ${to} as ${sender.messagingServiceSid || sender.from}`);
  const form = { To: to, Body: body,
    ...(sender.messagingServiceSid ? { MessagingServiceSid: sender.messagingServiceSid } : { From: sender.from }) };
  if (PUBLIC) form.StatusCallback = `${PUBLIC}/twilio/status`;
  const m = await post(`${REST}/Messages.json`, form);
  console.log(`Accepted: sid ${m.sid}, status ${m.status}, ${segments(body)} segment(s), price ${m.price ?? 'pending'}`);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await get(`${REST}/Messages/${m.sid}.json`);
    console.log(`  ${new Date().toISOString().slice(11, 19)}  ${s.status}${s.error_code ? `  error ${s.error_code}: ${s.error_message}` : ''}${s.price ? `  ${money(s.price, s.price_unit)}` : ''}`);
    if (['delivered', 'undelivered', 'failed'].includes(s.status)) break;
  }
}

const commands = { status, numbers, buy, service, test };
if (!commands[cmd]) {
  console.error('Usage: node scripts/twilio-setup.js status | numbers <ISO> | buy <+number> --yes | service --name "Valle" [--alpha VALLE] [--number +…] | test <+number> [text]');
  process.exit(1);
}
commands[cmd]().catch((err) => { console.error(err.message); process.exitCode = 1; });
