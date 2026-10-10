import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULT_LEVEL_OPTIONS } from '../src/gain-curve.ts';
import { Limiter } from '../src/limiter.ts';
import { BlockEnergyMeter, HOP_SECONDS, integratedLoudness } from '../src/loudness.ts';
import { level, measure, render, type Measurement } from '../src/master.ts';
import { BREAKDOWN, SAMPLE_RATE, TRACK_LEVELS_DB, TRACK_SECONDS, writeSyntheticMix } from './synthetic-mix.ts';

test('meter reads a full-scale-relative 1 kHz stereo sine per BS.1770', () => {
  const meter = new BlockEnergyMeter(48000, 2);
  const samples = new Float32Array(48000 * 2 * 5);
  for (let f = 0; f < samples.length / 2; f++) {
    samples[f * 2] = samples[f * 2 + 1] = 0.1 * Math.sin((2 * Math.PI * 1000 * f) / 48000);
  }
  meter.push(samples);
  // A 0 dBFS 1 kHz sine in both channels reads 0 LUFS, so -20 dBFS reads -20.
  assert.ok(Math.abs(integratedLoudness(meter.blocks()) + 20) < 0.1);
  assert.ok(Math.abs(meter.peak - 0.1) < 1e-4);
});

test('low band follows bass and ignores treble', () => {
  const level = (hz: number) => {
    const meter = new BlockEnergyMeter(44100, 1);
    meter.push(Float32Array.from({ length: 44100 }, (_, f) => 0.5 * Math.sin((2 * Math.PI * hz * f) / 44100)));
    return 10 * Math.log10(meter.lowBlocks()[5]);
  };
  assert.ok(Math.abs(level(50) - 10 * Math.log10(0.125)) < 0.2, 'bass passes at full level');
  assert.ok(level(50) - level(2000) > 60, 'treble is rejected');
});

test('bass weight shifts levelling from perceived loudness to bass level', () => {
  // Two ten-minute tracks, equally loud, the second with 4 dB less bass.
  const n = 12000;
  const measured = {
    shortTerm: new Float32Array(n).fill(-10),
    lowShortTerm: Float32Array.from({ length: n }, (_, i) => (i < n / 2 ? -14 : -18)),
  } as Measurement;
  const step = (bassWeight: number) => {
    const { gainDb } = level(measured, { ...DEFAULT_LEVEL_OPTIONS, bassWeight });
    return gainDb[n - 1000] - gainDb[1000];
  };
  assert.ok(Math.abs(step(0)) < 0.01);
  assert.ok(Math.abs(step(0.5) - 2) < 0.1);
  assert.ok(Math.abs(step(1) - 4) < 0.1);
});

test('limiter holds the ceiling, keeps length and leaves quiet audio untouched', () => {
  const ceiling = Math.pow(10, -1 / 20);
  const input = new Float32Array(2 * 50000);
  for (let i = 0; i < input.length; i++) input[i] = 0.2 * Math.sin(i * 0.01);
  for (let f = 20000; f < 20400; f++) input[f * 2] = f % 2 ? 1.8 : -1.8;
  input[2 * 49999] = 3; // a peak in the very last frame must survive the flush

  const limiter = new Limiter(44100, 2, -1);
  const parts: number[] = [];
  // Feed uneven chunk sizes, including one shorter than the look-ahead.
  for (const [from, to] of [[0, 100], [100, 30000], [30000, 100000]]) {
    parts.push(...limiter.process(input.slice(from, to)));
  }
  parts.push(...limiter.flush());

  assert.equal(parts.length, input.length);
  assert.ok(parts.every((x) => Math.abs(x) <= ceiling + 1e-6));
  assert.ok(Math.abs(Math.abs(parts[2 * 20100]) - ceiling) < 0.01, 'peaks sit at the ceiling');
  for (let i = 0; i < 2 * 10000; i++) assert.ok(Math.abs(parts[i] - input[i]) < 1e-6);
});

/** Median short-term loudness between two times, skipping a margin at both ends. */
function medianLoudness(measured: Measurement, fromSeconds: number, toSeconds: number, margin = 8): number {
  const values = Array.from(
    measured.shortTerm.subarray(
      Math.round((fromSeconds + margin) / HOP_SECONDS),
      Math.round((toSeconds - margin) / HOP_SECONDS),
    ),
  ).sort((a, b) => a - b);
  return values[values.length >> 1];
}

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'djmaster-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('levels tracks against each other and keeps the breakdowns down', async () => {
  const input = join(dir, 'mix.wav');
  const output = join(dir, 'mastered.wav');
  await writeSyntheticMix(input);

  const measured = await measure(input);
  const { gainDb } = level(measured, DEFAULT_LEVEL_OPTIONS);
  const result = await render(input, {}, gainDb, output, { ceilingDb: -1 });
  const reread = await measure(output);

  assert.equal(result.blocks.length, measured.blocks.length, 'length is preserved');
  assert.ok(result.peak <= Math.pow(10, -1 / 20) + 1e-6);
  assert.ok(Math.abs(reread.integratedLufs - result.integratedLufs) < 0.1, 'file matches what was reported');

  const tracks = TRACK_LEVELS_DB.map((_, t) => {
    const start = t * TRACK_SECONDS;
    const loud = (m: Measurement) => medianLoudness(m, start + BREAKDOWN.end, start + TRACK_SECONDS, 15);
    const quiet = (m: Measurement) => medianLoudness(m, start + BREAKDOWN.start, start + BREAKDOWN.end);
    return {
      loudBefore: loud(measured),
      loudAfter: loud(reread),
      dipBefore: loud(measured) - quiet(measured),
      dipAfter: loud(reread) - quiet(reread),
    };
  });
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

  assert.ok(spread(tracks.map((t) => t.loudBefore)) > 9, 'the test mix starts out uneven');
  assert.ok(spread(tracks.map((t) => t.loudAfter)) < 1, 'tracks end up at the same loudness');
  for (const track of tracks) {
    assert.ok(Math.abs(track.dipAfter - track.dipBefore) < 1.5, 'breakdowns keep their depth');
  }
});

test('trims to the region', async () => {
  const input = join(dir, 'mix.wav');
  const measured = await measure(input, { start: 30, end: 90.5 });
  assert.equal(measured.blocks.length, Math.round(60.5 / HOP_SECONDS));
  assert.equal(measured.sampleRate, SAMPLE_RATE);
});
