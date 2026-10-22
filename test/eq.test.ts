import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BAND_EDGES_HZ, BANDS, BandMeter, BLOCKS_PER_BAND_FRAME } from '../src/bands.ts';
import { bandShares, bandSpectrum, checkedEq, coefficients, EqFilter, eqFilters, eqPower, FLAT_EQ, isFlat, withEq, type Eq } from '../src/eq.ts';
import { Rta } from '../src/app/renderer/rta.ts';
import { BlockEnergyMeter, HOP_SECONDS, integratedLoudness, shortTermLoudness } from '../src/loudness.ts';
import { BASS_SHELF_HZ, LowShelf } from '../src/shelf.ts';

const RATE = 44100;

/** Seconds of stereo sound, the same in both channels. */
function sound(seconds: number, at: (t: number) => number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE) * 2);
  for (let f = 0; f < samples.length / 2; f++) samples[f * 2] = samples[f * 2 + 1] = at(f / RATE);
  return samples;
}

const rms = (samples: Float32Array, from = 0) => {
  let sum = 0;
  for (let i = from; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length - from));
};

test('the band meter puts a tone in its band and keeps its energy', () => {
  const meter = new BandMeter(RATE);
  // 2.05 s: five measurements of four blocks, and a part of one left over.
  meter.push(sound(2.05, (t) => 0.5 * Math.sin(2 * Math.PI * 55 * t)));
  const bands = meter.bands();
  assert.equal(bands.length, 5 * BANDS);
  assert.equal(BLOCKS_PER_BAND_FRAME * HOP_SECONDS, 0.4);
  const frame = bands.subarray(2 * BANDS, 3 * BANDS);
  const total = frame.reduce((sum, e) => sum + e, 0);
  // Both channels at 0.5 peak: a mean square of 0.125 each.
  assert.ok(Math.abs(total - 0.25) < 0.005, `energy ${total}`);
  const band = BAND_EDGES_HZ.findIndex((edge) => edge > 55);
  assert.ok(frame[band] / total > 0.95, `55 Hz lands between ${BAND_EDGES_HZ[band - 1]} and ${BAND_EDGES_HZ[band]} Hz`);
});

test('a low shelf has the same coefficients as the bass correction\'s shelf', () => {
  const shelf = new LowShelf(RATE, 1);
  shelf.setGain(4);
  const impulse = new Float32Array(64);
  impulse[0] = 1;
  shelf.process(impulse, 0, 64);
  const ours = new EqFilter({ ...FLAT_EQ, lowDb: 4, lowHz: BASS_SHELF_HZ }, RATE, 1);
  const again = new Float32Array(64);
  again[0] = 1;
  ours.process(again);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(impulse[i] - again[i]) < 1e-6, `sample ${i}`);
});

test('the filters do what their response says, and a flat EQ does nothing', () => {
  const eq: Eq = { highPassHz: 40, lowDb: -3, lowHz: 120, lowMidDb: 2, lowMidHz: 400, highMidDb: -4, highMidHz: 2500, highDb: 5, highHz: 9000 };
  for (const hz of [25, 80, 400, 2500, 12000]) {
    const tone = sound(1, (t) => 0.3 * Math.sin(2 * Math.PI * hz * t));
    const filtered = tone.slice();
    new EqFilter(eq, RATE, 2).process(filtered);
    // Past the first half second, where the filters have settled.
    const heard = 20 * Math.log10(rms(filtered, RATE) / rms(tone, RATE));
    const said = 10 * Math.log10(eqPower(eq, hz, RATE));
    assert.ok(Math.abs(heard - said) < 0.05, `${hz} Hz: ${heard.toFixed(2)} dB, not ${said.toFixed(2)}`);
  }
  assert.ok(isFlat(FLAT_EQ) && isFlat(undefined) && !isFlat(eq));
  assert.ok(eqFilters({ ...FLAT_EQ, lowHz: 200 }).every((filter) => coefficients(filter, RATE) === null));
});

test('an EQ\'s effect on the loudness, the low band and the peaks is worked out from the bands', () => {
  // Noise over a bass line, a minute of it, getting louder and brighter halfway.
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const samples = sound(60, (t) => (t < 30 ? 0.1 : 0.2) * noise() + 0.3 * Math.sin(2 * Math.PI * 50 * t));
  const measure = (audio: Float32Array) => {
    const meter = new BlockEnergyMeter(RATE, 2);
    const bands = new BandMeter(RATE);
    for (let at = 0; at < audio.length; at += 8192) {
      meter.push(audio.subarray(at, at + 8192));
      bands.push(audio.subarray(at, at + 8192));
    }
    const blocks = meter.blocks();
    return {
      sampleRate: RATE, blocks, peaks: meter.peaks(), bands: bands.bands(), firstBlock: 0,
      shortTerm: shortTermLoudness(blocks), lowShortTerm: shortTermLoudness(meter.lowBlocks()), restShortTerm: shortTermLoudness(meter.restBlocks()),
    };
  };
  const before = measure(samples);
  assert.equal(withEq(before, undefined).blocks, before.blocks, 'no EQ, nothing worked out');
  for (const eq of [
    { ...FLAT_EQ, highDb: 6, highHz: 4000 },
    { ...FLAT_EQ, lowDb: -6, lowHz: 150, highPassHz: 40 },
    { ...FLAT_EQ, lowMidDb: 4, highMidDb: -5 },
  ]) {
    const filtered = samples.slice();
    new EqFilter(eq, RATE, 2).process(filtered);
    const actual = measure(filtered);
    const predicted = withEq(before, eq);
    const name = JSON.stringify(eq);
    const loudness = integratedLoudness(predicted.blocks) - integratedLoudness(actual.blocks);
    assert.ok(Math.abs(loudness) < 0.2, `${name}: integrated loudness off by ${loudness.toFixed(2)} dB`);
    // Away from the edges, where the short-term window runs out.
    for (const curve of ['shortTerm', 'lowShortTerm', 'restShortTerm'] as const) {
      for (const at of [100, 250, 350, 500]) {
        const off = predicted[curve][at] - actual[curve][at];
        assert.ok(Math.abs(off) < 0.5, `${name}: ${curve} at ${at * HOP_SECONDS} s off by ${off.toFixed(2)} dB`);
      }
    }
    // The peaks are an estimate. A cut is taken to leave them where they were, which errs high; a boost
    // can raise them a little more than it says, as on real music, and the limiter is there for that.
    const peaks = 20 * Math.log10(predicted.peaks[400] / actual.peaks[400]);
    assert.ok(peaks > -2 && peaks < 4, `${name}: peak off by ${peaks.toFixed(2)} dB`);
  }
});

test('an EQ read back from disk stays within its ranges, and the flat one is no EQ at all', () => {
  assert.equal(checkedEq(undefined), undefined);
  assert.equal(checkedEq('treble'), undefined);
  assert.equal(checkedEq({ ...FLAT_EQ }), undefined);
  assert.deepEqual(checkedEq({ highDb: 20, highHz: 50000, highPassHz: -5, lowMidDb: 'loud' }), { ...FLAT_EQ, highDb: 6, highHz: 16000 });
  // Moved frequencies are a choice worth keeping, even with nothing raised or lowered yet.
  assert.deepEqual(checkedEq({ ...FLAT_EQ, lowMidHz: 500 }), { ...FLAT_EQ, lowMidHz: 500 });
});

test('a mix\'s average spectrum is drawn per octave, as its EQ makes it sound', () => {
  // Pink noise: the same energy in every octave, so as much in each band as it is octaves wide.
  const edges = [15, ...BAND_EDGES_HZ, Math.min(20000, RATE * 0.45)];
  const pink = Float32Array.from({ length: BANDS }, (_, b) => Math.log2(edges[b + 1] / edges[b]));
  const bands = new Float32Array(BANDS * 10);
  for (let frame = 0; frame < 10; frame++) bands.set(pink, frame * BANDS);
  const shares = bandShares(bands, RATE, 0, 40, undefined)!;
  assert.ok(Math.abs(shares.reduce((sum, share) => sum + share, 0) - 1) < 1e-9, 'shares add up to all of it');
  const { hz, db } = bandSpectrum(shares, RATE);
  assert.ok(db.every((value) => Math.abs(value - db[0]) < 1e-4), `pink noise is flat: ${[...db].map((v) => v.toFixed(2))}`);
  assert.ok(hz.every((value, b) => value > edges[b] && value < edges[b + 1]), 'each point inside its band');
  // The treble raised: the top band gains on the rest by about what the shelf gives there.
  const bright = bandSpectrum(bandShares(bands, RATE, 0, 40, { ...FLAT_EQ, highDb: 6, highHz: 4000 })!, RATE).db;
  const lift = bright[BANDS - 1] - bright[6] - (db[BANDS - 1] - db[6]);
  assert.ok(lift > 5 && lift < 6.5, `the top band up ${lift.toFixed(2)} dB on the middle`);
  assert.equal(bandShares(new Float32Array(BANDS * 10), RATE, 0, 40, undefined), null, 'silence has no spectrum');
});

test('the analyser averages what plays over a second or two, and reads white noise rising 3 dB an octave', () => {
  const rta = new Rta();
  assert.ok(rta.empty);
  const flat = (db: number) => ({ db: new Float32Array(4096).fill(db), sampleRate: 48000 });
  rta.update(flat(-60), 0);
  // Equal power in every bin is white noise; per octave, each octave holds twice the last.
  const line = rta.line(Float64Array.from([500, 1000, 2000]))!;
  assert.ok(Math.abs(line[1] - line[0] - 3.01) < 0.3 && Math.abs(line[2] - line[1] - 3.01) < 0.3, `${[...line].map((v) => v.toFixed(2))}`);
  // Ten dB louder for 1.5 s, in frames of a sixtieth of a second: most of the way there, not all.
  for (let t = 1; t <= 90; t++) rta.update(flat(-50), (t * 1000) / 60);
  const moved = rta.line(Float64Array.from([1000]))![0] - line[1];
  const expected = 10 * Math.log10(1 + (1 - Math.exp(-1)) * 9);
  assert.ok(Math.abs(moved - expected) < 0.3, `moved ${moved.toFixed(2)} dB, not ${expected.toFixed(2)}`);
  rta.reset();
  assert.ok(rta.empty);
});
