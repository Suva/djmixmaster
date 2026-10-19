import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displacementAt, type Displacement } from '../src/visuals/displace.ts';

const base: Displacement = {
  mode: 'noise', amount: 20, twist: Math.PI, size: 100, radius: 200, direction: 0, time: 0.3,
  noise: { kind: 'clouds', detail: 3, roughness: 0.5, warp: 0, seed: 0 },
};
const at = (x: number, y: number, more: Partial<Displacement>) => displacementAt(x, y, 0, 0, { ...base, ...more });
const points = Array.from({ length: 400 }, (_, i) => [((i * 7919) % 600) - 300, ((i * 104729) % 600) - 300]);

test('noise and waves move no further than the amount; waves only sideways to their way', () => {
  for (const [x, y] of points) {
    const [nx, ny] = at(x, y, { mode: 'noise' });
    assert.ok(Math.abs(nx) <= 20 && Math.abs(ny) <= 20);
    const [wx, wy] = at(x, y, { mode: 'waves', direction: Math.PI / 2 });
    assert.ok(Math.abs(wx) <= 20 + 1e-9 && Math.abs(wy) < 1e-9, 'waves travelling down move across');
  }
});

test('ripples, a swirl and a bulge reach no further than their radius', () => {
  for (const mode of ['ripples', 'swirl', 'bulge']) {
    for (const [x, y] of [[210, 0], [0, -250], [150, 150]]) assert.deepEqual(at(x, y, { mode }).map((v) => Math.abs(v) < 1e-9), [true, true], `${mode} at ${x}, ${y}`);
  }
});

test('a swirl turns about the middle, most at the middle', () => {
  for (const [x, y] of points) {
    const [dx, dy] = at(x, y, { mode: 'swirl' });
    assert.ok(Math.abs(Math.hypot(x + dx, y + dy) - Math.hypot(x, y)) < 1e-6, 'read from as far from the middle');
  }
  const turned = (r: number) => { const [dx, dy] = at(r, 0, { mode: 'swirl' }); return Math.atan2(dy, r + dx); };
  assert.ok(turned(10) > turned(100) && turned(100) > turned(190));
});

test('a bulge or a pinch never folds the picture over itself, however large the amount', () => {
  for (const amount of [20, 500, -20, -500]) {
    let last = -Infinity;
    for (let r = 0.5; r < 200; r += 0.5) {
      const [dx] = at(r, 0, { mode: 'bulge', amount });
      assert.ok(r + dx > last, `amount ${amount}: read from ${r + dx} at ${r}, after ${last}`);
      last = r + dx;
    }
  }
  const [inward] = at(100, 0, { mode: 'bulge', amount: 20 });
  assert.ok(inward < 0, 'a bulge reads from nearer the middle, so what is there looks larger');
});

test('held, the edges stay where they are and nothing is read from past them', () => {
  const hold = { width: 640, height: 360, margin: 60 };
  for (const mode of ['noise', 'waves', 'ripples', 'swirl', 'bulge']) {
    const d: Displacement = { ...base, mode, amount: 150, radius: 400, hold };
    for (let i = 0; i < 2000; i++) {
      const [x, y] = [((i * 7919) % 6400) / 10, ((i * 104729) % 3600) / 10];
      const [dx, dy] = displacementAt(x, y, 320, 180, d);
      assert.ok(x + dx >= 0.5 && x + dx <= 639.5 && y + dy >= 0.5 && y + dy <= 359.5, `${mode} at ${x}, ${y} reads from ${x + dx}, ${y + dy}`);
    }
    for (const [x, y] of [[0.5, 100], [639.5, 200], [300, 0.5], [50, 359.5]]) {
      const [dx, dy] = displacementAt(x, y, 320, 180, d);
      assert.ok(Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9, `${mode} moves the very edge at ${x}, ${y}`);
    }
  }
  // Well inside the margin, it moves as much as it would unheld.
  const inside = { ...base, mode: 'noise', hold };
  const [held, free] = [displacementAt(320, 180, 320, 180, inside), displacementAt(320, 180, 320, 180, base)];
  assert.ok(Math.abs(held[0] - free[0]) < 1e-9 && Math.abs(held[1] - free[1]) < 1e-9, `${held} against ${free}`);
});
