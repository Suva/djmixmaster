import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lengthOf, rounded, shapeOutline } from '../src/visuals/outline.ts';
import { SHAPE_KINDS } from '../src/visuals/template.ts';

const options = { sides: 6, inner: 0.45, thickness: 0.3, rounding: 0 };

/** The box a contour reaches to: left, top, right, bottom. */
function bounds(contour: number[]): [number, number, number, number] {
  const xs = contour.filter((_, i) => i % 2 === 0);
  const ys = contour.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

test('every shape stays inside its box, centred on its position', () => {
  for (const shape of SHAPE_KINDS) {
    const contours = shapeOutline(shape, 200, 100, options);
    assert.ok(contours.length >= 1, shape);
    for (const contour of contours) {
      assert.ok(contour.length >= 6 && contour.every(Number.isFinite), `${shape} has points`);
      const [left, top, right, bottom] = bounds(contour);
      assert.ok(left >= -100.001 && right <= 100.001 && top >= -50.001 && bottom <= 50.001, `${shape} fits its box`);
    }
  }
});

test('a rectangle, an ellipse and a heart fill their box to its edges', () => {
  for (const shape of ['rectangle', 'ellipse', 'heart']) {
    const [left, top, right, bottom] = bounds(shapeOutline(shape, 200, 100, options)[0]);
    assert.ok(Math.abs(left + 100) < 0.5 && Math.abs(right - 100) < 0.5 && Math.abs(top + 50) < 0.5 && Math.abs(bottom - 50) < 0.5, shape);
  }
});

test('outlines are as long as they should be', () => {
  assert.equal(lengthOf(shapeOutline('rectangle', 200, 100, options)[0]), 600);
  const circle = lengthOf(shapeOutline('ellipse', 100, 100, options)[0]);
  assert.ok(Math.abs(circle - Math.PI * 100) < 0.1, `a circle 100 across goes round ${circle}`);
  // Rounded fully, a square is a circle.
  const round = lengthOf(shapeOutline('rectangle', 100, 100, { ...options, rounding: 0.5 })[0]);
  assert.ok(Math.abs(round - Math.PI * 100) < 0.5, `a square rounded by half goes round ${round}`);
});

test('a ring has a hole as wide as its band leaves, and a star its points', () => {
  const [outer, hole] = shapeOutline('ring', 100, 100, { ...options, thickness: 0.2 });
  assert.ok(hole, 'a ring has a hole');
  const [left, , right] = bounds(hole);
  assert.ok(Math.abs(right - left - 80) < 0.1, 'the band takes a fifth of the radius from each side');
  assert.ok(outer.length > 0);
  assert.equal(shapeOutline('ring', 100, 100, { ...options, thickness: 1 }).length, 1, 'a ring all band is a disc');
  assert.equal(shapeOutline('star', 100, 100, { ...options, sides: 5 })[0].length, 20, 'a five-pointed star has ten corners');
  assert.equal(shapeOutline('polygon', 100, 100, { ...options, sides: 2 })[0].length, 6, 'a polygon has at least three sides');
});

test('rounding never takes more than half a side', () => {
  const square = [-10, -10, 10, -10, 10, 10, -10, 10];
  const [left, top, right, bottom] = bounds(rounded(square, 1000));
  assert.ok(Math.abs(left + 10) < 0.01 && Math.abs(right - 10) < 0.01 && Math.abs(top + 10) < 0.01 && Math.abs(bottom - 10) < 0.01);
  assert.ok(Math.abs(lengthOf(rounded(square, 1000)) - Math.PI * 20) < 0.2, 'it becomes a circle, no larger');
  assert.deepEqual(rounded(square, 0), square);
});
