// Tests of the grid layer and the mosaic effect in the window: where lines
// and cells fall, and what colour a mosaic's cells take. See window.test.ts
// for how these run.

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

test('a grid\'s lines and a checkerboard\'s squares fall where their cells are, from the layer\'s position', { skip }, async () => {
  const file = join(work, 'Grids.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 3, name: 'Grids', fields: [{ key: 'n', label: 'Which', kind: 'number', default: 1, min: 1, max: 2 }],
    layers: [
      { type: 'solid', params: { colour: '#000000' } },
      { type: 'grid', params: { visible: 'n == 1', kind: 'lines', cell: 10, lineWidth: 0.6, lineColour: '#ffffff' } },
      { type: 'grid', params: { visible: 'n == 2', kind: 'checkerboard', cell: 10, lineWidth: 0, fill1: '#ff0000', fill2: '#0000ff' } },
    ],
  }));
  const data = await dataFolder(work, analysed);
  const seen = await runApp({ recording: mix, data, template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Grids', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const s = 0.1 * Math.min(picture.width, picture.height);
    const [cx, cy] = [picture.width / 2, picture.height / 2];
    const at = (x: number, y: number) => [...picture.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3);
    await page.until(() => at(cx, cy)[0] > 200, 'the lines to be drawn');
    const lines = { crossing: at(cx, cy), onLine: at(cx + s, cy + s / 2), between: at(cx + s / 2, cy + s / 2) };
    const field = page.element<HTMLInputElement>('field-n');
    field.value = '2';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await page.until(() => at(cx + s / 2, cy + s / 2)[0] > 200 && at(cx + s / 2, cy + s / 2)[1] < 50, 'the checkerboard to be drawn');
    const squares = [at(cx + s / 2, cy + s / 2), at(cx + 1.5 * s, cy + s / 2), at(cx + 1.5 * s, cy + 1.5 * s), at(cx - s / 2, cy + s / 2)];
    return { lines, squares };
  });
  assert.deepEqual(seen.lines.crossing, [255, 255, 255]);
  assert.ok(seen.lines.onLine[0] > 200, `on a line: ${seen.lines.onLine}`);
  assert.deepEqual(seen.lines.between, [0, 0, 0]);
  assert.deepEqual(seen.squares, [[255, 0, 0], [0, 0, 255], [255, 0, 0], [0, 0, 255]]);
});

test('a mosaic\'s cells each take the average colour beneath them, right up to the picture\'s edges', { skip }, async () => {
  // Grey from black on the left to white on the right beneath.
  const file = join(work, 'Mosaic.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 3, name: 'Mosaic', fields: [{ key: 'n', label: 'Which', kind: 'number', default: 0, min: 0, max: 2 }],
    layers: [
      { type: 'gradient', params: { kind: 'linear', angle: 0, colour1: '#000000', position1: 0, colour5: '#ffffff', position5: 1 } },
      { type: 'mosaic', params: { visible: 'n == 1', cells: 'squares', size: 10 } },
      { type: 'mosaic', params: { visible: 'n == 2', cells: 'hexagons', size: 7, gapColour: '#ff0000' } },
    ],
  }));
  const data = await dataFolder(work, analysed);
  const seen = await runApp({ recording: mix, data, template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Mosaic', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const s = 0.1 * Math.min(picture.width, picture.height);
    const [cx, cy] = [picture.width / 2, picture.height / 2];
    const row = () => [...picture.getContext('2d')!.getImageData(0, Math.floor(cy + s / 2), picture.width, 1).data].filter((_, i) => i % 4 === 0);
    await page.until(() => row()[picture.width - 1] > 200, 'the grey to be drawn');
    const grey = row();
    const field = page.element<HTMLInputElement>('field-n');
    const show = async (n: number, test: () => boolean) => {
      field.value = String(n);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await page.until(test, `mosaic ${n} to be drawn`);
      await page.wait(200);
    };
    // The cell from the layer's position to one cell along: every pixel across it the same, and the average of the grey there.
    await show(1, () => { const r = row(); return r[Math.floor(cx + 1)] === r[Math.floor(cx + s - 2)]; });
    const squares = row();
    const cell = squares.slice(Math.ceil(cx + 1), Math.floor(cx + s - 1));
    const under = grey.slice(Math.ceil(cx), Math.floor(cx + s));
    const average = under.reduce((a, b) => a + b, 0) / under.length;
    // Hexagons right up to the edges: the gap colour, red, nowhere along the borders.
    await show(2, () => [...picture.getContext('2d')!.getImageData(0, 0, picture.width, 1).data].some((v, i) => i % 4 === 0 && v > 0));
    const ctx = picture.getContext('2d')!;
    const border = [
      ...ctx.getImageData(0, 0, picture.width, 1).data, ...ctx.getImageData(0, picture.height - 1, picture.width, 1).data,
      ...ctx.getImageData(0, 0, 1, picture.height).data, ...ctx.getImageData(picture.width - 1, 0, 1, picture.height).data,
    ];
    const red = [];
    for (let i = 0; i < border.length; i += 4) if (border[i] > 200 && border[i + 1] < 40 && border[i + 2] < 40) red.push(i / 4);
    return { cell: [Math.min(...cell), Math.max(...cell)], average, red: red.length, width: picture.width };
  });
  assert.equal(seen.cell[0], seen.cell[1], `one colour across the cell: ${seen.cell}`);
  assert.ok(Math.abs(seen.cell[0] - seen.average) <= 4, `the cell is ${seen.cell[0]}, the grey under it averages ${seen.average}`);
  assert.equal(seen.red, 0, 'no gap showing at the edges');
});
