import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHex, type Colour } from '../src/visuals/colour.ts';
import { gradientAt, gradientMapTable, stopsOf } from '../src/visuals/gradient-map.ts';

const hex = (text: string) => parseHex(text)!;
const near = (a: Colour, b: Colour) => ['r', 'g', 'b', 'a'].every((k) => Math.abs(a[k as keyof Colour] - b[k as keyof Colour]) < 1e-9);
const options = { shift: 0, hueShift: 0, low: 0, high: 1 };

test('the stops in use are those with a colour, in order along the gradient', () => {
  const colours = ['#ff0000', '', '#0000ff', '', '#00ff00'];
  const positions = [0.9, 0.5, 0.1, 0.3, 0.5];
  const stops = stopsOf((n) => (colours[n - 1] ? hex(colours[n - 1]) : null), (n) => positions[n - 1]);
  assert.deepEqual(stops.map((s) => s.position), [0.1, 0.5, 0.9]);
  assert.ok(near(stops[0].colour, hex('#0000ff')));
});

test('a gradient holds its end colours past its ends, and blends between stops', () => {
  const stops = [{ colour: hex('#000000'), position: 0.2 }, { colour: hex('#ffffff'), position: 0.8 }];
  assert.ok(near(gradientAt(stops, 0), hex('#000000')));
  assert.ok(near(gradientAt(stops, 1), hex('#ffffff')));
  assert.ok(Math.abs(gradientAt(stops, 0.5).r - 0.5) < 1e-9);
  // Fading to nothing keeps the colour rather than going through black.
  const fading = [{ colour: hex('#ff0000'), position: 0 }, { colour: hex('#00000000'), position: 1 }];
  const half = gradientAt(fading, 0.5);
  assert.ok(Math.abs(half.r - 1) < 1e-9 && Math.abs(half.a - 0.5) < 1e-9, `${JSON.stringify(half)}`);
});

test('the table maps brightness to the gradient, within the range given', () => {
  const stops = [{ colour: hex('#000000'), position: 0 }, { colour: hex('#ffffff'), position: 1 }];
  const plain = gradientMapTable(stops, options)!;
  for (const i of [0, 64, 128, 255]) assert.equal(plain[i * 4], i);
  const ranged = gradientMapTable(stops, { ...options, low: 0.25, high: 0.75 })!;
  assert.equal(ranged[50 * 4], 0, 'below the range, the first colour');
  assert.equal(ranged[200 * 4], 255, 'above it, the last');
  assert.ok(Math.abs(ranged[128 * 4] - 128) <= 2);
  assert.equal(gradientMapTable([], options), null, 'without stops, nothing to do');
});

test('shifting slides the colours along and back, without a jump', () => {
  const stops = [{ colour: hex('#000000'), position: 0 }, { colour: hex('#ffffff'), position: 1 }];
  for (const shift of [0.3, 0.9, 1.4, 7.25]) {
    const table = gradientMapTable(stops, { ...options, shift })!;
    for (let i = 1; i < 256; i++) assert.ok(Math.abs(table[i * 4] - table[(i - 1) * 4]) <= 2, `shift ${shift} jumps at ${i}`);
  }
  assert.equal(gradientMapTable(stops, { ...options, shift: 0.5 })![0], 128, 'black now shows the middle of the gradient');
});

test('a hue shift turns every colour', () => {
  const stops = [{ colour: hex('#ff0000'), position: 0 }, { colour: hex('#ff0000'), position: 1 }];
  const turned = gradientMapTable(stops, { ...options, hueShift: 120 })!;
  assert.ok(turned[1] > turned[0], `red turned towards green: ${[...turned.slice(0, 3)]}`);
});
