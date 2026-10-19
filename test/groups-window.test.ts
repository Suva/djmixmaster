// Tests of groups moved, turned and sized as one, in the window: drawn
// moved, outlined round their layers, and a layer in a turned group dragged
// the way the pointer goes. See window.test.ts for how these run.

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

test('a group moves, turns and sizes its layers as one, is outlined round them, and a layer in it is dragged the way the pointer goes', { skip }, async () => {
  // A red square a tenth of the picture wide, in the middle of a group moved across; and one right of the middle of a group turned a quarter and doubled.
  const square = (name: string, x: number) => ({ type: 'shape', name, params: { shape: 'rectangle', square: true, width: 10, x, ...{ colour1: '#ff0000', position1: 0, colour5: '' } } });
  const file = join(work, 'Groups.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 3, name: 'Groups', fields: [{ key: 'n', label: 'Which', kind: 'number', default: 1, min: 1, max: 2 }],
    layers: [
      { type: 'solid', params: { colour: '#000000' } },
      { type: 'group', name: 'Moved', size: 1, params: { visible: 'n == 1', x: 70 } }, square('Square', 50),
      { type: 'group', name: 'Turned', size: 1, params: { visible: 'n == 2', rotation: 90, scale: 200 } }, square('Inner', 60),
    ],
  }));
  const data = await dataFolder(work, analysed);
  const seen = await runApp({ recording: mix, data, template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Groups', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const [w, h] = [picture.width, picture.height];
    const at = (x: number, y: number) => picture.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[0];
    await page.until(() => at(0.7 * w, h / 2) > 200, 'the moved group to be drawn');
    const moved = { there: at(0.7 * w, h / 2), middle: at(w / 2, h / 2) };
    const field = page.element<HTMLInputElement>('field-n');
    field.value = '2';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    // A tenth of the width right of the middle, turned a quarter and doubled: a fifth of the width below it, twice the size.
    await page.until(() => at(w / 2, h / 2 + 0.2 * w) > 200, 'the turned group to be drawn');
    const turned = { there: at(w / 2, h / 2 + 0.2 * w), edge: at(w / 2 + 0.09 * w, h / 2 + 0.2 * w), right: at(0.6 * w, h / 2) };

    // In the editor: the turned group's layer, dragged right on the picture, moves up in its group, which shows as right.
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const pick = (name: string) => {
      const row = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === name)!;
      row.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: row.getBoundingClientRect().top + 5, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };
    const value = (key: string) => Number(document.querySelector<HTMLInputElement>(`#editor-layer .setting[data-key="${key}"] input[type="number"]`)!.value.replace(',', '.'));
    const drag = (target: Element, x: number, y: number, dx: number, dy: number) => {
      target.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + dx / 4, clientY: y + dy / 4 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + dx, clientY: y + dy }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };
    const outline = () => document.querySelector<HTMLElement>('.layer-outline')!;
    // The group itself has an outline round its square, and drags as one.
    pick('Turned');
    await page.until(() => !outline().hidden && outline().getBoundingClientRect().width > 0, "the group's outline");
    await page.wait(400);
    const shown = page.element('picture').getBoundingClientRect();
    const box = outline().getBoundingClientRect();
    const groupBox = { width: box.width / shown.width, height: box.height / shown.height };
    drag(outline(), box.left + box.width / 2, box.top + box.height / 2, shown.width / 10, 0);
    await page.wait(100);
    const groupX = value('x');
    await page.wait(1100);
    page.click('undo');
    await page.wait(200);
    pick('Inner');
    await page.until(() => document.querySelector('#editor-layer-title')?.textContent === 'Inner', 'the layer to be selected');
    const inner = outline().getBoundingClientRect();
    drag(outline(), inner.left + inner.width / 2, inner.top + inner.height / 2, shown.width / 10, 0);
    await page.wait(100);
    const dragged = { x: value('x'), y: value('y') };
    page.click('editor-done');
    return { moved, turned, groupBox, groupX, dragged };
  });
  assert.ok(seen.moved.there > 200 && seen.moved.middle < 30, `moved across: ${JSON.stringify(seen.moved)}`);
  assert.ok(seen.turned.there > 200 && seen.turned.edge > 200 && seen.turned.right < 30, `turned and doubled: ${JSON.stringify(seen.turned)}`);
  // The square is a tenth of the width, doubled; the outline is round it, not round the picture.
  assert.ok(Math.abs(seen.groupBox.width - 0.2) < 0.03, `the group's outline is round its layers: ${JSON.stringify(seen.groupBox)}`);
  assert.ok(Math.abs(seen.groupX - 60) < 1, `the group dragged a tenth across: ${seen.groupX}`);
  assert.ok(Math.abs(seen.dragged.x - 60) < 0.5 && seen.dragged.y < 45, `dragged right, the layer moved up in its turned group: ${JSON.stringify(seen.dragged)}`);
});
