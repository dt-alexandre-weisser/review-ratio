/**
 * Local file classification against the server's published globs. Only the class name and a line
 * count ever leave the browser; the path is matched here and forgotten.
 */
import picomatch from 'picomatch';

import type { FileClass, LinesByClassV1 } from '@review-ratio/contract';

import type { PublishedClass } from './storage.ts';

export type Classifier = (path: string) => FileClass;

/**
 * Case-sensitive like Git paths, so `*Test.*` never matches `latest.ts`. `windows: false`: GitHub
 * paths always use `/`, whatever OS the browser runs on. `noextglob`: the published globs need no
 * extended patterns, which are the ones that can compile to slow regular expressions.
 */
const MATCH_OPTIONS: picomatch.PicomatchOptions = { dot: true, windows: false, noextglob: true };

/** Builds a classifier: first matching class wins, `production` when nothing matches. */
export function createClassifier(classes: readonly PublishedClass[]): Classifier {
  const matchers = classes.map((cls) => ({
    name: cls.name,
    isMatch: picomatch(cls.globs, MATCH_OPTIONS),
  }));
  return (path) => {
    const normalized = path.replace(/^\.?\//, '');
    for (const m of matchers) {
      if (m.isMatch(normalized)) return m.name;
    }
    return 'production';
  };
}

export interface FileLines {
  path: string;
  lines: number;
}

/** Sums lines per class. Classes with 0 lines are omitted. */
export function linesByClass(files: Iterable<FileLines>, classify: Classifier): LinesByClassV1 {
  const totals: Partial<Record<FileClass, number>> = {};
  for (const file of files) {
    if (file.lines <= 0) continue;
    const cls = classify(file.path);
    totals[cls] = (totals[cls] ?? 0) + file.lines;
  }
  return totals;
}
