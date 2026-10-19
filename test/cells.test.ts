import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fewer, hexagonAt, hexCells, hexColour, hexRadius, squareCells, triangleAt, triangleCells, type Region } from '../src/visuals/cells.ts';

const region: Region = [-100, -60, 100, 60];

test('squares cover the region, their corners on the lines through the origin', () => {
  const cells = squareCells(10, 3, -2, region);
  assert.ok(cells.some((c) => c.x === 8 && c.y === 3), 'the cell from the origin along');
  for (const [x, y] of [[-99, -59], [0, 0], [99, 59]]) {
    assert.ok(cells.some((c) => Math.abs(c.x - x) <= 5 && Math.abs(c.y - y) <= 5), `${x}, ${y} is in a cell`);
  }
});

test('hexagons tile without gaps, and neighbours never share a colour', () => {
  const s = 12;
  const cells = hexCells(s, 0, 0, region);
  for (const a of cells) {
    for (const b of cells) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 0 && d < s * 1.01) assert.notEqual(hexColour(a), hexColour(b), `neighbours at ${a.x}, ${a.y} and ${b.x}, ${b.y}`);
    }
  }
  // Every point is within a hexagon's reach of some middle: no gaps.
  for (let i = 0; i < 500; i++) {
    const [x, y] = [((i * 7919) % 2000) / 10 - 100, ((i * 104729) % 1200) / 10 - 60];
    assert.ok(cells.some((c) => Math.hypot(c.x - x, c.y - y) <= hexRadius(s) + 1e-9), `${x}, ${y} is in a hexagon`);
  }
  const corners = hexagonAt(0, 0, 10);
  assert.equal(corners.length, 12);
  assert.ok(Math.abs(Math.min(...corners.filter((_, k) => k % 2 === 1)) + 10) < 1e-9, 'standing on a point: one corner straight up');
});

test('triangles point up and down by turns, and each middle is inside its triangle', () => {
  const s = 10;
  const cells = triangleCells(s, 0, 0, region);
  assert.ok(cells.some((c) => c.up) && cells.some((c) => !c.up));
  for (const cell of cells.slice(0, 50)) {
    const [ax, ay, bx, by, cx, cy] = triangleAt(cell, s);
    const sign = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
    const d = [sign(cell.x, cell.y, ax, ay, bx, by), sign(cell.x, cell.y, bx, by, cx, cy), sign(cell.x, cell.y, cx, cy, ax, ay)];
    assert.ok(d.every((v) => v > 0) || d.every((v) => v < 0), `the middle of ${cell.i}, ${cell.j}`);
  }
});

test('fewer colours cuts a channel to so many levels', () => {
  assert.deepEqual([0, 0.2, 0.4, 0.6, 1].map((v) => fewer(v, 3)), [0, 0, 0.5, 0.5, 1]);
  assert.deepEqual([0, 1].map((v) => fewer(v, 2)), [0, 1]);
  assert.equal(fewer(1.4, 4), 1);
});
