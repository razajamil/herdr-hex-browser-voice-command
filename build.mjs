import { build } from 'esbuild';

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

// Daemon: Node bundles (zod inlined → no runtime node_modules). CJS = no "type":"module".
await build({
  ...common,
  entryPoints: ['daemon/src/server.ts', 'daemon/src/test-match.ts'],
  outdir: 'daemon/dist',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});

// Extension entry/UI bundles: browser IIFE, one per entry (zod inlined). No "type":"module".
// content.ts stays tiny — it dynamic-import()s the annotation engine below on demand.
await build({
  ...common,
  entryPoints: [
    'extension/src/background.ts',
    'extension/src/content.ts',
    'extension/src/popup.ts',
    'extension/src/options.ts',
  ],
  outdir: 'extension/dist',
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'],
});

// Annotation engine (Fabric.js): a standalone ESM chunk → dist/annotate.js. Loaded lazily via
// dynamic import() only when the user starts drawing, so Fabric isn't parsed on every page.
// Must be ESM (import()'d as a module) and listed in the manifest's web_accessible_resources.
await build({
  ...common,
  entryPoints: { annotate: 'extension/src/annotate/index.ts' },
  outdir: 'extension/dist',
  platform: 'browser',
  format: 'esm',
  target: ['chrome120'],
});

console.log('build complete');
