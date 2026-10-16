/**
 * File classification against the bundled class globs (scoring/classes.ts). The path is matched
 * here and forgotten: only the class name and a line count are kept.
 */
import { compileGlob, matchPattern, splitPath } from './glob.ts';
import type { ClassGlobs, FileClass, LinesByClass } from './scoring/classes.ts';

export type Classifier = (path: string) => FileClass;

/** A refresh spends at most this much time classifying paths, so a huge PR cannot hang it. */
export const CLASSIFICATION_BUDGET_MS = 5_000;

export class ClassificationBudgetError extends Error {
  constructor() {
    super('classifying files took too long');
    this.name = 'ClassificationBudgetError';
  }
}

export interface ClassifierOptions {
  budgetMs?: number;
  now?: () => number;
}

/**
 * Builds a classifier: first matching class wins, `production` when nothing matches. Matching is
 * case-sensitive like Git (`*Test.*` never matches `latest.ts`) and uses no regular expressions
 * (see glob.ts). Each path is classified once per classifier, and the total time is bounded.
 */
export function createClassifier(
  classes: readonly ClassGlobs[],
  options: ClassifierOptions = {},
): Classifier {
  const budgetMs = options.budgetMs ?? CLASSIFICATION_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const compiled = classes.map((cls) => ({
    name: cls.name,
    patterns: cls.globs.flatMap((glob) => compileGlob(glob)),
  }));
  const cache = new Map<string, FileClass>();
  let spent = 0;

  return (path) => {
    const cached = cache.get(path);
    if (cached) return cached;
    if (spent > budgetMs) throw new ClassificationBudgetError();
    const started = now();
    const parts = splitPath(path);
    let result: FileClass = 'production';
    search: for (const cls of compiled) {
      for (const pattern of cls.patterns) {
        if (matchPattern(pattern, parts)) {
          result = cls.name;
          break search;
        }
        if (spent + now() - started > budgetMs) {
          // Spent for good: every later path of this refresh fails at once.
          spent = Number.POSITIVE_INFINITY;
          throw new ClassificationBudgetError();
        }
      }
    }
    spent += now() - started;
    cache.set(path, result);
    return result;
  };
}

export interface FileLines {
  path: string;
  lines: number;
}

/** Sums lines per class. Classes with 0 lines are omitted. */
export function linesByClass(files: Iterable<FileLines>, classify: Classifier): LinesByClass {
  const totals: LinesByClass = {};
  for (const file of files) {
    if (file.lines <= 0) continue;
    const cls = classify(file.path);
    totals[cls] = (totals[cls] ?? 0) + file.lines;
  }
  return totals;
}
