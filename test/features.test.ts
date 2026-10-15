import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BAND_COUNT, FEATURE_RATE, FeatureExtractor, HIGHEST_HZ, LOWEST_HZ } from '../src/features.ts';
import { listen } from '../src/master.ts';
import { BREAKDOWN, TRACK_LEVELS_DB, TRACK_SECONDS, writeSyntheticMix } from './synthetic-mix.ts';

let dir: string;
let mix: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'djmaster-features-'));
  mix = join(dir, 'mix.wav');
  await writeSyntheticMix(mix);
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('the spectrum finds a tone in its band, thirty times a second', () => {
  const sampleRate = 48000;
  const seconds = 2;
  const extractor = new FeatureExtractor(sampleRate);
  const chunk = new Float32Array(sampleRate * seconds * 2);
  for (let i = 0; i < chunk.length / 2; i++) chunk[2 * i] = chunk[2 * i + 1] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
  extractor.push(chunk);
  const features = extractor.finish();
  assert.equal(features.level.length, seconds * FEATURE_RATE);
  assert.equal(features.bands.length, seconds * FEATURE_RATE * BAND_COUNT);
  const middle = features.bands.subarray(FEATURE_RATE * BAND_COUNT, (FEATURE_RATE + 1) * BAND_COUNT);
  const loudest = middle.indexOf(Math.max(...middle));
  const band = Math.floor((Math.log(1000 / LOWEST_HZ) / Math.log(HIGHEST_HZ / LOWEST_HZ)) * BAND_COUNT);
  assert.equal(loudest, band);
});

test('beats land on the kicks, and keep time through a breakdown', async () => {
  const features = await listen(mix);
  const beat = 0.48; // the synthetic mix's kick: 125 BPM
  const beats = Array.from(features.beats);
  assert.ok(Math.abs(beats.length - (TRACK_LEVELS_DB.length * TRACK_SECONDS) / beat) <= 3, `${beats.length} beats`);
  const intervals = beats.slice(1).map((time, i) => time - beats[i]);
  const steady = intervals.filter((interval) => Math.abs(interval - beat) < 0.015).length / intervals.length;
  assert.ok(steady > 0.97, `only ${(steady * 100).toFixed(0)}% of beats are 0.48 s apart`);
  // Where the kick plays, every beat is on it.
  const withKick = beats.filter((time) => {
    const inTrack = time % TRACK_SECONDS;
    return inTrack > 2 && inTrack < TRACK_SECONDS - 6 && (inTrack < BREAKDOWN.start || inTrack > BREAKDOWN.end + 2);
  });
  const onKick = withKick.filter((time) => Math.abs(time - Math.round(time / beat) * beat) < 0.02).length / withKick.length;
  assert.ok(onKick > 0.98, `only ${(onKick * 100).toFixed(0)}% of beats are on a kick`);
});
