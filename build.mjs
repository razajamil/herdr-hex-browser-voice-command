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

// Extension: browser IIFE bundles, one per entry (zod inlined). No "type":"module".
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

console.log('build complete');
