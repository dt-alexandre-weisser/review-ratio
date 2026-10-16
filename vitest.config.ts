import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // Thin entry points that only wire real Chrome and Node APIs; the end-to-end suite runs them.
      exclude: [
        '**/*.d.ts',
        'packages/extension/src/content/index.ts',
        'packages/extension/src/options/options.ts',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        'packages/extension/src/lib/scoring/**': {
          lines: 95,
          functions: 95,
          branches: 90,
          statements: 95,
        },
        'packages/extension/src/**': { lines: 90, functions: 90, branches: 85, statements: 90 },
      },
    },
  },
});
