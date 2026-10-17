import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLIP, fillFrom, loudnessChangeDb, mixChannels, raise, then, UNMIXED } from '../src/channels.ts';

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a}, not ${b}`);

test('each fix mixes the two channels as it says', () => {
  const samples = () => Float32Array.from([0.5, 0.25, -0.2, 0.1]);
  const flipped = samples();
  mixChannels(flipped, FLIP);
  assert.deepEqual(flipped, Float32Array.from([0.5, -0.25, -0.2, -0.1]));
  const filled = samples();
  mixChannels(filled, fillFrom('right'));
  assert.deepEqual(filled, Float32Array.from([0.25, 0.25, 0.1, 0.1]));
  const raised = samples();
  mixChannels(raised, raise('right', 6.0206));
  close(raised[1], 0.5, 'the right doubled');
  close(raised[0], 0.5, 'the left as it was');
  // A flip and a rebalance together, as one.
  const both = then(FLIP, raise('right', 6.0206));
  close(both.rr, -2, 'flipped and doubled');
  assert.deepEqual(then(UNMIXED, FLIP), FLIP);
});

test('how much louder a fix makes a recording', () => {
  // One block each: energies of left, right, and their product.
  const silentLeft = loudnessChangeDb([0], [1], [0], fillFrom('right'));
  close(silentLeft, 10 * Math.log10(2), 'a silent side filled doubles the energy');
  close(loudnessChangeDb([1], [1], [-0.9], FLIP), 0, 'a flip changes nothing');
  // The right 6 dB down (a quarter of the energy) and raised to match: from 1.25 to 2.
  close(loudnessChangeDb([1], [0.25], [0.4], raise('right', 6.0206)), 10 * Math.log10(2 / 1.25), 'a rebalance adds what the raised side brings');
});
