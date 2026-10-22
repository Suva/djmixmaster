// Bundles the desktop app into dist/: three Node-side entry points for
// Electron (main, preload, worker) and the browser bundles for the window and its audio worklet.
import { build } from 'esbuild';
import { copyFile, mkdir, readdir } from 'node:fs/promises';

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
  entryPoints: ['src/app/renderer/renderer.ts', 'src/app/renderer/limiter-worklet.ts', 'src/app/renderer/exporter.ts', 'src/app/renderer/capture.ts', 'src/app/renderer/capture-worklet.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  sourcemap: true,
});

for (const file of ['index.html', 'styles.css', 'exporter.html', 'capture.html']) {
  await copyFile(`src/app/renderer/${file}`, `dist/${file}`);
}

// The fonts for videos, with their licences, which have to travel with them.
await mkdir('dist/fonts', { recursive: true });
for (const file of await readdir('assets/fonts').catch(() => [])) {
  if (/\.(ttf|txt)$/.test(file)) await copyFile(`assets/fonts/${file}`, `dist/fonts/${file}`);
}

// The LUTs that come with the app, and the licence of the film looks among them.
await mkdir('dist/luts', { recursive: true });
for (const file of await readdir('assets/luts').catch(() => [])) {
  if (/\.(bin|txt)$/.test(file)) await copyFile(`assets/luts/${file}`, `dist/luts/${file}`);
}

// The manual, as it travels with the app: Help opens it without a network (scripts/build-manual.mjs).
await import('./build-manual.mjs');

// The same for icons taken from others: the licence goes where the app goes.
await mkdir('dist/icons', { recursive: true });
for (const file of await readdir('assets/icons').catch(() => [])) {
  if (file.endsWith('.txt')) await copyFile(`assets/icons/${file}`, `dist/icons/${file}`);
}
