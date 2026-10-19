// Tests of layers used as masks, in the window: by shape and by brightness,
// inverted and feathered, and an effect changing only what its mask shows.
// See window.test.ts for how these run.

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

test('a layer used as a mask shows the layers above it in its group by its shape or its brightness, inverted, feathered, and masks effects', { skip }, async () => {
  // Red over black, through a circle in the middle 40% of the picture wide; each case shown while the field n is its number.
  const circle = (more: Record<string, unknown>) => ({ type: 'shape', params: { shape: 'ellipse', square: true, width: 40, mask: 'by its shape', ...more } });
  const red = { type: 'solid', params: { colour: '#ff0000' } };
  const file = join(work, 'Masks.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 3, name: 'Masks', fields: [{ key: 'n', label: 'Which', kind: 'number', default: 1, min: 1, max: 5 }],
    layers: [
      { type: 'solid', params: { colour: '#000000' } },
      { type: 'group', size: 2, params: { visible: 'n == 1' } }, circle({}), red,
      { type: 'group', size: 2, params: { visible: 'n == 2' } }, circle({ maskInvert: true }), red,
      { type: 'group', size: 2, params: { visible: 'n == 3' } },
      { type: 'gradient', params: { mask: 'by its brightness', kind: 'linear', angle: 0, colour1: '#000000', position1: 0, colour5: '#ffffff', position5: 1 } }, red,
      { type: 'group', size: 2, params: { visible: 'n == 4' } }, circle({ maskFeather: 6 }), red,
      // Not in a group: red beneath everything, and a hue turn above a circle at the top level, which turns only the circle green.
      { type: 'solid', params: { colour: '#ff0000', visible: 'n == 5' } },
      circle({ visible: 'n == 5' }),
      { type: 'hue', params: { hue: 120, visible: 'n == 5' } },
    ],
  }));
  const data = await dataFolder(work, analysed);
  const seen = await runApp({ recording: mix, data, template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Masks', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const [w, h] = [picture.width, picture.height];
    const r = 0.2 * w;
    const at = (x: number, y: number) => [...picture.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3);
    const places = () => ({ middle: at(w / 2, h / 2), corner: at(5, 5), inEdge: at(w / 2 + r - 4, h / 2), outEdge: at(w / 2 + r + 4, h / 2), left: at(w * 0.05, h / 2), right: at(w * 0.95, h / 2), half: at(w / 2, h * 0.2) });
    const field = page.element<HTMLInputElement>('field-n');
    const cases = [];
    let before = '';
    for (let n = 1; n <= 5; n++) {
      field.value = String(n);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      let last = '';
      await page.until(() => {
        const now = JSON.stringify(places());
        const settled = now === last && now !== before;
        last = now;
        return settled;
      }, `case ${n} to be drawn`, 20_000);
      before = last;
      cases.push(places());
    }
    return cases;
  });
  const [shape, inverted, brightness, feathered, effect] = seen;
  assert.deepEqual([shape.middle, shape.inEdge, shape.outEdge, shape.corner], [[255, 0, 0], [255, 0, 0], [0, 0, 0], [0, 0, 0]], 'by its shape: red inside the circle only');
  assert.deepEqual([inverted.middle, inverted.outEdge, inverted.corner], [[0, 0, 0], [255, 0, 0], [255, 0, 0]], 'inverted: red outside it only');
  // The gradient reaches past the picture's sides, so it is not quite black or white at its edges.
  assert.ok(brightness.left[0] < 40 && brightness.right[0] > 180 && brightness.left[0] < brightness.middle[0] && brightness.middle[0] < brightness.right[0],
    `by its brightness: darker to the left, redder to the right: ${brightness.left}, ${brightness.middle}, ${brightness.right}`);
  assert.ok(Math.abs(brightness.half[0] - brightness.middle[0]) < 3 && brightness.middle[0] > 60 && brightness.middle[0] < 200, `partly in the middle: ${brightness.middle}`);
  assert.deepEqual(feathered.middle, [255, 0, 0]);
  assert.ok(feathered.inEdge[0] > 20 && feathered.inEdge[0] < 250 && feathered.outEdge[0] > 0 && feathered.outEdge[0] < feathered.inEdge[0], `feathered: soft at the edge, ${feathered.inEdge} inside and ${feathered.outEdge} outside`);
  // The canvas's hue turn takes pure red to a darker green.
  assert.ok(effect.middle[1] > 80 && effect.middle[0] < 50, `the hue turned inside the mask: ${effect.middle}`);
  assert.deepEqual(effect.corner, [255, 0, 0], 'and not outside it');
});

test('in the list of layers, a mask is marked and the layers it shows through are bracketed', { skip }, async () => {
  const file = join(work, 'Marked.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 3, name: 'Marked', fields: [],
    layers: [
      { type: 'solid', name: 'Under', params: { colour: '#000000' } },
      { type: 'group', name: 'Masked group', size: 3, params: {} },
      { type: 'solid', name: 'Below the mask', params: { colour: '#0000ff' } },
      { type: 'shape', name: 'The mask', params: { shape: 'ellipse', mask: 'by its shape' } },
      { type: 'solid', name: 'Through it', params: { colour: '#ff0000' } },
    ],
  }));
  const data = await dataFolder(work, analysed);
  const seen = await runApp({ recording: mix, data, template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Marked', 'the template to be added');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    return [...document.querySelectorAll<HTMLElement>('.layer-row')].map((row) => [
      row.querySelector('.layer-name')!.textContent, row.querySelector('.layer-mask') !== null, row.classList.contains('masked'),
    ]);
  });
  assert.deepEqual(seen, [
    ['Masked group', false, false],
    ['Through it', false, true],
    ['The mask', true, false],
    ['Below the mask', false, false],
    ['Under', false, false],
  ]);
});
