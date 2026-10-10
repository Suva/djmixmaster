// Bundles the desktop app into dist/: three Node-side entry points for
// Electron (main, preload, worker) and the browser bundles for the window and its audio worklet.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

await build({
  entryPoints: ['src/app/main.ts', 'src/app/preload.ts', 'src/app/worker.ts'],
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
});

await build({
  entryPoints: ['src/app/renderer/renderer.ts', 'src/app/renderer/limiter-worklet.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  sourcemap: true,
});

for (const file of ['index.html', 'styles.css']) {
  await copyFile(`src/app/renderer/${file}`, `dist/${file}`);
}
