#!/usr/bin/env node
/** Applies db/schema.sql. Safe to run repeatedly. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/core/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

try {
  await pool.query(sql);
  console.log('✅ Schema applied.');
} catch (err) {
  console.error('❌ Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
