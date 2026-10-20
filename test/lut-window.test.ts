// Tests of LUT layers in the window: one kept in a template, one chosen for a
// mix through a field, one added in the editor, and the export. See
// window.test.ts for how these run.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ffmpeg } from '../src/audio-io.ts';
import { packLut, parseCube } from '../src/visuals/lut.ts';
import { whiteBalance } from '../src/visuals/colour.ts';
import { writeSyntheticMix } from './synthetic-mix.ts';
import { readZip, readZipEntry } from '../src/app/zip.ts';
import { dataFolder, electronPath, runApp, workFolder } from './window-app.ts';

const skip = process.env.DJMASTER_SKIP_WINDOW_TESTS
  ? 'DJMASTER_SKIP_WINDOW_TESTS is set'
  : electronPath() ? false : 'Electron is not installed here';

let work: string;
let mix: string;
let analysed: string;

/** A 3D cube of two points a side, each point given by `f`. */
function cube(f: (r: number, g: number, b: number) => number[]): string {
  const rows: string[] = [];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(f(r, g, b).join(' '));
  return `LUT_3D_SIZE 2\n${rows.join('\n')}\n`;
}

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

test('a LUT kept in a template, one chosen for the mix, and one added in the editor change the picture beneath, in the view and the export', { skip }, async () => {
  // Inverted by the one the template keeps, then halved by the 1D one chosen for the mix.
  const half = join(work, 'Half.cube');
  await writeFile(half, `TITLE "Half"\nLUT_1D_SIZE 2\n0 0 0\n0.5 0.5 0.5\n`);
  const file = join(work, 'Looks.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1, name: 'Looks',
    fields: [{ key: 'look', label: 'Look', kind: 'lut', default: '' }],
    luts: { Invert: packLut(parseCube(cube((r, g, b) => [1 - r, 1 - g, 1 - b]))) },
    layers: [
      { type: 'gradient', params: { colour1: '#c83214', colour2: '#c83214' } },
      { type: 'lut', params: { lut: 'lut:Invert' } },
      { type: 'lut', params: { lut: '%look%' } },
    ],
  }));
  const folder = join(work, 'looks');
  await mkdir(folder);
  const data = await dataFolder(work, analysed);
  const seen = await runApp({ recording: mix, data, template: file, lut: half, exportFolder: folder, timeoutMs: 150_000 }, async (page) => {
    page.key('Enter');
    for (let i = 0; i < 2; i++) page.key('ArrowRight');
    await page.wait(100);
    page.key('KeyO');
    page.key('Enter');
    await page.settle();
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Looks', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const middle = () => [...picture.getContext('2d')!.getImageData(picture.width / 2, picture.height / 2, 1, 1).data].slice(0, 3);
    const near = (want: number[]) => () => middle().every((v, i) => Math.abs(v - want[i]) <= 2);
    await page.until(near([55, 205, 235]), 'the picture to be inverted');
    const inverted = middle();
    page.click('field-look');
    document.querySelector<HTMLButtonElement>('#video-fields .lut-add')!.click();
    await page.until(near([28, 102, 118]), 'the picture to be inverted and halved');
    const halved = middle();
    const chosen = page.text('field-look');

    page.click('export-all');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    document.querySelector<HTMLButtonElement>('[data-format=mp4]')!.click();
    page.click('export-go');
    await page.until(() => /^Export/.test(page.text('export-status')), 'the export to finish', 120_000);
    const status = page.text('export-status');

    // In the editor, a LUT layer is added from a file, and kept in the template.
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    page.click('editor-add');
    document.querySelector<HTMLButtonElement>('#editor-add-menu button[data-type="lut"]')!.click();
    await page.wait(100);
    page.click('setting-lut');
    const offered = [...document.querySelectorAll('#editor-layer .lut-menu .lut-group, #editor-layer .lut-menu .lut-item')].map((item) => item.textContent);
    document.querySelector<HTMLButtonElement>('#editor-layer .lut-add')!.click();
    await page.until(() => page.element('setting-lut')?.dataset.value === 'lut:Half', 'the LUT to be kept');
    await page.wait(600);
    page.click('editor-done');
    await page.wait(200);
    return { inverted, halved, chosen, status, offered };
  });
  assert.deepEqual(seen.offered.slice(0, 5), ['None', 'Field: Look', 'Kept in the template', 'Invert', 'Looks'], 'then those that come with the app');
  assert.equal(seen.chosen, 'Half');
  assert.match(seen.status, /^Exported 1 mix\./, seen.status);

  // The export's picture is the view's, give or take what H.264 does to a colour.
  const [exported] = await readdir(folder);
  const pixel = execFileSync(ffmpeg(), [
    '-v', 'error', '-ss', '1', '-i', join(folder, exported), '-frames:v', '1', '-vf', 'crop=2:2:iw/2:ih/2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  [...pixel.subarray(0, 3)].forEach((v, i) => assert.ok(Math.abs(v - seen.halved[i]) <= 12, `the export shows ${[...pixel.subarray(0, 3)]}, the view ${seen.halved}`));

  const [stored] = await readdir(join(data, 'templates'));
  const saved = JSON.parse(readFileSync(join(data, 'templates', stored), 'utf8'));
  assert.deepEqual(Object.keys(saved.luts), ['Invert', 'Half']);
  assert.equal(saved.luts.Half.title, 'Half');
  assert.ok(saved.layers.some((layer: { type: string; params: { lut?: string } }) => layer.type === 'lut' && layer.params.lut === 'lut:Half'));
});

test('the LUT folder\'s LUTs are offered, stepped through with the arrow keys, named rather than kept, and packed into a template file exported', { skip }, async () => {
  const data = await dataFolder(work, analysed);
  const folder = join(data, 'luts');
  await mkdir(join(folder, 'Film'), { recursive: true });
  await writeFile(join(folder, 'Film', 'Invert.cube'), cube((r, g, b) => [1 - r, 1 - g, 1 - b]));
  await writeFile(join(folder, 'Swap.cube'), cube((r, g, b) => [b, g, r]));
  await writeFile(join(folder, 'notes.txt'), 'not a LUT');
  const file = join(work, 'Folder looks.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1, name: 'Folder looks',
    fields: [{ key: 'look', label: 'Look', kind: 'lut', default: '' }],
    layers: [
      { type: 'gradient', params: { colour1: '#c83214', colour2: '#c83214' } },
      { type: 'lut', params: { lut: '%look%' } },
    ],
  }));
  const shared = join(work, 'shared looks');
  await mkdir(shared);
  const running = runApp({ recording: mix, data, template: file, exportFolder: shared, timeoutMs: 90_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Folder looks', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const middle = () => [...picture.getContext('2d')!.getImageData(picture.width / 2, picture.height / 2, 1, 1).data].slice(0, 3);
    const near = (want: number[]) => () => middle().every((v, i) => Math.abs(v - want[i]) <= 2);
    const listed = () => [...document.querySelectorAll('#video-fields .lut-menu .lut-group, #video-fields .lut-menu .lut-item')].map((item) => item.textContent);

    // Opened, the list has the folder's LUTs; the arrow keys go down it, each look shown as it is reached.
    await page.wait(300);
    page.click('field-look');
    const offered = listed();
    const search = document.querySelector<HTMLInputElement>('#video-fields .lut-menu input')!;
    const press = (key: string, on: HTMLElement = search) => on.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    press('ArrowDown');
    await page.until(near([55, 205, 235]), 'the picture to be inverted');
    press('ArrowDown');
    await page.until(near([20, 50, 200]), 'the picture to be swapped');
    // Escape goes back to the one there was.
    press('Escape');
    await page.until(near([200, 50, 20]), 'the picture to be as it was');
    const afterEscape = page.element('field-look').dataset.value;
    // Closed, the arrow keys step through it as well.
    press('ArrowDown', page.element('field-look'));
    await page.until(near([55, 205, 235]), 'the picture to be inverted again');
    const stepped = page.element('field-look').dataset.value;

    // The LUTs that come with the app follow the folder's: a black and white one turns the red grey.
    page.click('field-look');
    [...document.querySelectorAll<HTMLButtonElement>('#video-fields .lut-item')].find((item) => item.textContent === 'Noir')!.click();
    await page.until(() => { const [r, g, b] = middle(); return r === g && g === b && r < 150; }, 'the picture to be black and white');
    const builtin = page.element('field-look').dataset.value;
    page.click('field-look');
    [...document.querySelectorAll<HTMLButtonElement>('#video-fields .lut-item')].find((item) => item.textContent === 'Film/Invert')!.click();
    await page.until(near([55, 205, 235]), 'the picture to be inverted once more');

    // In the editor: chosen from the folder, it is named, not kept.
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    page.click('editor-add');
    document.querySelector<HTMLButtonElement>('#editor-add-menu button[data-type="lut"]')!.click();
    await page.wait(100);
    page.click('setting-lut');
    [...document.querySelectorAll<HTMLButtonElement>('#editor-layer .lut-item')].find((item) => item.textContent === 'Swap')!.click();
    await page.until(near([235, 205, 55]), 'the picture to be inverted and swapped');
    const layer = page.element('setting-lut').dataset.value;
    await page.wait(600);
    page.click('editor-done');
    await page.wait(200);
    // Its message can be replaced at once by how far listening to the recording has got; the test waits for the file instead.
    page.click('template-export');

    // A file put in the folder meanwhile (the test puts one there once the template is exported) is offered when the window is come back to.
    await page.until(() => {
      window.dispatchEvent(new Event('focus'));
      page.click('field-look');
      const now = listed();
      page.click('field-look');
      return now.includes('Later');
    }, 'the new LUT to be offered', 30_000);
    return { offered, afterEscape, stepped, builtin, layer };
  });
  const later = (async () => {
    for (let tries = 0; tries < 600; tries++) {
      if ((await readdir(shared)).length) return writeFile(join(folder, 'Later.cube'), cube((r, g, b) => [r, g, b]));
      await new Promise((done) => setTimeout(done, 100));
    }
  })();
  const seen = await running;
  await later;
  assert.deepEqual(seen.offered.slice(0, 6), ['None', 'LUT folder', 'Film/Invert', 'Swap', 'Looks', 'Teal & Orange']);
  assert.ok(seen.offered.includes('Kodak Portra 400'));
  assert.equal(seen.builtin, 'lutbuiltin:Noir');
  assert.equal(seen.afterEscape, '');
  assert.equal(seen.stepped, 'lutfolder:Film/Invert', 'for the mix, named by where it is in the folder');
  assert.equal(seen.layer, 'lutfolder:Swap');

  // The template of the user's own names the folder's LUT and keeps none.
  const [stored] = await readdir(join(data, 'templates'));
  const saved = JSON.parse(readFileSync(join(data, 'templates', stored), 'utf8'));
  assert.equal(saved.luts, undefined);
  assert.ok(saved.layers.some((layer: { params: { lut?: string } }) => layer.params.lut === 'lutfolder:Swap'));
  // The file to share keeps it.
  const exported = join(shared, 'Folder looks.djmtemplate');
  const items = await readZip(exported);
  const json = JSON.parse((await readZipEntry(exported, items[0])).toString('utf8'));
  assert.deepEqual(Object.keys(json.luts), ['Swap']);
  assert.ok(json.layers.some((layer: { params: { lut?: string } }) => layer.params.lut === 'lut:Swap'));
});

test('a white balance warms a grey picture without making it lighter', { skip }, async () => {
  const file = join(work, 'Warm.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 2, name: 'Warm', fields: [],
    layers: [
      { type: 'solid', params: { colour: '#808080' } },
      { type: 'whiteBalance', params: { temperature: 1, tint: 0.5 } },
    ],
  }));
  const data = await dataFolder(work, analysed);
  const seen = await runApp({ recording: mix, data, template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Warm', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const middle = () => [...picture.getContext('2d')!.getImageData(picture.width / 2, picture.height / 2, 1, 1).data].slice(0, 3);
    await page.until(() => middle()[0] > 140, 'the picture to be warmed');
    return middle();
  });
  const want = whiteBalance(1, 0.5).map((gain) => 128 * gain);
  seen.forEach((value, i) => assert.ok(Math.abs(value - want[i]) <= 2, `drawn ${seen}, should be about ${want.map(Math.round)}`));
});
