// Tests of shape layers in the window: a progress bar that follows the track
// playing. See window.test.ts for how these run.

import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { writeSyntheticMix } from './synthetic-mix.ts';
import { dataFolder, electronPath, runApp, workFolder } from './window-app.ts';

const skip = process.env.DJMASTER_SKIP_WINDOW_TESTS
  ? 'DJMASTER_SKIP_WINDOW_TESTS is set'
  : electronPath() ? false : 'Electron is not installed here';

let work: string;
let mix: string;
let analysed: string;

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

test('a shape drawn as far as trackProgress says fills across each track', { skip }, async () => {
  // A white bar the size of the picture, drawn from the left as far through the track as the playhead is.
  const file = join(work, 'Bar.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1, name: 'Bar', fields: [],
    layers: [
      { type: 'solid', params: { colour: '#000000' } },
      { type: 'shape', params: { width: 100, height: 100, fillColour: '#ffffff', restColour: '#ff0000', amount: 'trackProgress' } },
    ],
  }));
  const data = await dataFolder(work, analysed);
  const seen = await runApp({ recording: mix, data, template: file, timeoutMs: 60_000 }, async (page) => {
    // Tracks marked at 30 and 60 seconds, then the playhead back to 45: half way through the first.
    page.key('Enter');
    for (let i = 0; i < 6; i++) page.key('ArrowRight');
    page.key('KeyM');
    for (let i = 0; i < 6; i++) page.key('ArrowRight');
    page.key('KeyM');
    for (let i = 0; i < 3; i++) page.key('ArrowLeft');
    await page.settle();
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Bar', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const at = (x: number) => [...picture.getContext('2d')!.getImageData(Math.floor(picture.width * x), picture.height / 2, 1, 1).data].slice(0, 3);
    await page.until(() => at(0.25)[0] > 200, 'the bar to be drawn');
    await page.wait(300);
    return { quarter: at(0.25), threeQuarters: at(0.75) };
  });
  assert.deepEqual(seen.quarter, [255, 255, 255], 'a quarter across is drawn');
  assert.deepEqual(seen.threeQuarters, [255, 0, 0], 'three quarters across is not yet, and in the colour for that');
});
