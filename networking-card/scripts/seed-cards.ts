#!/usr/bin/env npx tsx
/**
 * Seed script for networking cards.
 *
 * Usage:
 *   npx tsx scripts/seed-cards.ts [count] [base-url]
 *
 * Generates:
 *   seed.sql  — INSERT statements for the cards table
 *   cards.csv — token,url,label for QR/NFC production
 *
 * Apply with:
 *   wrangler d1 execute dazbeez-networking --local  --file=seed.sql
 *   wrangler d1 execute dazbeez-networking --remote --file=seed.sql
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TOKEN_LEN = 8;

function randomToken(): string {
  const bytes = crypto.randomBytes(TOKEN_LEN);
  let token = '';
  for (let i = 0; i < TOKEN_LEN; i++) {
    token += CHARSET[bytes[i] % CHARSET.length];
  }
  return token;
}

function main() {
  const count = parseInt(process.argv[2] || '20', 10);
  const baseUrl = process.argv[3] || 'https://dazbeez.com';

  if (count < 1 || count > 1000) {
    console.error('Count must be between 1 and 1000');
    process.exit(1);
  }

  const tokens = new Set<string>();
  while (tokens.size < count) {
    tokens.add(randomToken());
  }

  const outDir = path.resolve(__dirname, '..');

  // Generate SQL
  const sqlLines: string[] = [];
  for (const token of tokens) {
    const label = `card-${token}`;
    sqlLines.push(
      `INSERT OR IGNORE INTO cards (token, label) VALUES ('${token}', '${label}');`,
    );
  }
  const sqlPath = path.join(outDir, 'seed.sql');
  fs.writeFileSync(sqlPath, sqlLines.join('\n') + '\n');

  // Generate CSV
  const csvLines = ['token,url,label'];
  let idx = 1;
  for (const token of tokens) {
    csvLines.push(`${token},${baseUrl}/hi/${token},card-${idx}`);
    idx++;
  }
  const csvPath = path.join(outDir, 'cards.csv');
  fs.writeFileSync(csvPath, csvLines.join('\n') + '\n');

  console.error(`Generated ${count} cards`);
  console.error(`  SQL:  ${sqlPath}`);
  console.error(`  CSV:  ${csvPath}`);
  console.error('\nApply locally with:');
  console.error(`  npx wrangler d1 execute dazbeez-networking --local --file=seed.sql`);
}

main();
