import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayGain } from '../src/app/renderer/draw.ts';

/** Block peaks of a recording whose music peaks at `level`, with a stretch of silence and one loud click. */
function recording(level: number): Float32Array {
  const peaks = new Float32Array(10_000);
  for (let i = 0; i < 9_000; i++) peaks[i] = level * (0.5 + 0.5 * Math.abs(Math.sin(i / 7)));
  peaks[4_000] = 1;
  return peaks;
}

test('a quiet recording is drawn as large as a loud one, a loud one as it is', () => {
  assert.ok(Math.abs(displayGain(recording(0.25)) - 4) < 0.05, 'a recording peaking at -12 dB is drawn four times larger');
  assert.ok(displayGain(recording(1)) < 1.001);
  assert.equal(displayGain(recording(1.5)), 1, 'nothing is drawn smaller');
});

test('near silence is not blown up into noise', () => {
  assert.equal(displayGain(recording(0.001)), 16);
  assert.equal(displayGain(new Float32Array(100)), 1);
});
