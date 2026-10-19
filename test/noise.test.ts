import assert from 'node:assert/strict';
import { test } from 'node:test';
import { covered, gradientNoise, NOISE_KINDS, noiseValue } from '../src/visuals/noise.ts';

const options = (kind: string, more = {}) => ({ kind, detail: 5, roughness: 0.5, warp: 0, seed: 0, ...more });

test('every kind of noise stays within 0 to 1, and is not flat', () => {
  for (const kind of NOISE_KINDS) {
    for (const warp of [0, 0.8]) {
      let [low, high] = [Infinity, -Infinity];
      for (let i = 0; i < 2000; i++) {
        const v = noiseValue(((i * 7919) % 400) / 37 - 5, ((i * 104729) % 300) / 29 - 5, i / 300, options(kind, { warp }));
        assert.ok(v >= 0 && v <= 1, `${kind} gave ${v}`);
        [low, high] = [Math.min(low, v), Math.max(high, v)];
      }
      assert.ok(high - low > 0.5, `${kind} spans ${low} to ${high}`);
    }
  }
});

test('the same place, moment and seed give the same value; another seed, another pattern', () => {
  const at = (seed: number) => noiseValue(1.3, -2.7, 0.4, options('clouds', { seed }));
  assert.equal(at(4), at(4));
  assert.notEqual(at(4), at(5));
  // Gradient noise is 0 on the whole numbers and moves smoothly between them.
  assert.equal(gradientNoise(3, -2, 1, 0), 0);
  assert.ok(Math.abs(gradientNoise(0.5, 0.5, 0.5, 0) - gradientNoise(0.501, 0.5, 0.5, 0)) < 0.01);
});

test('coverage cuts the pattern down to patches, softness says how softly', () => {
  assert.equal(covered(0.3, 1, 1), 0.3, 'coverage and softness at 1 leave it as it is');
  assert.equal(covered(0.4, 0.5, 1), 0, 'below the half not covered');
  assert.equal(covered(0.75, 0.5, 1), 0.5);
  assert.equal(covered(0.55, 0.5, 0.1), 1, 'a hard edge reaches all at once');
});
