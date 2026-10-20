// The shape of a video in the window: chosen in the Video view, undone, and
// exported. See window-app.ts for how the window is driven.

import assert from 'node:assert/strict';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { probe } from '../src/audio-io.ts';
import { writeSyntheticMix } from './synthetic-mix.ts';
import { dataFolder, electronPath, runApp, workFolder } from './window-app.ts';

const skip = process.env.DJMASTER_SKIP_WINDOW_TESTS
  ? 'DJMASTER_SKIP_WINDOW_TESTS is set'
  : electronPath() ? false : 'Electron is not installed here';

let work: string;
let mix: string;
let analysed: string;
const fresh = () => dataFolder(work, analysed);

before(async () => {
  if (skip) return;
  work = await workFolder();
  mix = join(work, 'Test mix.wav');
  await writeSyntheticMix(mix);
  analysed = await dataFolder(work);
  await runApp({ recording: mix, data: analysed }, () => null);
});

after(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

/** The width, height and length of a video's picture, as ffmpeg reads them. */
async function pictureOf(file: string): Promise<{ width: number; height: number; seconds: number }> {
  const { video, duration } = await probe(file);
  return { width: video!.width, height: video!.height, seconds: duration };
}

test('the shape of a mix\'s video is chosen, undone and redone, and exported', { skip }, async () => {
  const folder = join(work, 'square');
  await mkdir(folder);
  const seen = await runApp({ recording: mix, data: await fresh(), exportFolder: folder, timeoutMs: 120_000 }, async (page) => {
    // A mix of ten seconds, to keep the export short.
    page.key('Home');
    page.key('KeyI');
    for (let i = 0; i < 2; i++) page.key('ArrowRight');
    page.key('KeyO');
    page.click('view-video');
    const picture = page.element<HTMLCanvasElement>('picture');
    const landscape = picture.width > picture.height;
    document.querySelector<HTMLButtonElement>('#video-shape [data-shape=square]')!.click();
    await page.drawn();
    const square = picture.width === picture.height;
    await page.saved();
    page.click('undo');
    await page.drawn();
    const undone = picture.width > picture.height;
    page.click('redo');
    await page.drawn();
    page.click('export');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    document.querySelector<HTMLButtonElement>('[data-format=mp4]')!.click();
    page.click('export-go');
    await page.until(() => /^Export/.test(page.text('export-status')), 'the export to finish', 100_000);
    return { landscape, square, undone, status: page.text('export-status') };
  });
  assert.deepEqual({ ...seen, status: undefined }, { landscape: true, square: true, undone: true, status: undefined });
  const [file] = await readdir(folder);
  const picture = await pictureOf(join(folder, file));
  assert.deepEqual([picture.width, picture.height], [1080, 1080]);
});
