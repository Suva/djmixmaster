import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyAmount, type Key } from '../src/visuals/key.ts';

const green: Key = { kind: 'colour', colour: [0, 1, 0], tolerance: 0.3, softness: 0.2 };

test('a colour key takes away the key colour and what is within the tolerance, and fades back in over the softness', () => {
  assert.equal(keyAmount(0, 1, 0, green), 0);
  // A fifth of the way across the cube from the key: within the tolerance.
  const fifth = 0.2 * Math.sqrt(3) / Math.sqrt(2);
  assert.equal(keyAmount(fifth, 1, fifth, green), 0);
  // Two fifths: half way through the softness.
  const twoFifths = 0.4 * Math.sqrt(3) / Math.sqrt(2);
  assert.ok(Math.abs(keyAmount(twoFifths, 1, twoFifths, green) - 0.5) < 1e-9);
  assert.equal(keyAmount(1, 0, 1, green), 1, 'the furthest colour stays');
  assert.equal(keyAmount(1, 0, 0, green), 1);
});

test('with no softness the edge is sharp, and nothing divides by zero', () => {
  const sharp = { ...green, softness: 0 };
  assert.equal(keyAmount(0.1, 1, 0.1, sharp), 0);
  assert.equal(keyAmount(1, 0, 0, sharp), 1);
  for (let v = 0; v <= 1; v += 0.01) assert.ok(Number.isFinite(keyAmount(v, 1, v, sharp)));
});

test('a dark key goes by brightness, whatever the key colour', () => {
  const dark: Key = { kind: 'dark', colour: [0, 1, 0], tolerance: 0.1, softness: 0.4 };
  assert.equal(keyAmount(0, 0, 0, dark), 0);
  assert.equal(keyAmount(0, 1, 0, dark), 1, 'bright green stays');
  assert.ok(Math.abs(keyAmount(0.3, 0.3, 0.3, dark) - 0.5) < 1e-9);
  assert.equal(keyAmount(1, 1, 1, dark), 1);
});
