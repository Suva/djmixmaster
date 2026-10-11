import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { encode, ffmpeg } from '../src/audio-io.ts';
import { checkup, type Examined } from '../src/checkup.ts';
import { RecordingExaminer } from '../src/diagnostics.ts';
import { DEFAULT_LEVEL_OPTIONS } from '../src/gain-curve.ts';
import { findGaps, soundBetween } from '../src/gaps.ts';
import { Limiter } from '../src/limiter.ts';
import { LowShelf } from '../src/shelf.ts';
import { isNewer } from '../src/version.ts';
import { BlockEnergyMeter, HOP_SECONDS, integratedLoudness, shortTermLoudness } from '../src/loudness.ts';
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
    restShortTerm: new Float32Array(n).fill(-13),
  } as Measurement;
  const step = (bassWeight: number) => {
    const { gainDb } = level(measured, { ...DEFAULT_LEVEL_OPTIONS, bassWeight });
    return gainDb[n - 1000] - gainDb[1000];
  };
  assert.ok(Math.abs(step(0)) < 0.01);
  assert.ok(Math.abs(step(0.5) - 2) < 0.1);
  assert.ok(Math.abs(step(1) - 4) < 0.1);
});

test('bass correction levels the bass and the rest separately', () => {
  // Two ten-minute tracks. Above the bass they are equally loud; the second has 4 dB less bass.
  const n = 12000;
  const half = (first: number, second: number) => Float32Array.from({ length: n }, (_, i) => (i < n / 2 ? first : second));
  const measured = { shortTerm: half(-10, -11), lowShortTerm: half(-14, -18), restShortTerm: half(-13, -13) } as Measurement;
  const run = (bassCorrection: number, maxBassDb: number) => {
    const { gainDb, bassDb } = level(measured, { ...DEFAULT_LEVEL_OPTIONS, bassCorrection, maxBassDb });
    return { gain: gainDb[n - 1000] - gainDb[1000], bass: bassDb[n - 1000] - bassDb[1000] };
  };
  // Off: the second track is simply turned up as a whole, bass still 3 dB short.
  assert.deepEqual(run(0, 6), { gain: 1, bass: 0 });
  // Fully on: nothing above the bass moves, and the bass alone closes the gap.
  assert.ok(Math.abs(run(1, 6).gain) < 0.05);
  assert.ok(Math.abs(run(1, 6).bass - 4) < 0.1);
  assert.ok(Math.abs(run(0.5, 6).bass - 2) < 0.1);
  assert.ok(Math.abs(run(1, 1).bass - 1) < 0.1, 'the cap bounds the change');
});

test('a hand adjustment raises its stretch and ramps at the edges', () => {
  const n = 12000;
  const flat = new Float32Array(n).fill(-10);
  const measured = { shortTerm: flat, lowShortTerm: flat, restShortTerm: flat } as Measurement;
  const { gainDb } = level(measured, DEFAULT_LEVEL_OPTIONS, undefined, [{ start: 4000, end: 8000, db: 2 }]);
  assert.ok(Math.abs(gainDb[6000] - 2) < 0.01, 'full change inside');
  assert.ok(Math.abs(gainDb[1000]) < 0.01 && Math.abs(gainDb[11000]) < 0.01, 'nothing outside');
  assert.ok(Math.abs(gainDb[4000] - 1) < 0.1, 'half way at the edge');
});

test('gaps are the long silences, not the pauses inside the music', () => {
  const second = 10;
  const blocks = new Float64Array(600 * second).fill(0.1);
  const silence = (from: number, to: number) => blocks.fill(1e-10, from * second, to * second);
  silence(0, 8); // before the music starts
  silence(100, 101.5); // the pause before a drop
  silence(200, 212); // between two sets
  silence(215, 220); // more silence after a few seconds of noise
  silence(590, 600); // after the music ends
  const gaps = findGaps(blocks).map((gap) => [Math.round(gap.start / second), Math.round(gap.end / second)]);
  assert.deepEqual(gaps, [[0, 8], [200, 220], [590, 600]]);
  const sets = soundBetween(findGaps(blocks), { start: 0, end: blocks.length });
  assert.deepEqual(sets.map((set) => [Math.round(set.start / second), Math.round(set.end / second)]), [[8, 200], [220, 590]]);
});

test('a hand adjustment to the bass moves the bass curve and leaves the gain alone', () => {
  const n = 12000;
  const flat = new Float32Array(n).fill(-10);
  const measured = { shortTerm: flat, lowShortTerm: flat, restShortTerm: flat } as Measurement;
  const { gainDb, bassDb } = level(measured, DEFAULT_LEVEL_OPTIONS, undefined, [
    { start: 4000, end: 8000, db: 3, bass: true },
    { start: 9000, end: 11000, db: -1 },
  ]);
  assert.ok(Math.abs(bassDb[6000] - 3) < 0.01 && Math.abs(gainDb[6000]) < 0.01, 'bass stretch');
  assert.ok(Math.abs(gainDb[10000] + 1) < 0.01 && Math.abs(bassDb[10000]) < 0.01, 'level stretch');
});

test('version numbers compare as numbers, and anything odd is never newer', () => {
  assert.ok(isNewer('0.4.0', '0.3.0'));
  assert.ok(isNewer('v0.10.0', '0.9.9'), 'ten is more than nine');
  assert.ok(isNewer('1.0.0', '0.99.99'));
  assert.ok(!isNewer('0.3.0', '0.3.0'));
  assert.ok(!isNewer('0.2.9', '0.3.0'));
  assert.ok(!isNewer('0.4.0-beta', '0.3.0'));
  assert.ok(!isNewer('<script>', '0.3.0'));
});

test('shelf moves the bass and leaves the highs', () => {
  const amplitude = (hz: number, gainDb: number) => {
    const shelf = new LowShelf(44100, 1);
    shelf.setGain(gainDb);
    const samples = Float32Array.from({ length: 44100 }, (_, f) => 0.25 * Math.sin((2 * Math.PI * hz * f) / 44100));
    shelf.process(samples, 0, samples.length);
    return 20 * Math.log10(samples.subarray(22050).reduce((a, b) => Math.max(a, Math.abs(b)), 0) / 0.25);
  };
  assert.ok(Math.abs(amplitude(50, 3) - 3) < 0.3);
  assert.ok(Math.abs(amplitude(50, -3) + 3) < 0.3);
  assert.ok(Math.abs(amplitude(3000, 3)) < 0.1);
  assert.ok(Math.abs(amplitude(50, 0)) < 0.001);
});

test('limiter holds the ceiling, keeps length and leaves quiet audio untouched', () => {
  const ceiling = Math.pow(10, -1 / 20);
  const input = new Float32Array(2 * 50000);
  for (let i = 0; i < input.length; i++) input[i] = 0.2 * Math.sin(i * 0.01);
  // A loud burst well below the top of the spectrum, where sample peaks and true peaks agree.
  for (let f = 20000; f < 20400; f++) input[f * 2] = 1.8 * Math.sin((2 * Math.PI * 1000 * f) / 44100);
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
  const burstPeak = parts.slice(2 * 20100, 2 * 20300).reduce((peak, x) => Math.max(peak, Math.abs(x)), 0);
  assert.ok(Math.abs(burstPeak - ceiling) < 0.01, 'peaks sit at the ceiling');
  for (let i = 0; i < 2 * 10000; i++) assert.ok(Math.abs(parts[i] - input[i]) < 1e-6);
});

test('limiter holds peaks that fall between the samples', () => {
  // A sine at a quarter of the sample rate, sampled 45 degrees off its crests:
  // every sample reads 3 dB below the waveform's real peak.
  const amplitude = 1.2;
  const frames = 20000;
  const input = new Float32Array(frames * 2);
  for (let f = 0; f < frames; f++) input[f * 2] = input[f * 2 + 1] = amplitude * Math.sin((Math.PI / 2) * f + Math.PI / 4);
  const ceiling = Math.pow(10, -1 / 20);
  assert.ok(amplitude * Math.SQRT1_2 < ceiling, 'no sample is over the ceiling');

  const limiter = new Limiter(44100, 2, -1);
  const output = [...limiter.process(input), ...limiter.flush()];
  // For this signal the true peak is the sample peak times the square root of two.
  const truePeak = output.slice(4000, -4000).reduce((peak, x) => Math.max(peak, Math.abs(x)), 0) * Math.SQRT2;
  assert.ok(truePeak <= ceiling * 1.012, `true peak ${truePeak} stays within 0.1 dB of the ceiling`);
  assert.ok(truePeak >= ceiling * 0.97, 'and is not pulled down further than needed');
});

/** Twelve seconds of stereo noise, the two sides related but not the same, shaped by `change`. */
function stereoNoise(change: (left: number, right: number, frame: number) => [number, number]): Float32Array {
  const rate = 48000;
  const samples = new Float32Array(rate * 12 * 2);
  let seed = 7;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  for (let f = 0; f < samples.length / 2; f++) {
    const a = noise();
    const b = noise();
    [samples[f * 2], samples[f * 2 + 1]] = change(0.3 * a, 0.3 * (0.6 * a + 0.8 * b), f);
  }
  return samples;
}

/** Runs samples through the same measuring the analysis pass does, without a file. */
function examine(samples: Float32Array, codec = 'pcm_s16le'): Examined {
  const meter = new BlockEnergyMeter(48000, 2);
  const examiner = new RecordingExaminer(48000);
  for (let at = 0; at < samples.length; at += 20000) {
    meter.push(samples.subarray(at, at + 20000));
    examiner.push(samples.subarray(at, at + 20000));
  }
  const blocks = meter.blocks();
  return {
    sampleRate: 48000,
    blocks,
    peaks: meter.peaks(),
    shortTerm: shortTermLoudness(blocks),
    integratedLufs: integratedLoudness(blocks),
    peak: meter.peak,
    diagnostics: examiner.finish(),
    source: { codec, channels: 'stereo', bitrateKbps: null, extension: 'wav' },
  };
}

const found = (samples: Float32Array) => checkup(examine(samples)).findings.map((finding) => finding.id);

test('check-up says nothing about a healthy recording', () => {
  const report = checkup(examine(stereoNoise((l, r) => [l, r])));
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.facts[0], ['Format', 'WAV, 16-bit']);
});

test('check-up finds clipping', () => {
  const clipped = stereoNoise((l, r) => [Math.max(-1, Math.min(1, l * 8)), Math.max(-1, Math.min(1, r * 8))]);
  const report = checkup(examine(clipped));
  assert.equal(report.findings[0].id, 'clipping');
  assert.equal(report.findings[0].kind, 'fault');
  // Loud but under full scale is not clipping.
  assert.deepEqual(found(stereoNoise((l, r) => [l * 2.2, r * 2.2])), []);
});

test('check-up finds the channel faults', () => {
  const quieter = checkup(examine(stereoNoise((l, r) => [l, r * 0.5]))).findings;
  assert.deepEqual(quieter.map((f) => f.id), ['quieter-channel']);
  assert.match(quieter[0].title, /right channel is 6\.0 dB quieter/);
  assert.deepEqual(found(stereoNoise((l) => [l, 0])), ['dead-channel']);
  assert.deepEqual(found(stereoNoise((l) => [l, l])), ['mono']);
  assert.deepEqual(found(stereoNoise((l) => [l, -l * 0.9 + 0.001])), ['out-of-phase']);
});

test('check-up tells a dropout from a pause in the music', () => {
  const gap = (fromSeconds: number, seconds: number) => (l: number, r: number, f: number): [number, number] =>
    f >= fromSeconds * 48000 && f < (fromSeconds + seconds) * 48000 ? [0, 0] : [l, r];
  assert.deepEqual(found(stereoNoise(gap(6, 0.02))), ['dropouts'], 'a 20 ms gap on its own');
  assert.deepEqual(found(stereoNoise(gap(6, 0.3))), [], 'a 300 ms pause');
  const stutter = stereoNoise((l, r, f) => {
    const t = f / 48000;
    return (t >= 6 && t < 6.02) || (t >= 6.3 && t < 6.32) ? [0, 0] : [l, r];
  });
  assert.deepEqual(found(stutter), [], 'two short gaps close together');
});

test('check-up notes a quiet recording', () => {
  assert.deepEqual(found(stereoNoise((l, r) => [l * 0.2, r * 0.2])), ['quiet']);
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

test('fades in and out at the ends without touching the middle', async () => {
  const input = join(dir, 'mix.wav');
  const output = join(dir, 'faded.wav');
  const region = { start: 20, end: 50 };
  const flat = new Float32Array(300);
  await render(input, region, flat, output, { ceilingDb: null, fadeInSeconds: 5, fadeOutSeconds: 10 });
  const plain = await measure(input, region);
  const faded = await measure(output);
  const change = (block: number) => 10 * Math.log10(faded.blocks[block] / plain.blocks[block]);
  assert.ok(change(0) < -40, 'starts from silence');
  assert.ok(Math.abs(change(25) + 6) < 0.6, 'half way up the fade in is 6 dB down');
  assert.ok(Math.abs(change(60)) < 0.1 && Math.abs(change(190)) < 0.1, 'the middle is untouched');
  assert.ok(Math.abs(change(250) + 6) < 0.6, 'half way down the fade out is 6 dB down');
  assert.ok(change(299) < -40, 'ends in silence');
});

test('check-up sees the edge a low bitrate leaves, also after conversion to a lossless file', async () => {
  const mp3 = join(dir, 'low.mp3');
  const wav = join(dir, 'from-mp3.wav');
  const encoder = encode(mp3, 48000, { bitrateKbps: 96 });
  await encoder.write(stereoNoise((l, r) => [l, r]));
  await encoder.close();
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-i', mp3, wav]);

  const asMp3 = checkup(await measure(mp3)).findings.find((f) => f.id === 'lossy');
  const asWav = checkup(await measure(wav)).findings.find((f) => f.id === 'lossy');
  assert.ok(asMp3, 'in the MP3 itself');
  assert.ok(asWav, 'in the WAV made from it');
  assert.match(asWav.detail, /This file is lossless, but the audio in it was not/);
});

test('trims to the region', async () => {
  const input = join(dir, 'mix.wav');
  const measured = await measure(input, { start: 30, end: 90.5 });
  assert.equal(measured.blocks.length, Math.round(60.5 / HOP_SECONDS));
  assert.equal(measured.sampleRate, SAMPLE_RATE);
});
