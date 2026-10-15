#!/usr/bin/env node
/**
 * Builds the unpacked extension into `dist/`.
 *
 *   node scripts/build.mjs           # one build
 *   node scripts/build.mjs --watch   # rebuild on change
 *
 * The background worker is an ES module; the content script and the options page are IIFEs
 * because Chrome runs them as classic scripts.
 */
import { context } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, watchFile, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeIcons } from './icons.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  target: ['chrome116'],
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  { entryPoints: { background: 'src/background/index.ts' }, format: 'esm' },
  {
    entryPoints: { content: 'src/content/index.ts', options: 'src/options/options.ts' },
    format: 'iife',
  },
];

const STATIC_FILES = [
  'manifest.json',
  'package.json',
  'src/options/options.html',
  'src/options/options.css',
  'src/content/content.css',
];

function copyStatic() {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  manifest.version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(root, 'src/options/options.html'), join(dist, 'options.html'));
  copyFileSync(join(root, 'src/options/options.css'), join(dist, 'options.css'));
  copyFileSync(join(root, 'src/content/content.css'), join(dist, 'content.css'));
  writeIcons(join(dist, 'icons'));
}

const contexts = await Promise.all(
  builds.map((b) =>
    context({
      ...common,
      ...b,
      absWorkingDir: root,
      outdir: dist,
      entryNames: '[name]',
    }),
  ),
);

copyStatic();
if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  // Static files are not part of any bundle, so esbuild does not watch them.
  for (const file of STATIC_FILES) {
    watchFile(join(root, file), { interval: 500 }, () => {
      copyStatic();
      console.info(`copied ${file}`);
    });
  }
  console.info('watching… load packages/extension/dist as an unpacked extension');
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  console.info(`built ${dist}`);
}
