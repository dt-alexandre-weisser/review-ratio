import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import frozen from '../frozen.json' with { type: 'json' };
import { CONTRACT_MAJORS } from '../src/index.ts';

const root = resolve(import.meta.dirname, '..');

describe('frozen schemas', () => {
  it('pins every released major', () => {
    for (const major of CONTRACT_MAJORS) {
      expect(frozen, `major ${major} must be pinned in frozen.json`).toHaveProperty(String(major));
    }
  });

  it.each(Object.entries(frozen))('major %s schema file is unchanged', (major, entry) => {
    const content = readFileSync(resolve(root, entry.file), 'utf8').replace(/\r\n/g, '\n');
    const actual = createHash('sha256').update(content).digest('hex');
    expect(
      actual,
      `contract major ${major} is frozen. ${entry.file} changed: a breaking change needs a new major.`,
    ).toBe(entry.sha256);
  });
});
