import { describe, expect, it } from 'vitest';

import { PUBLISHED_CLASSES } from '@review-ratio/server';
import { ClassificationBudgetError, createClassifier, linesByClass } from '../src/lib/classify.ts';

const classify = createClassifier(
  PUBLISHED_CLASSES.map((c) => ({ name: c.name, globs: [...c.globs] })),
);

describe('createClassifier with the published globs', () => {
  it.each([
    ['src/app/service.ts', 'production'],
    ['Api/Controllers/UserController.cs', 'production'],
    ['lib/main.py', 'production'],
    ['src/app/service.test.ts', 'test'],
    ['src/app/service.spec.tsx', 'test'],
    ['tests/unit/UserControllerTests.cs', 'test'],
    ['pkg/handler_test.go', 'test'],
    ['src/__tests__/a.ts', 'test'],
    ['src/__snapshots__/a.test.ts.snap', 'generated'],
    ['pnpm-lock.yaml', 'generated'],
    ['apps/web/package-lock.json', 'generated'],
    ['packages/db/src/schema.ts', 'generated'],
    ['src/api.generated.ts', 'generated'],
    ['.github/workflows/ci.yml', 'ci'],
    ['README.md', 'docs'],
    ['docs/architecture/overview.png', 'docs'],
    ['scripts/release.sh', 'tooling'],
    ['Dockerfile', 'tooling'],
    ['vite.config.ts', 'tooling'],
    ['package.json', 'config'],
    ['.eslintrc.json', 'config'],
    ['appsettings.Development.json', 'config'],
    ['.prettierrc', 'config'],
    ['infra/main.tf', 'config'],
    ['.vscode/settings.json', 'chore'],
    ['assets/logo.svg', 'chore'],
    ['src/locales/fr.json', 'chore'],
    ['src/locales/index.ts', 'production'],
    ['CODEOWNERS', 'chore'],
    ['src/latest.ts', 'production'],
    ['src/agent/tools/search.ts', 'production'],
    ['src/app/scripts/main.ts', 'production'],
    ['packages/server/scripts/build.mjs', 'tooling'],
    ['tools/gen.py', 'tooling'],
    ['src/components/ABTest.tsx', 'production'],
    ['src/test/java/com/acme/FooTest.java', 'test'],
    ['Api.Tests/FooTest.cs', 'test'],
    ['jest.setup.ts', 'test'],
    ['src/test.ts', 'test'],
    ['tests/conftest.py', 'test'],
    ['wwwroot/lib/bootstrap/dist/css/bootstrap.css', 'generated'],
    ['api/v1/service_pb2_grpc.py', 'generated'],
    ['src/types/schema.d.ts', 'generated'],
    ['Data/Migrations/20240101120000_Init.cs', 'generated'],
    ['shop/migrations/0001_initial.py', 'generated'],
    ['api/schema.graphql', 'production'],
    ['src/contest/manifest.ts', 'production'],
    ['src/build.ts', 'production'],
    ['MyApp.Tests/UserServiceTests.cs', 'test'],
    ['MyApp.IntegrationTests/Setup.cs', 'test'],
    ['db/migrations/0001_init.sql', 'production'],
    ['Data/Migrations/AppDbContextModelSnapshot.cs', 'generated'],
    ['requirements.txt', 'config'],
    ['CMakeLists.txt', 'tooling'],
  ])('%s → %s', (path, expected) => {
    expect(classify(path)).toBe(expected);
  });

  it('ignores a leading ./', () => {
    expect(classify('./README.md')).toBe('docs');
  });

  it('matches case-sensitively like Git', () => {
    expect(classify('src/Latest.cs')).toBe('production');
    expect(classify('src/UserTest.cs')).toBe('test');
  });

  it('falls back to production', () => {
    expect(createClassifier([])('anything.xyz')).toBe('production');
  });

  it('takes the first matching class in published order', () => {
    const custom = createClassifier([
      { name: 'test', globs: ['**/*.ts'] },
      { name: 'docs', globs: ['**/*.ts'] },
    ]);
    expect(custom('a.ts')).toBe('test');
  });
});

describe('linesByClass', () => {
  it('sums per class and omits empty classes', () => {
    expect(
      linesByClass(
        [
          { path: 'a.ts', lines: 10 },
          { path: 'b.ts', lines: 5 },
          { path: 'a.test.ts', lines: 7 },
          { path: 'README.md', lines: 0 },
        ],
        classify,
      ),
    ).toEqual({ production: 15, test: 7 });
  });
});

describe('classification budget', () => {
  it('stops a refresh whose globs take too long, and caches each path', () => {
    let clock = 0;
    let calls = 0;
    const classify = createClassifier([{ name: 'docs', globs: ['**/*.md', '**/*.txt'] }], {
      budgetMs: 10,
      now: () => {
        calls += 1;
        clock += 3;
        return clock;
      },
    });
    expect(classify('a.ts')).toBe('production');
    const callsAfterFirst = calls;
    expect(classify('a.ts')).toBe('production');
    expect(calls).toBe(callsAfterFirst);
    expect(() => {
      for (let i = 0; i < 10; i += 1) classify(`f${i}.ts`);
    }).toThrow(ClassificationBudgetError);
    // Spent for the whole refresh: even a cached-free cheap path now fails at once.
    const before = calls;
    expect(() => classify('another.ts')).toThrow(ClassificationBudgetError);
    expect(calls).toBe(before);
  });

  it('classifies a thousand paths quickly with the published globs, even instrumented', () => {
    const paths = Array.from(
      { length: 1000 },
      (_, i) => `packages/p${i % 50}/src/module${i}/file${i}.ts`,
    );
    const started = performance.now();
    for (const path of paths) classify(path);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
