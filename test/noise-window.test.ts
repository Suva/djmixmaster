// Tests of noise and displace layers in the window: that the graphics card
// draws what the processor works out. See window.test.ts for how these run.

import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { NOISE_KINDS, noiseValue } from '../src/visuals/noise.ts';
import { DISPLACE_MODES, displacementAt } from '../src/visuals/displace.ts';
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
  const size = 0.2 * Math.min(seen.width, seen.height);
  const turn = (30 * Math.PI) / 180;
  seen.kinds.forEach((drawn, i) => {
    const want = seen.places.map(([x, y]) => {
      const vx = Math.floor(seen.width * x) + 0.5 - seen.width / 2;
      const vy = Math.floor(seen.height * y) + 0.5 - seen.height / 2;
      const px = (Math.cos(turn) * vx + Math.sin(turn) * vy) / size;
      const py = (-Math.sin(turn) * vx + Math.cos(turn) * vy) / size;
      return Math.round(255 * noiseValue(px, py, 0, { kind: NOISE_KINDS[i], detail: 5, roughness: 0.5, warp: i === 0 ? 0.5 : 0, seed: 7 }));
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
