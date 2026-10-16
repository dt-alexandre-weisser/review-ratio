// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CLASS_GLOBS } from '../../src/lib/scoring/classes.ts';
import {
  ACTION_WEIGHTS,
  CLASS_WEIGHTS,
  PARAMETERS,
  RATIO_DECIMALS,
  WINDOW_HOURS,
} from '../../src/lib/scoring/formula.ts';
import { MAX_DOWN_RECORDS, MAX_UP_RECORDS } from '../../src/lib/scoring/records.ts';
import { LINES_GRANULARITY } from '../../src/lib/scoring/rounding.ts';
import {
  ACTION_LABELS,
  DEFAULT_CLASS,
  VALUES,
  formatNumber,
  renderScoring,
  sizeTierRows,
} from '../../src/scoring/render.ts';

const HTML = readFileSync(join(import.meta.dirname, '../../src/scoring/scoring.html'), 'utf8');

function page(): Document {
  return new DOMParser().parseFromString(HTML, 'text/html');
}

function rows(doc: Document, id: string): string[][] {
  return [...doc.querySelectorAll(`#${id} tr`)].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent),
  );
}

describe('scoring page', () => {
  it('holds no number of its own: every figure comes from the constants', () => {
    expect(page().body.textContent).not.toMatch(/\d/);
  });

  it('fills every slot, and every value has a slot', () => {
    const doc = page();
    renderScoring(doc);
    const slots = [...doc.querySelectorAll<HTMLElement>('[data-value]')];
    for (const node of slots) {
      expect(node.textContent).toBe(VALUES[node.dataset['value'] ?? '']);
      expect(node.textContent).not.toBe('');
    }
    expect(new Set(slots.map((node) => node.dataset['value']))).toEqual(
      new Set(Object.keys(VALUES)),
    );
  });

  it('shows the parameters the formula runs on', () => {
    expect(VALUES).toEqual({
      windowDays: formatNumber(WINDOW_HOURS / 24),
      windowHours: formatNumber(WINDOW_HOURS),
      decayFullHours: formatNumber(PARAMETERS.decayFullHours),
      decayFloor: formatNumber(PARAMETERS.decayFloor),
      futureToleranceHours: formatNumber(PARAMETERS.futureToleranceHours),
      commentMultiplier: formatNumber(PARAMETERS.commentMultiplier),
      commentRangeCap: formatNumber(PARAMETERS.commentRangeCap),
      viewedBonus: formatNumber(PARAMETERS.viewedBonus),
      rescueMultiplier: formatNumber(PARAMETERS.rescueMultiplier),
      rescueAfterHours: formatNumber(PARAMETERS.rescueAfterHours),
      firstTierLines: formatNumber(PARAMETERS.sizeTiers[0].upTo),
      linesGranularity: formatNumber(LINES_GRANULARITY),
      ratioDecimals: formatNumber(RATIO_DECIMALS),
      maxUpRecords: formatNumber(MAX_UP_RECORDS),
      maxDownRecords: formatNumber(MAX_DOWN_RECORDS),
      defaultClass: 'production',
    });
    expect(VALUES).toMatchObject({
      windowDays: '7',
      decayFullHours: '24',
      decayFloor: '0.3',
      commentMultiplier: '10',
      commentRangeCap: '20',
      viewedBonus: '0.2',
      rescueMultiplier: '1.5',
      rescueAfterHours: '48',
    });
  });

  it('lists the class weights and the action weights in the order of the formula', () => {
    const doc = page();
    renderScoring(doc);
    expect(rows(doc, 'class-weights')).toEqual(
      Object.entries(CLASS_WEIGHTS).map(([cls, w]) => [cls, String(w)]),
    );
    expect(rows(doc, 'action-weights')).toEqual(
      Object.entries(ACTION_WEIGHTS).map(([action, w]) => [
        ACTION_LABELS[action as keyof typeof ACTION_LABELS],
        String(w),
      ]),
    );
  });

  it('lists the size tiers as marginal ranges', () => {
    const doc = page();
    renderScoring(doc);
    expect(sizeTierRows()).toEqual([
      ['0 to 400', '×1'],
      ['400 to 1,000', '×1.5'],
      ['above 1,000', '×2'],
    ]);
    expect(rows(doc, 'size-tiers')).toEqual(sizeTierRows());
  });

  it('lists every bundled glob, in matching order, then the default class', () => {
    const doc = page();
    renderScoring(doc);
    const items = [...doc.querySelectorAll<HTMLElement>('#class-globs > li')];
    expect(items.map((li) => li.dataset['class'])).toEqual([
      ...CLASS_GLOBS.map((c) => c.name),
      DEFAULT_CLASS,
    ]);
    CLASS_GLOBS.forEach(({ globs }, i) => {
      const shown = [...items[i]!.querySelectorAll('code')].map((code) => code.textContent);
      expect(shown).toEqual([...globs]);
    });
    expect(items.at(-1)!.querySelectorAll('code')).toHaveLength(0);
  });

  it('refuses a slot it has no value for', () => {
    const doc = page();
    doc.body.insertAdjacentHTML('beforeend', '<span data-value="nope"></span>');
    expect(() => {
      renderScoring(doc);
    }).toThrow('no value for data-value="nope"');
  });

  it('renders the page it is loaded in', async () => {
    document.body.innerHTML = page().body.innerHTML;
    await import('../../src/scoring/scoring.ts');
    expect(rows(document, 'class-weights')).toHaveLength(Object.keys(CLASS_WEIGHTS).length);
  });

  it('refuses a page without its tables', () => {
    expect(() => {
      renderScoring(new DOMParser().parseFromString('', 'text/html'));
    }).toThrow('#class-weights is missing');
  });
});
