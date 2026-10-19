// Tests of the layers drawn on the graphics card (noise, displace, gradient
// map): that the window draws what the processor works out. And the gradient
// map's stop bar in the editor. See window.test.ts for how these run.

import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { NOISE_KINDS, noiseValue } from '../src/visuals/noise.ts';
import { DISPLACE_MODES, displacementAt } from '../src/visuals/displace.ts';
import { gradientMapTable } from '../src/visuals/gradient-map.ts';
import { parseHex } from '../src/visuals/colour.ts';
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

test('every kind of noise is drawn in the window as the processor works it out', { skip }, async () => {
  // One noise layer per kind, each shown while the field n is its number; black to white, so red is the value.
  const file = join(work, 'Noise.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 2, name: 'Noise', fields: [{ key: 'n', label: 'Which', kind: 'number', default: 0, min: 0, max: 10 }],
    layers: NOISE_KINDS.map((kind, i) => ({
      type: 'noise',
      params: { kind, visible: `n == ${i}`, seed: 7, warp: i === 0 ? 0.5 : 0, colour1: '#000000', colour2: '#ffffff', size: 20, rotation: 30 },
    })),
  }));
  const data = await dataFolder(work, analysed);
  const seen = await runApp({ recording: mix, data, template: file, timeoutMs: 90_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Noise', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const field = page.element<HTMLInputElement>('field-n');
    const places = [[0.1, 0.1], [0.3, 0.8], [0.5, 0.5], [0.85, 0.2], [0.95, 0.95]];
    const read = () => {
      const ctx = picture.getContext('2d')!;
      return places.map(([x, y]) => ctx.getImageData(Math.floor(picture.width * x), Math.floor(picture.height * y), 1, 1).data[0]);
    };
    const kinds: number[][] = [];
    for (let i = 0; i < 7; i++) {
      // The picture is drawn again a moment after the field changes, later while the computer is busy:
      // read once it shows something other than the kind before, and holds still.
      const before = kinds[i - 1]?.join() ?? '';
      field.value = String(i);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      let last = '';
      await page.until(() => {
        const now = read().join();
        const settled = now === last && now !== before;
        last = now;
        return settled;
      }, `kind ${i} to be drawn`, 20_000);
      kinds.push(read());
    }
    return { width: picture.width, height: picture.height, kinds, places };
  });
  // At the mix's start, before anything has evolved or drifted.
  const greys = gradientMapTable([{ colour: parseHex('#000000')!, position: 0 }, { colour: parseHex('#ffffff')!, position: 1 }], { shift: 0, hueShift: 0, low: 0, high: 1 })!;
  const size = 0.2 * Math.min(seen.width, seen.height);
  const turn = (30 * Math.PI) / 180;
  seen.kinds.forEach((drawn, i) => {
    const want = seen.places.map(([x, y]) => {
      const vx = Math.floor(seen.width * x) + 0.5 - seen.width / 2;
      const vy = Math.floor(seen.height * y) + 0.5 - seen.height / 2;
      const px = (Math.cos(turn) * vx + Math.sin(turn) * vy) / size;
      const py = (-Math.sin(turn) * vx + Math.cos(turn) * vy) / size;
      // Black to white, blended as the gradient blends: through its table, between its entries.
      const at = 255 * noiseValue(px, py, 0, { kind: NOISE_KINDS[i], detail: 5, roughness: 0.5, warp: i === 0 ? 0.5 : 0, seed: 7 });
      const k = Math.min(254, Math.floor(at));
      return Math.round(greys[k * 4] * (1 - (at - k)) + greys[(k + 1) * 4] * (at - k));
    });
    drawn.forEach((value, j) => assert.ok(Math.abs(value - want[j]) <= 2, `${NOISE_KINDS[i]}: drawn ${drawn}, worked out ${want}`));
  });
});

test('every mode of displace, and the edges held, move the picture as the processor works it out', { skip }, async () => {
  // Grey from black on the left to white on the right, the same all the way down: a pixel's grey tells which column it was read from.
  const modes: Record<string, Record<string, number | string>> = {
    noise: { amount: 10 },
    waves: { amount: 4, size: 20, direction: 90 },
    ripples: { amount: 12, size: 14, radius: 90 },
    swirl: { twist: 120, radius: 50 },
    bulge: { amount: 8, radius: 45 },
  };
  // And noise held at the edges, over a margin wide enough that every place checked is eased.
  const cases: [string, Record<string, number | string | boolean>][] = [
    ...DISPLACE_MODES.map((mode) => [mode, { mode, ...modes[mode] }] as [string, Record<string, number | string | boolean>]),
    ['noise, held', { mode: 'noise', amount: 30, hold: true, holdMargin: 50 }],
  ];
  const file = join(work, 'Displace.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 2, name: 'Displace', fields: [{ key: 'n', label: 'Which', kind: 'number', default: 0, min: 0, max: 10 }],
    layers: [
      { type: 'gradient', params: { kind: 'linear', angle: 0, colour1: '#000000', colour2: '#ffffff' } },
      ...cases.map(([, params], i) => ({ type: 'displace', params: { visible: `n == ${i + 1}`, ...params } })),
    ],
  }));
  const data = await dataFolder(work, analysed);
  const seen = await runApp({ recording: mix, data, template: file, timeoutMs: 90_000, given: cases.length }, async (page, count) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Displace', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const field = page.element<HTMLInputElement>('field-n');
    const places = [[0.3, 0.3], [0.42, 0.55], [0.6, 0.4], [0.55, 0.62], [0.7, 0.7], [0.35, 0.65]];
    const read = () => {
      const ctx = picture.getContext('2d')!;
      return places.map(([x, y]) => ctx.getImageData(Math.floor(picture.width * x), Math.floor(picture.height * y), 1, 1).data[0]);
    };
    // The grey of each column, undisplaced.
    await page.until(() => read()[0] > 0, 'the gradient to be drawn');
    const ctx = picture.getContext('2d')!;
    const row = [...ctx.getImageData(0, Math.floor(picture.height / 2), picture.width, 1).data].filter((_, i) => i % 4 === 0);
    const modes: number[][] = [];
    let before = read().join();
    for (let i = 1; i <= count; i++) {
      field.value = String(i);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      let last = '';
      await page.until(() => {
        const now = read().join();
        const settled = now === last && now !== before;
        last = now;
        return settled;
      }, `mode ${i} to be drawn`, 20_000);
      before = last;
      modes.push(read());
    }
    return { width: picture.width, height: picture.height, row, places, modes };
  });
  // The column whose grey this is, between the two it falls between.
  const columnOf = (grey: number) => {
    const x = seen.row.findIndex((v) => v >= grey);
    if (x <= 0) return Math.max(0, x);
    const [a, b] = [seen.row[x - 1], seen.row[x]];
    return x - 1 + (b > a ? (grey - a) / (b - a) : 0) + 0.5;
  };
  const unit = Math.min(seen.width, seen.height);
  cases.forEach(([name, s], i) => {
    const mode = String(s.mode);
    const d = {
      mode, amount: (Number(s.amount ?? 1) / 100) * unit, twist: (Number(s.twist ?? 90) * Math.PI) / 180,
      size: (Number(s.size ?? 20) / 100) * unit, radius: (Number(s.radius ?? 40) / 100) * unit, direction: (Number(s.direction ?? 0) * Math.PI) / 180,
      time: 0, noise: { kind: 'clouds', detail: 3, roughness: 0.5, warp: 0, seed: 0 },
      ...(s.hold ? { hold: { width: seen.width, height: seen.height, margin: (Number(s.holdMargin) / 100) * unit } } : {}),
    };
    seen.places.forEach(([px, py], j) => {
      const x = Math.floor(seen.width * px) + 0.5;
      const y = Math.floor(seen.height * py) + 0.5;
      const [dx] = displacementAt(x, y, seen.width / 2, seen.height / 2, d);
      const found = columnOf(seen.modes[i][j]);
      // The grey steps every few columns, so this is as near as it can be told.
      assert.ok(Math.abs(found - (x + dx)) <= 6, `${name} at ${px}, ${py}: read from column ${found.toFixed(1)}, worked out ${(x + dx).toFixed(1)}`);
    });
  });
});

test('a gradient map recolours each pixel by its brightness, as its table says', { skip }, async () => {
  // Grey from black to white beneath, then red in the shadows through to blue in the highlights.
  const file = join(work, 'Map.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 2, name: 'Map', fields: [{ key: 'n', label: 'Shown', kind: 'number', default: 0, min: 0, max: 1 }],
    layers: [
      { type: 'gradient', params: { kind: 'linear', angle: 0, colour1: '#000000', colour2: '#ffffff' } },
      { type: 'gradientMap', params: { visible: 'n == 1', colour1: '#ff0000', position1: 0.1, colour2: '', colour3: '#ffff00', position3: 0.5, colour4: '', colour5: '#0000ff', position5: 0.9, low: 0.1 } },
    ],
  }));
  const data = await dataFolder(work, analysed);
  const seen = await runApp({ recording: mix, data, template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Map', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const row = () => {
      const pixels = picture.getContext('2d')!.getImageData(0, Math.floor(picture.height / 2), picture.width, 1).data;
      return Array.from({ length: 9 }, (_, i) => [...pixels.slice(Math.floor(((i + 0.5) / 9) * picture.width) * 4, Math.floor(((i + 0.5) / 9) * picture.width) * 4 + 3)]);
    };
    await page.until(() => row()[8][0] > 200, 'the grey to be drawn');
    const grey = row();
    const field = page.element<HTMLInputElement>('field-n');
    field.value = '1';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await page.until(() => row()[8][2] > 200 && row()[8][0] < 50, 'the map to be drawn');
    await page.wait(200);
    return { grey, mapped: row() };
  });
  const table = gradientMapTable([
    { colour: parseHex('#ff0000')!, position: 0.1 }, { colour: parseHex('#ffff00')!, position: 0.5 }, { colour: parseHex('#0000ff')!, position: 0.9 },
  ], { shift: 0, hueShift: 0, low: 0.1, high: 1 })!;
  seen.grey.forEach(([g], i) => {
    const want = [...table.slice(g * 4, g * 4 + 3)];
    seen.mapped[i].forEach((v, c) => assert.ok(Math.abs(v - want[c]) <= 3, `grey ${g} became ${seen.mapped[i]}, should be ${want}`));
  });
});

test('a gradient map\'s stops are dragged, added and taken out on its bar, and undone', { skip }, async () => {
  const file = join(work, 'Stops.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 2, name: 'Stops', fields: [],
    layers: [
      { type: 'gradient', params: { kind: 'linear', angle: 0, colour1: '#000000', colour2: '#ffffff' } },
      { type: 'gradientMap', params: { colour1: '#ff0000', position1: 0, colour2: '', colour3: '', colour4: '', colour5: '#0000ff', position5: 1 } },
      { type: 'gradient', name: 'Moving', params: { colour1: '#ff0000', position1: 0, colour5: '#0000ff', position5: '0.5 + 0.5 * bass' } },
    ],
  }));
  const data = await dataFolder(work, analysed);
  const seen = await runApp({ recording: mix, data, template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Stops', 'the template to be added');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const row = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === 'Gradient map')!;
    row.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: row.getBoundingClientRect().top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await page.until(() => document.querySelector('.stop-track') !== null, 'the stop bar');
    const track = document.querySelector<HTMLElement>('.stop-track')!;
    const shown = () => [...document.querySelectorAll<HTMLElement>('.stop-marker')].filter((m) => !m.hidden).map((m) => Number(m.dataset.stop));
    const number = (key: string) => Number(document.querySelector<HTMLInputElement>(`#editor-layer .setting[data-key="${key}"] input[type="number"]`)!.value);
    const colour = (key: string) => document.querySelector(`#editor-layer .setting[data-key="${key}"] .colour-code`)!.textContent;
    const drag = (marker: HTMLElement, x: number, y: number) => {
      const box = marker.getBoundingClientRect();
      const [sx, sy] = [box.left + box.width / 2, box.top + box.height / 2];
      marker.dispatchEvent(new PointerEvent('pointerdown', { clientX: sx, clientY: sy, bubbles: true }));
      for (const part of [0.3, 0.7, 1]) window.dispatchEvent(new PointerEvent('pointermove', { clientX: sx + (x - sx) * part, clientY: sy + (y - sy) * part }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y }));
    };
    const marker = (n: number) => document.querySelector<HTMLElement>(`.stop-marker[data-stop="${n}"]`)!;
    const at = (f: number) => { const box = track.getBoundingClientRect(); return [box.left + box.width * f, box.top + box.height / 2]; };
    const first = shown();
    // Each stop's own settings are folded under the bar for a gradient that holds still.
    const folded = !document.querySelector<HTMLDetailsElement>('#editor-layer details.stop-settings')!.open;

    // Stop 1 dragged a quarter of the way along.
    drag(marker(1), at(0.25)[0], at(0.25)[1]);
    await page.wait(50);
    const dragged = number('position1');

    // A click on the bar adds the first stop not in use, there, in the colour the gradient has there.
    const [cx, cy] = at(0.6);
    track.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
    await page.wait(50);
    const added = { shown: shown(), at: number('position2'), colour: colour('colour2') };

    // Dragged well below the bar, it is taken out; undo puts it back.
    await page.wait(1100);
    drag(marker(2), at(0.6)[0], at(0.6)[1] + 80);
    await page.wait(50);
    const removed = { shown: shown(), colour: colour('colour2') };
    await page.wait(1100);
    page.click('undo');
    await page.wait(300);
    const back = shown();
    // A gradient with a stop that follows the music shows them unfolded.
    const moving = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === 'Moving')!;
    moving.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: moving.getBoundingClientRect().top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await page.until(() => document.querySelector('#editor-layer-title')?.textContent === 'Moving', 'the moving gradient to be selected');
    const unfolded = document.querySelector<HTMLDetailsElement>('#editor-layer details.stop-settings')!.open;
    page.click('editor-done');
    return { first, folded, dragged, added, removed, back, unfolded };
  });
  assert.deepEqual(seen.first, [1, 5]);
  assert.ok(seen.folded, 'each stop folded away for a gradient that holds still');
  assert.ok(seen.unfolded, 'and open where a stop follows the music');
  assert.ok(Math.abs(seen.dragged - 0.25) < 0.02, `dragged to ${seen.dragged}`);
  assert.deepEqual(seen.added.shown, [1, 2, 5]);
  assert.ok(Math.abs(seen.added.at - 0.6) < 0.02, `added at ${seen.added.at}`);
  assert.match(seen.added.colour ?? '', /^#[0-9a-f]{6}$/, `added in ${seen.added.colour}`);
  assert.deepEqual(seen.removed, { shown: [1, 5], colour: 'None' });
  assert.deepEqual(seen.back, [1, 2, 5]);
});
