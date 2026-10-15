import { PUBLISHED_CLASSES } from '@review-ratio/server';
import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';

import {
  GlobError,
  compileGlob,
  expandBraces,
  matchPattern,
  splitPath,
  unsupportedSyntax,
} from '../src/lib/glob.ts';

function matches(glob: string, path: string): boolean {
  const parts = splitPath(path);
  return compileGlob(glob).some((pattern) => matchPattern(pattern, parts));
}

const PICO = { dot: true, windows: false, noextglob: true } as const;

/** Realistic repository paths, plus the edge cases of every published class. */
const CORPUS = [
  'README.md',
  'docs/architecture/overview.png',
  'src/app.ts',
  'src/app.test.ts',
  'src/components/ABTest.tsx',
  'src/latest.ts',
  'src/agent/tools/search.ts',
  'src/app/scripts/main.ts',
  'src/locales/fr.json',
  'src/locales/en/common.yaml',
  'src/i18n/index.ts',
  'src/types/schema.d.ts',
  'src/api.generated.ts',
  'src/__tests__/a.ts',
  'src/__snapshots__/a.test.ts.snap',
  'src/test.ts',
  'packages/db/src/schema.ts',
  'packages/server/scripts/build.mjs',
  'apps/web/tools/gen.ts',
  'apps/web/package-lock.json',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
  '.github/workflows/ci.yml',
  '.github/CODEOWNERS',
  '.gitlab-ci.yml',
  '.eslintrc.json',
  '.prettierrc',
  '.env.local',
  '.vscode/settings.json',
  '.devcontainer/devcontainer.json',
  'Dockerfile',
  'docker-compose.yml',
  'compose.yaml',
  'Makefile',
  'scripts/release.sh',
  'tools/gen.py',
  'bin/run',
  'vite.config.ts',
  'tailwind.config.js',
  'jest.setup.ts',
  'karma.conf.js',
  'tests/conftest.py',
  'tests/unit/UserControllerTests.cs',
  'MyApp.Tests/UserServiceTests.cs',
  'Api.Tests/FooTest.cs',
  'src/test/java/com/acme/FooTest.java',
  'pkg/handler_test.go',
  'Data/Migrations/20240101120000_Init.cs',
  'Data/Migrations/AppDbContextModelSnapshot.cs',
  'Forms/Main.Designer.cs',
  'shop/migrations/0001_initial.py',
  'db/migrations/0001_init.sql',
  'alembic/versions/abc123_add_users.py',
  'wwwroot/lib/bootstrap/dist/css/bootstrap.css',
  'vendor/github.com/x/y.go',
  'api/v1/service_pb2.py',
  'api/v1/service_pb2_grpc.py',
  'api/schema.graphql',
  'infra/main.tf',
  'appsettings.Development.json',
  'web.config',
  'requirements.txt',
  'CMakeLists.txt',
  'LICENSE',
  'CHANGELOG.md',
  'assets/logo.svg',
  'assets/font.woff2',
  'data/cities.csv',
  'MyApp.sln',
  'src/MyApp/MyApp.csproj',
  'Directory.Build.props',
  'app/build.gradle.kts',
  'src/x.min.js',
  'src/x.js.map',
  'src/generated/client.ts',
  'cypress/e2e/login.cy.ts',
  'src/Button.stories.tsx',
  'fixtures/user.json',
  '.husky/pre-commit',
  'src/.hidden/file.ts',
];

describe('glob matcher against picomatch', () => {
  it('classifies the corpus exactly like picomatch, for every published glob', () => {
    const differences: string[] = [];
    for (const cls of PUBLISHED_CLASSES) {
      for (const glob of cls.globs) {
        const reference = picomatch(glob, PICO);
        for (const path of CORPUS) {
          if (matches(glob, path) !== reference(path)) {
            differences.push(
              `${glob} ${path}: ours ${matches(glob, path)}, picomatch ${reference(path)}`,
            );
          }
        }
      }
    }
    expect(differences).toEqual([]);
  });

  it.each([
    ['*.md', 'a.md', true],
    ['*.md', 'docs/a.md', false],
    ['**/*.md', 'a.md', true],
    ['**/*.md', 'x/y/a.md', true],
    ['docs/**', 'docs/a/b.png', true],
    ['docs/**', 'other/a.png', false],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['a**b', 'axxb', true],
    ['a**b', 'ax/xb', false],
    ['**/.*rc', '.eslintrc', true],
    ['**/.*rc', 'x/.npmrc', true],
    ['*', '.hidden', true],
    ['?.ts', 'a.ts', true],
    ['?.ts', 'ab.ts', false],
    ['[0-9][0-9]_*.py', '01_init.py', true],
    ['[^0-9]*.py', '01.py', false],
    ['[^0-9]*.py', 'a1.py', true],
    ['[!0-9]*.py', '01.py', true],
    ['[!0-9]*.py', 'a1.py', false],
    ['{a,b}/*.ts', 'b/x.ts', true],
    ['{a,{b,c}}/x', 'c/x', true],
    ['{a}/x', '{a}/x', true],
    ['\\*.ts', '*.ts', true],
    ['\\*.ts', 'a.ts', false],
    ['*Test.{cs,java}', 'FooTest.java', true],
    ['*Test.{cs,java}', 'latest.java', false],
    // A trailing ** right after a star needs a directory; elsewhere it may match nothing.
    ['**/test*/**', 'src/testimonials.tsx', false],
    ['**/test*/**', 'src/testing/a.ts', true],
    ['src/test*/**', 'src/testUtils.ts', false],
    ['test*/**', 'testing.py', false],
    ['x/a*/**/**', 'x/ab', false],
    ['docs/**', 'docs', true],
    ['*a/**', 'ba', true],
    ['a*\\*/**', 'ab*', true],
    ['a*/**/b', 'ax/b', true],
  ])('%s against %s is %s, as picomatch says', (glob, path, expected) => {
    expect(matches(glob, path)).toBe(expected);
    expect(picomatch(glob, PICO)(path)).toBe(expected);
  });
});

describe('expandBraces', () => {
  it('expands nested alternatives and refuses explosions', () => {
    expect(expandBraces('{a,b}{c,d}', 10)).toEqual(['ac', 'ad', 'bc', 'bd']);
    expect(expandBraces('x', 10)).toEqual(['x']);
    expect(() => expandBraces('{a,b}{c,d}{e,f}{g,h}', 10)).toThrow(GlobError);
  });
});

describe('matching cost', () => {
  const time = (glob: string, path: string) => {
    const started = performance.now();
    matches(glob, path);
    return performance.now() - started;
  };

  it('stays fast on globs that make regular expressions backtrack for seconds', () => {
    const q46 = '?'.repeat(46);
    const worst = Math.max(
      time('*?**?**?**?*', `${'x'.repeat(140)}/b`),
      time(
        `**/*${q46}**${q46}**?*Q`,
        'packages/extension/src/lib/collect/review-summary-builder.test.tsx',
      ),
      time('*a*a*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(255)),
      time(
        Array.from({ length: 30 }, () => '*a*').join('/'),
        `${Array.from({ length: 60 }, () => 'aaaa').join('/')}/zzz`,
      ),
      time('**/**/**/**/**/**/*a*b', `${Array.from({ length: 200 }, () => 'aaaa').join('/')}/zzz`),
    );
    expect(worst).toBeLessThan(50);
  });
});

describe('unsupportedSyntax', () => {
  it('names the syntax picomatch reads in ways this matcher does not reproduce', () => {
    expect(unsupportedSyntax('**.md')).toMatch(/whole path segment/);
    expect(unsupportedSyntax('a/x**y')).toMatch(/whole path segment/);
    expect(unsupportedSyntax('{a,b}**/c')).toMatch(/whole path segment/);
    expect(unsupportedSyntax('app/(group)/*.ts')).toMatch(/groups/);
    expect(unsupportedSyntax('a|b')).toMatch(/groups/);
    expect(unsupportedSyntax('!**/*.md')).toMatch(/negated/);
    expect(unsupportedSyntax('file{1..9}.ts')).toMatch(/ranges/);
    expect(unsupportedSyntax('*{x,*}')).toMatch(/inside \{\}/);
    expect(unsupportedSyntax('{a?,b}')).toMatch(/inside \{\}/);
    expect(unsupportedSyntax('{a,\\*}')).toBeNull();
  });

  it('accepts every published glob', () => {
    for (const cls of PUBLISHED_CLASSES) {
      for (const glob of cls.globs) expect(unsupportedSyntax(glob), glob).toBeNull();
    }
  });
});

describe('glob matcher fuzzed against picomatch', () => {
  /** mulberry32: a small generator whose low bits are as random as its high ones. */
  function random(seed: number) {
    let a = seed;
    return (n: number) => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
  }

  it('agrees on 50,000 random globs and paths of the supported syntax', () => {
    const rnd = random(20261015);
    const pick = <T>(xs: readonly T[]) => xs[rnd(xs.length)]!;
    const tokens = [
      'a',
      'b',
      '.',
      'x',
      'A',
      '-',
      '_',
      '*',
      '?',
      '[ab]',
      '[^a]',
      '[a-c]',
      '{a,b}',
      '{x,*}',
      'ab',
      '.a',
      '\\*',
    ];
    // Realistic Git paths: no `.` or `..` segments, no braces or brackets (picomatch also
    // compares the glob as plain text, which a class glob never needs).
    const segments = [
      'a',
      'b',
      'ab',
      'ba',
      '.a',
      'x.a',
      'aa',
      'A',
      'abx',
      'b.a',
      'a-b',
      'x_',
      '*',
      '.ab',
    ];
    const differences: string[] = [];
    for (let i = 0; i < 50_000; i += 1) {
      const glob = Array.from({ length: 1 + rnd(4) }, () =>
        rnd(4) === 0 ? '**' : Array.from({ length: 1 + rnd(3) }, () => pick(tokens)).join(''),
      ).join('/');
      if (unsupportedSyntax(glob)) continue;
      const path = Array.from({ length: 1 + rnd(4) }, () => pick(segments)).join('/');
      if (matches(glob, path) !== picomatch(glob, PICO)(path)) differences.push(`${glob} ${path}`);
    }
    expect(differences.slice(0, 20)).toEqual([]);
  });
});
