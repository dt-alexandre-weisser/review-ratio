import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FIXTURES_BY_MAJOR } from '../fixtures/index.ts';
// @ts-expect-error -- plain JavaScript module without type declarations
import * as freeze from '../scripts/freeze.mjs';
import { CONTRACT_MAJORS } from '../src/index.ts';

interface Pin {
  released: boolean;
  schema: { file: string; sha256: string };
  fixtures: Record<string, string>;
}
type Frozen = Record<string, Pin>;

const tool = freeze as {
  ROOT: string;
  verify: (frozen: Frozen, root: string) => string[];
  pin: (frozen: Frozen, root: string, major: string) => Frozen;
  release: (frozen: Frozen, root: string, major: string) => Frozen;
  compareReleased: (base: Frozen, head: Frozen) => string[];
  readFrozen: (path: string) => Frozen;
};

const frozen = tool.readFrozen(join(tool.ROOT, 'frozen.json'));

/** A throwaway contract root with one major. */
function sandbox(schema = 'export const v = 1;\n') {
  const root = mkdtempSync(join(tmpdir(), 'freeze-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'fixtures', 'v1'), { recursive: true });
  writeFileSync(join(root, 'src', 'v1.ts'), schema);
  writeFileSync(join(root, 'fixtures', 'v1', 'a.json'), '{"a":1}\n');
  return root;
}

describe('contract pins of this repository', () => {
  it('pin every major that exists', () => {
    for (const major of CONTRACT_MAJORS) {
      expect(frozen, `major ${major} must be pinned in frozen.json`).toHaveProperty(String(major));
    }
  });

  it('match the files on disk', () => {
    expect(tool.verify(frozen, tool.ROOT)).toEqual([]);
  });

  it('register every fixture file of every major', () => {
    for (const major of CONTRACT_MAJORS) {
      const files = readdirSync(join(tool.ROOT, 'fixtures', `v${major}`))
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.replace(/\.json$/, ''))
        .sort();
      const registered = (FIXTURES_BY_MAJOR[major] ?? []).map((f) => f.name).sort();
      expect(registered, `fixtures/index.ts must list every fixtures/v${major} file`).toEqual(
        files,
      );
    }
  });
});

describe('freeze tool', () => {
  it('re-pins an unreleased major', () => {
    const root = sandbox();
    let pins = tool.pin({}, root, '1');
    writeFileSync(join(root, 'src', 'v1.ts'), 'export const v = 2;\n');
    expect(tool.verify(pins, root)).toHaveLength(1);
    pins = tool.pin(pins, root, '1');
    expect(tool.verify(pins, root)).toEqual([]);
  });

  it('never re-pins a released schema or fixture', () => {
    const root = sandbox();
    const pins = tool.release(tool.pin({}, root, '1'), root, '1');
    writeFileSync(join(root, 'src', 'v1.ts'), 'export const v = 2;\n');
    expect(tool.verify(pins, root).join()).toContain('A released schema never changes');
    expect(() => tool.pin(pins, root, '1')).toThrow(/released and changed/);

    const root2 = sandbox();
    const pins2 = tool.release(tool.pin({}, root2, '1'), root2, '1');
    writeFileSync(join(root2, 'fixtures', 'v1', 'a.json'), '{"a":2}\n');
    expect(() => tool.pin(pins2, root2, '1')).toThrow(/fixture a.json/);
  });

  it('adds new fixtures to a released major and keeps the old pins', () => {
    const root = sandbox();
    const pins = tool.release(tool.pin({}, root, '1'), root, '1');
    writeFileSync(join(root, 'fixtures', 'v1', 'b.json'), '{"b":1}\n');
    expect(tool.verify(pins, root).join()).toContain('b.json is not pinned');
    const next = tool.pin(pins, root, '1');
    expect(Object.keys(next['1']!.fixtures)).toEqual(['a.json', 'b.json']);
    expect(next['1']!.released).toBe(true);
    expect(tool.verify(next, root)).toEqual([]);
  });

  it('detects a deleted fixture', () => {
    const root = sandbox();
    const pins = tool.pin({}, root, '1');
    const content = readFileSync(join(root, 'fixtures', 'v1', 'a.json'), 'utf8');
    expect(content).toBeTruthy();
    writeFileSync(join(root, 'fixtures', 'v1', 'a.json'), '{"a":3}\n');
    expect(tool.verify(pins, root).join()).toContain('a.json changed');
  });

  it('refuses to release a major whose files drifted', () => {
    const root = sandbox();
    const pins = tool.pin({}, root, '1');
    writeFileSync(join(root, 'src', 'v1.ts'), 'drift\n');
    expect(() => tool.release(pins, root, '1')).toThrow(/changed/);
  });

  it('fails when a branch changes or unreleases a major released on the base', () => {
    const base: Frozen = {
      '1': {
        released: true,
        schema: { file: 'src/v1.ts', sha256: 'aaa' },
        fixtures: { 'a.json': 'x' },
      },
    };
    expect(tool.compareReleased(base, base)).toEqual([]);
    expect(
      tool.compareReleased(base, {
        '1': { ...base['1']!, schema: { file: 'src/v1.ts', sha256: 'bbb' } },
      }),
    ).toHaveLength(1);
    expect(tool.compareReleased(base, { '1': { ...base['1']!, released: false } })).toHaveLength(1);
    expect(tool.compareReleased(base, { '1': { ...base['1']!, fixtures: {} } })).toHaveLength(1);
    expect(tool.compareReleased(base, {})).toHaveLength(1);
    // An unreleased major on the base may change freely.
    expect(tool.compareReleased({ '1': { ...base['1']!, released: false } }, {})).toEqual([]);
  });
});
