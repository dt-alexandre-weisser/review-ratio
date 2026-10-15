/**
 * A glob matcher without regular expressions.
 *
 * The class globs come from the server. Compiled to regular expressions (picomatch), a crafted
 * glob backtracks for seconds per path. This matcher cannot: `*` and `?` match within a segment
 * with the linear-backtrack wildcard algorithm (O(text × pattern) at worst), and `**` spans
 * segments by dynamic programming over (pattern segment, path segment). Braces are expanded up
 * front, with a cap.
 *
 * Supported syntax, with picomatch's meaning under `{ dot: true }`: `*`, `?`, `**` as a whole
 * segment (zero or more segments; a trailing `/**` right after a `*` needs at least one),
 * `[...]` classes with ranges and `^` negation, `{a,b}` alternatives (nestable), and `\`
 * escapes. Matching is case-sensitive. `unsupportedSyntax` names everything else, which
 * picomatch reads in ways this matcher does not reproduce: `**` inside a segment, `(`, `)`, `|`,
 * a leading `!`, `{1..9}` ranges, and wildcards inside `{}` alternatives.
 */

type Token =
  | { kind: 'char'; value: string }
  | { kind: 'any' }
  | { kind: 'star' }
  | { kind: 'class'; negate: boolean; ranges: [string, string][] };

type Segment = { kind: 'globstar' } | { kind: 'tokens'; tokens: Token[] };

/** One brace alternative of a glob, split into segments. */
export interface CompiledPattern {
  segments: Segment[];
  /**
   * The glob ends with a star followed by a trailing globstar segment (like `test*` then `/**`):
   * picomatch then requires at least one segment for that trailing `**`, so such a glob does not
   * match the file `testing.py`.
   */
  trailingNeedsSegment: boolean;
}

/** Why a glob uses syntax this matcher does not support, or `null`. */
export function unsupportedSyntax(glob: string): string | null {
  if (glob.startsWith('!')) return 'negated globs (leading !) are not supported';
  if (/[()|]/.test(glob)) return 'groups and alternation with ( ) | are not supported';
  if (/\{[^{}]*\.\.[^{}]*\}/.test(glob)) return 'brace ranges such as {1..9} are not supported';
  if (wildcardInsideBraces(glob)) return 'wildcards inside {} alternatives are not supported';
  for (const alternative of expandBraces(glob, 1_000)) {
    if (alternative.split('/').some((segment) => segment.includes('**') && segment !== '**')) {
      return '** is only supported as a whole path segment';
    }
  }
  return null;
}

/** Whether an unescaped `*`, `?` or `[` sits inside braces (picomatch lets such a `*` cross `/`). */
function wildcardInsideBraces(glob: string): boolean {
  let depth = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '\\') i += 1;
    else if (c === '{') depth += 1;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (depth > 0 && (c === '*' || c === '?' || c === '[')) return true;
  }
  return false;
}

/** Whether the glob text ends with one or more globstar segments right after an unescaped star. */
function endsWithStarThenGlobstar(glob: string): boolean {
  let end = glob.length;
  while (glob.slice(0, end).endsWith('/**')) end -= 3;
  if (end === glob.length || glob[end - 1] !== '*') return false;
  // Count the backslashes before that star: an odd number escapes it.
  let slashes = 0;
  for (let i = end - 2; i >= 0 && glob[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 0;
}

export class GlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlobError';
  }
}

/** Expands `{a,b}` alternatives, nested ones included. Throws past `limit` alternatives. */
export function expandBraces(glob: string, limit: number): string[] {
  const open = findOpenBrace(glob);
  if (open < 0) return [glob];
  const close = findMatchingBrace(glob, open);
  if (close < 0) return [glob];
  const options = splitTopLevel(glob.slice(open + 1, close));
  // `{a}` is not an alternative in picomatch: keep the braces literally.
  if (options.length < 2) return [glob];
  const prefix = glob.slice(0, open);
  const suffix = glob.slice(close + 1);
  const out: string[] = [];
  for (const option of options) {
    for (const expanded of expandBraces(`${prefix}${option}${suffix}`, limit)) {
      out.push(expanded);
      if (out.length > limit) throw new GlobError(`more than ${limit} brace alternatives`);
    }
  }
  return out;
}

function findOpenBrace(glob: string): number {
  for (let i = 0; i < glob.length; i += 1) {
    if (glob[i] === '\\') i += 1;
    else if (glob[i] === '{') return i;
  }
  return -1;
}

function findMatchingBrace(glob: string, open: number): number {
  let depth = 0;
  for (let i = open; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '\\') i += 1;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '\\') i += 1;
    else if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment.charAt(i);
    if (c === '\\' && i + 1 < segment.length) {
      i += 1;
      tokens.push({ kind: 'char', value: segment.charAt(i) });
    } else if (c === '*') {
      // Consecutive stars inside a segment match like one.
      if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' });
    } else if (c === '?') {
      tokens.push({ kind: 'any' });
    } else if (c === '[') {
      const parsed = parseClass(segment, i);
      if (parsed) {
        tokens.push(parsed.token);
        i = parsed.end;
      } else {
        tokens.push({ kind: 'char', value: c });
      }
    } else {
      tokens.push({ kind: 'char', value: c });
    }
  }
  return tokens;
}

function parseClass(segment: string, open: number): { token: Token; end: number } | null {
  let i = open + 1;
  let negate = false;
  // Only `^` negates, as in picomatch; `!` is an ordinary class member there.
  if (segment[i] === '^') {
    negate = true;
    i += 1;
  }
  const ranges: [string, string][] = [];
  let first = true;
  for (; i < segment.length; i += 1) {
    let c = segment.charAt(i);
    if (c === ']' && !first) return { token: { kind: 'class', negate, ranges }, end: i };
    first = false;
    if (c === '\\' && i + 1 < segment.length) {
      i += 1;
      c = segment.charAt(i);
    }
    if (segment[i + 1] === '-' && i + 2 < segment.length && segment[i + 2] !== ']') {
      ranges.push([c, segment.charAt(i + 2)]);
      i += 2;
    } else {
      ranges.push([c, c]);
    }
  }
  return null;
}

/** Compiles a glob into its brace alternatives. */
export function compileGlob(glob: string, maxAlternatives = 64): CompiledPattern[] {
  const trailingNeedsSegment = endsWithStarThenGlobstar(glob);
  return expandBraces(glob, maxAlternatives).map((alternative) => ({
    trailingNeedsSegment,
    segments: alternative
      .replace(/^\.\//, '')
      .split('/')
      .map((segment): Segment =>
        segment === '**' ? { kind: 'globstar' } : { kind: 'tokens', tokens: tokenize(segment) },
      ),
  }));
}

function matchesChar(token: Token, c: string): boolean {
  switch (token.kind) {
    case 'char':
      return token.value === c;
    case 'any':
      return true;
    case 'class': {
      const inside = token.ranges.some(([from, to]) => c >= from && c <= to);
      return token.negate ? !inside : inside;
    }
    case 'star':
      return false;
  }
}

/** Wildcard match of one path segment: linear backtracking to the last star only. */
export function matchSegment(tokens: readonly Token[], text: string): boolean {
  let t = 0;
  let p = 0;
  let starAt = -1;
  let starText = 0;
  while (t < text.length) {
    const token = tokens[p];
    if (token && token.kind !== 'star' && matchesChar(token, text.charAt(t))) {
      p += 1;
      t += 1;
    } else if (token?.kind === 'star') {
      starAt = p;
      p += 1;
      starText = t;
    } else if (starAt >= 0) {
      p = starAt + 1;
      starText += 1;
      t = starText;
    } else {
      return false;
    }
  }
  while (tokens[p]?.kind === 'star') p += 1;
  return p === tokens.length;
}

/** `.` and `..` segments: `**` and a leading `*` never match them, as in picomatch. */
function isDotSegment(part: string | undefined): boolean {
  return part === '.' || part === '..';
}

function matchPart(tokens: readonly Token[], part: string): boolean {
  if (isDotSegment(part) && tokens[0]?.kind === 'star') return false;
  return matchSegment(tokens, part);
}

/** Whether a path, split into segments, matches one compiled pattern. */
export function matchPattern(pattern: CompiledPattern, parts: readonly string[]): boolean {
  const { segments } = pattern;
  // Cheap rejects first: most globs fail on the file name, the last segment.
  const last = segments.at(-1);
  if (last?.kind === 'tokens' && !matchPart(last.tokens, parts.at(-1) ?? '')) return false;
  if (!segments.some((segment) => segment.kind === 'globstar')) {
    if (segments.length !== parts.length) return false;
    return segments.every(
      (segment, j) => segment.kind === 'tokens' && matchPart(segment.tokens, parts[j] ?? ''),
    );
  }
  // The first globstar of the trailing run, when it must consume at least one segment.
  let firstTrailing = segments.length;
  while (firstTrailing > 0 && segments[firstTrailing - 1]?.kind === 'globstar') firstTrailing -= 1;
  const needsOne = pattern.trailingNeedsSegment ? firstTrailing : -1;

  // reachable[j]: the pattern segments seen so far can consume exactly the first j path segments.
  let reachable = new Uint8Array(parts.length + 1);
  reachable[0] = 1;
  for (const [index, segment] of segments.entries()) {
    const next = new Uint8Array(parts.length + 1);
    let any = false;
    if (segment.kind === 'globstar') {
      // Zero or more segments from any reachable position (one or more for `needsOne`),
      // stopping at `.` and `..`.
      const min = index === needsOne ? 1 : 0;
      // open: some reachable start lies before j (at or before j when zero segments are allowed)
      // with no `.` or `..` segment in between. Linear in the number of path segments.
      let open = false;
      for (let j = 0; j <= parts.length; j += 1) {
        if (min === 0 && reachable[j]) open = true;
        if (open) {
          next[j] = 1;
          any = true;
        }
        if (min === 1 && reachable[j]) open = true;
        if (isDotSegment(parts[j])) open = false;
      }
    } else {
      for (let j = 0; j < parts.length; j += 1) {
        if (reachable[j] && matchPart(segment.tokens, parts[j] ?? '')) {
          next[j + 1] = 1;
          any = true;
        }
      }
    }
    if (!any) return false;
    reachable = next;
  }
  return reachable[parts.length] === 1;
}

export function splitPath(path: string): string[] {
  return path.replace(/^\.?\//, '').split('/');
}
