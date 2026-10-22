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

// The capture helper for recording, when it is missing or older than its source. Where there is no C
// compiler the app does without it, and records with Chromium's capture, two channels at most.
{
  const { existsSync, statSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const helper = `native/capture/build/${process.platform === 'win32' ? 'djm-capture.exe' : 'djm-capture'}`;
  const sources = ['native/capture/capture.c', 'native/capture/miniaudio/miniaudio.h'];
  const stale = !existsSync(helper) || sources.some((source) => statSync(source).mtimeMs > statSync(helper).mtimeMs);
  if (stale && spawnSync(process.execPath, ['scripts/build-capture.mjs'], { stdio: 'inherit' }).status !== 0) {
    console.warn('The capture helper was not built: recording will use Chromium, inputs 1 and 2 only.');
  }
}

// The manual, as it travels with the app: Help opens it without a network (scripts/build-manual.mjs).
await import('./build-manual.mjs');

// The same for icons taken from others: the licence goes where the app goes.
await mkdir('dist/icons', { recursive: true });
for (const file of await readdir('assets/icons').catch(() => [])) {
  if (file.endsWith('.txt')) await copyFile(`assets/icons/${file}`, `dist/icons/${file}`);
}
