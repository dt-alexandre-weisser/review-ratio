#!/usr/bin/env node
/**
 * Pins the hash of every released contract schema.
 *
 *   node scripts/freeze.mjs          # verify: exit 1 when a released schema changed
 *   node scripts/freeze.mjs --write  # pin the current hashes (only when adding a new major)
 *
 * `pnpm test` runs the same check, so CI fails when a released major is edited.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frozenPath = resolve(root, 'frozen.json');
const write = process.argv.includes('--write');

/** @param {string} content */
export function hashSchema(content) {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
}

const frozen = JSON.parse(readFileSync(frozenPath, 'utf8'));
let drift = false;
for (const [major, entry] of Object.entries(frozen)) {
  const actual = hashSchema(readFileSync(resolve(root, entry.file), 'utf8'));
  if (actual !== entry.sha256) {
    drift = true;
    if (write) {
      entry.sha256 = actual;
      console.info(`pinned major ${major}: ${entry.file} ${actual}`);
    } else {
      console.error(
        `contract major ${major} is frozen but ${entry.file} changed (expected ${entry.sha256}, got ${actual}). ` +
          'A breaking change needs a new major. Only pin a new hash when releasing a new major.',
      );
    }
  }
}
if (write) {
  writeFileSync(frozenPath, `${JSON.stringify(frozen, null, 2)}\n`);
} else if (drift) {
  process.exit(1);
} else {
  console.info('frozen schemas unchanged');
}
