#!/usr/bin/env node
/**
 * Guards the released contract majors.
 *
 * Each major pins the hash of its schema file and of each of its fixture files in
 * `frozen.json`. Once a major is released its pins never change: a breaking change is a new
 * major. Pins are append-only for released majors (new fixtures may be added).
 *
 *   node scripts/freeze.mjs                       verify the pins (CI, `pnpm test`)
 *   node scripts/freeze.mjs --pin 2               pin major 2; re-pins it only while unreleased
 *   node scripts/freeze.mjs --release 2           mark major 2 released, forever
 *   node scripts/freeze.mjs --against base.json   fail if a major released in base.json
 *                                                 changed here (CI, against the base branch)
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {{ released: boolean, schema: { file: string, sha256: string }, fixtures: Record<string, string> }} Pin
 * @typedef {Record<string, Pin>} Frozen
 */

/** @param {string} content */
export function sha256(content) {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
}

/** @param {string} root @param {string} major */
export function currentPin(root, major) {
  const file = `src/v${major}.ts`;
  const fixturesDir = join(root, 'fixtures', `v${major}`);
  /** @type {Record<string, string>} */
  const fixtures = {};
  if (existsSync(fixturesDir)) {
    for (const name of readdirSync(fixturesDir)
      .filter((n) => n.endsWith('.json'))
      .sort()) {
      fixtures[name] = sha256(readFileSync(join(fixturesDir, name), 'utf8'));
    }
  }
  return { file, sha256: sha256(readFileSync(join(root, file), 'utf8')), fixtures };
}

/**
 * Problems of the pins against the files on disk. Empty when everything matches.
 * @param {Frozen} frozen @param {string} root
 */
export function verify(frozen, root) {
  /** @type {string[]} */
  const problems = [];
  for (const [major, pin] of Object.entries(frozen)) {
    const now = currentPin(root, major);
    const state = pin.released ? 'released' : 'unreleased';
    if (now.sha256 !== pin.schema.sha256) {
      problems.push(
        `major ${major} (${state}): ${pin.schema.file} changed. ` +
          (pin.released
            ? 'A released schema never changes: add a new major.'
            : `Re-pin it with \`node scripts/freeze.mjs --pin ${major}\`.`),
      );
    }
    for (const [name, hash] of Object.entries(pin.fixtures)) {
      if (now.fixtures[name] === undefined) {
        problems.push(`major ${major} (${state}): pinned fixture ${name} is missing.`);
      } else if (now.fixtures[name] !== hash) {
        problems.push(`major ${major} (${state}): fixture ${name} changed.`);
      }
    }
    for (const name of Object.keys(now.fixtures)) {
      if (pin.fixtures[name] === undefined) {
        problems.push(
          `major ${major}: fixture ${name} is not pinned. Pin it with \`node scripts/freeze.mjs --pin ${major}\`.`,
        );
      }
    }
  }
  return problems;
}

/**
 * Problems when a major released in `base` was changed or unreleased in `head`.
 * @param {Frozen} base @param {Frozen} head
 */
export function compareReleased(base, head) {
  /** @type {string[]} */
  const problems = [];
  for (const [major, pin] of Object.entries(base)) {
    if (!pin.released) continue;
    const now = head[major];
    if (!now?.released) {
      problems.push(`major ${major} was released on the base branch and is not any more.`);
      continue;
    }
    if (now.schema.sha256 !== pin.schema.sha256) {
      problems.push(`major ${major} is released: its schema pin must not change.`);
    }
    for (const [name, hash] of Object.entries(pin.fixtures)) {
      if (now.fixtures[name] !== hash) {
        problems.push(`major ${major} is released: the pin of fixture ${name} must not change.`);
      }
    }
  }
  return problems;
}

/**
 * Pins a major. A released major only gains pins for new fixtures.
 * @param {Frozen} frozen @param {string} root @param {string} major
 * @returns {Frozen}
 */
export function pin(frozen, root, major) {
  if (!/^[1-9]\d*$/.test(major)) throw new Error(`not a major: ${major}`);
  const now = currentPin(root, major);
  const existing = frozen[major];
  if (!existing?.released) {
    return {
      ...frozen,
      [major]: {
        released: false,
        schema: { file: now.file, sha256: now.sha256 },
        fixtures: now.fixtures,
      },
    };
  }
  const problems = [];
  if (now.sha256 !== existing.schema.sha256) problems.push(`${existing.schema.file} changed`);
  for (const [name, hash] of Object.entries(existing.fixtures)) {
    if (now.fixtures[name] !== hash) problems.push(`fixture ${name} changed or is missing`);
  }
  if (problems.length > 0) {
    throw new Error(`major ${major} is released and changed:\n${problems.join('\n')}`);
  }
  // Released: keep every existing pin, only add the fixtures that are new.
  return {
    ...frozen,
    [major]: { ...existing, fixtures: { ...now.fixtures, ...existing.fixtures } },
  };
}

/** @param {Frozen} frozen @param {string} root @param {string} major @returns {Frozen} */
export function release(frozen, root, major) {
  const existing = frozen[major];
  if (!existing) throw new Error(`major ${major} is not pinned`);
  const problems = verify({ [major]: existing }, root);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return { ...frozen, [major]: { ...existing, released: true } };
}

/** @param {string} path @returns {Frozen} */
export function readFrozen(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const frozenPath = join(ROOT, 'frozen.json');
  const args = process.argv.slice(2);
  const flag = args[0];
  const value = args[1];
  const frozen = readFrozen(frozenPath);
  /** @param {Frozen} next */
  const write = (next) => writeFileSync(frozenPath, `${JSON.stringify(next, null, 2)}\n`);

  if (flag === undefined) {
    const problems = verify(frozen, ROOT);
    if (problems.length > 0) {
      for (const p of problems) console.error(p);
      process.exit(1);
    }
    console.info(`contract pins verified: majors ${Object.keys(frozen).join(', ')}`);
  } else if (flag === '--pin' && value) {
    write(pin(frozen, ROOT, value));
    console.info(`pinned major ${value}`);
  } else if (flag === '--release' && value) {
    write(release(frozen, ROOT, value));
    console.info(`released major ${value}: its pins can never change`);
  } else if (flag === '--against' && value) {
    const problems = existsSync(value) ? compareReleased(readFrozen(value), frozen) : [];
    if (problems.length > 0) {
      for (const p of problems) console.error(p);
      process.exit(1);
    }
    console.info('released majors unchanged against the base');
  } else {
    console.error('usage: freeze.mjs [--pin N | --release N | --against base-frozen.json]');
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
