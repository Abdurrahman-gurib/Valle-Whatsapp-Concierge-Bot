#!/usr/bin/env node
/**
 * Add staff to the WhatsApp back office.
 *
 *   node scripts/seed-agents.js "23057123456:Priya:manager" "23059876543:Kevin"
 *
 * Format: number:name[:role]   role = agent (default) | manager
 * Numbers: digits only, with country code. 8-digit local numbers get 230 prefixed.
 */
import { upsertAgent, pool } from '../src/core/db.js';

const args = process.argv.slice(2);

if (!args.length) {
  console.log(`Usage:
  node scripts/seed-agents.js "23057123456:Priya:manager" "23059876543:Kevin"`);
  process.exit(0);
}

for (const spec of args) {
  const [rawNum, name, role = 'agent'] = spec.split(':');
  if (!rawNum || !name) {
    console.error(`⚠️  Skipping malformed entry: "${spec}"`);
    continue;
  }
  const digits = rawNum.replace(/\D/g, '');
  const waId = digits.length === 8 ? `230${digits}` : digits;

  const agent = await upsertAgent(waId, name, role);
  console.log(`✅ ${agent.name} (${agent.role}) → ${agent.wa_id}`);
}

console.log(`\nEach agent must now send one message to the business number,`);
console.log(`then reply *#help* to see the back office menu.`);

await pool.end();
