// A mix's corrective EQ: a few broad filters that put right how a stretch of a
// recording sounds, such as a phono stage that is off or a PA mixer's EQ. The
// filters use the same formulas as the Web Audio BiquadFilterNode, so the
// preview and the export sound alike, and what they do to the loudness is
// worked out from the bands the analysis measured (bands.ts) rather than by
// decoding again. Free of Node imports.

import { BAND_EDGES_HZ, BANDS, BLOCKS_PER_BAND_FRAME } from './bands.ts';
import { biquadPower, kWeightingPower, lowBandPower, shortTermLoudness, type Biquad } from './loudness.ts';

export interface Eq {
  /** Corner of the rumble filter in Hz; 0 is off. */
  highPassHz: number;
  lowDb: number;
  lowHz: number;
  lowMidDb: number;
  lowMidHz: number;
  highMidDb: number;
  highMidHz: number;
  highDb: number;
  highHz: number;
}

export const FLAT_EQ: Readonly<Eq> = {
  highPassHz: 0,
  lowDb: 0,
  lowHz: 100,
  lowMidDb: 0,
  lowMidHz: 300,
  highMidDb: 0,
  highMidHz: 3000,
  highDb: 0,
  highHz: 8000,
};

/** Most any band raises or lowers. This is for putting a fault right, not for shaping a sound. */
export const EQ_MOST_DB = 6;
export const EQ_MOST_HIGH_PASS_HZ = 60;
/** Where each band's corner or centre can be moved, in Hz. */
export const EQ_RANGES_HZ = {
  lowHz: [40, 400],
  lowMidHz: [100, 1000],
  highMidHz: [1000, 8000],
  highHz: [2000, 16000],
} as const;

/** Broad enough that a mid band leans a region rather than picking a note out of it: about two octaves. */
const MID_Q = 0.7;
/** A rumble filter at 12 dB an octave, Butterworth. Web Audio takes a high-pass filter's Q in dB. */
const HIGH_PASS_Q_DB = 20 * Math.log10(Math.SQRT1_2);

export type FilterType = 'highpass' | 'lowshelf' | 'peaking' | 'highshelf';

/** One filter as a BiquadFilterNode is set: Q as it takes it, which for a high-pass filter is in dB. */
export interface Filter {
  type: FilterType;
  frequency: number;
  gain: number;
  Q: number;
}

/**
 * The filters of an EQ, always the same five in the same order, so that the
 * player can keep its nodes and only move their settings. A flat band is a
 * filter with no gain, and a rumble filter that is off is one at 0 Hz, which
 * Web Audio passes untouched.
 */
export function eqFilters(eq: Eq): Filter[] {
  return [
    { type: 'highpass', frequency: eq.highPassHz, gain: 0, Q: HIGH_PASS_Q_DB },
    { type: 'lowshelf', frequency: eq.lowHz, gain: eq.lowDb, Q: 1 },
    { type: 'peaking', frequency: eq.lowMidHz, gain: eq.lowMidDb, Q: MID_Q },
    { type: 'peaking', frequency: eq.highMidHz, gain: eq.highMidDb, Q: MID_Q },
    { type: 'highshelf', frequency: eq.highHz, gain: eq.highDb, Q: 1 },
  ];
}

export function isFlat(eq: Eq | undefined): boolean {
  return !eq || (eq.highPassHz === 0 && eq.lowDb === 0 && eq.lowMidDb === 0 && eq.highMidDb === 0 && eq.highDb === 0);
}

/**
 * A filter's coefficients, by the formulas of the Web Audio specification
 * (the Audio EQ Cookbook's, with the shelves' slope at 1). Null when it does
 * nothing.
 */
export function coefficients(filter: Filter, sampleRate: number): Biquad | null {
  const nyquist = sampleRate / 2;
  if (filter.type === 'highpass' ? filter.frequency <= 0 : filter.gain === 0) return null;
  const f0 = Math.min(filter.frequency, nyquist);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const a = Math.pow(10, filter.gain / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (filter.type === 'highpass') {
    const alpha = sin / (2 * Math.pow(10, filter.Q / 20));
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else if (filter.type === 'peaking') {
    const alpha = sin / (2 * filter.Q);
    b0 = 1 + alpha * a; b1 = -2 * cos; b2 = 1 - alpha * a;
    a0 = 1 + alpha / a; a1 = -2 * cos; a2 = 1 - alpha / a;
  } else {
    const beta = 2 * Math.sqrt(a) * (sin / 2) * Math.SQRT2;
    const sign = filter.type === 'lowshelf' ? 1 : -1;
    b0 = a * (a + 1 - sign * (a - 1) * cos + beta);
    b1 = sign * 2 * a * (a - 1 - sign * (a + 1) * cos);
    b2 = a * (a + 1 - sign * (a - 1) * cos - beta);
    a0 = a + 1 + sign * (a - 1) * cos + beta;
    a1 = -sign * 2 * (a - 1 + sign * (a + 1) * cos);
    a2 = a + 1 + sign * (a - 1) * cos - beta;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** The stages of an EQ that do something. */
function stages(eq: Eq, sampleRate: number): Biquad[] {
  return eqFilters(eq).map((filter) => coefficients(filter, sampleRate)).filter((stage) => stage !== null);
}

/** How much an EQ multiplies the power of a tone at `hz`. */
export function eqPower(eq: Eq, hz: number, sampleRate: number): number {
  let power = 1;
  for (const stage of stages(eq, sampleRate)) power *= biquadPower(stage, hz, sampleRate);
  return power;
}

/** An EQ's response in dB at each of `frequencies`, for drawing it. */
export function eqResponseDb(eq: Eq, frequencies: ArrayLike<number>, sampleRate = 48000): Float32Array {
  const all = stages(eq, sampleRate);
  return Float32Array.from(frequencies, (hz) => {
    let power = 1;
    for (const stage of all) power *= biquadPower(stage, hz, sampleRate);
    return 10 * Math.log10(power);
  });
}

/** Runs interleaved samples through an EQ that stays as it is. */
export class EqFilter {
  readonly #channels: number;
  readonly #stages: Biquad[];
  /** z1, z2 per stage per channel. */
  readonly #state: Float64Array;

  constructor(eq: Eq, sampleRate: number, channels: number) {
    this.#channels = channels;
    this.#stages = stages(eq, sampleRate);
    this.#state = new Float64Array(this.#stages.length * channels * 2);
  }

  /** Filters interleaved samples in place. */
  process(samples: Float32Array): void {
    const channels = this.#channels;
    const state = this.#state;
    this.#stages.forEach(({ b0, b1, b2, a1, a2 }, s) => {
      for (let c = 0; c < channels; c++) {
        const at = (s * channels + c) * 2;
        let z1 = state[at];
        let z2 = state[at + 1];
        for (let i = c; i < samples.length; i += channels) {
          const x = samples[i];
          const y = b0 * x + z1;
          z1 = b1 * x - a1 * y + z2;
          z2 = b2 * x - a2 * y;
          samples[i] = y;
        }
        // Keep denormals out of the recursion once the input goes silent.
        state[at] = Math.abs(z1) < 1e-30 ? 0 : z1;
        state[at + 1] = Math.abs(z2) < 1e-30 ? 0 : z2;
      }
    });
  }
}

/** What the analysis gives for working out an EQ's effect, for the blocks of one mix. */
export interface EqInput {
  sampleRate: number;
  /** K-weighted energy per block. */
  blocks: Float64Array;
  peaks: Float32Array;
  shortTerm: Float32Array;
  lowShortTerm: Float32Array;
  restShortTerm: Float32Array;
  /** The recording's band energies, `BANDS` for each `BLOCKS_PER_BAND_FRAME` blocks (bands.ts). */
  bands: Float32Array;
  /** Where in the recording the first of the blocks is, to find their bands. */
  firstBlock: number;
}

export type EqOutput = Omit<EqInput, 'sampleRate' | 'bands' | 'firstBlock'>;

/**
 * The bands' edges in Hz, bottom and top included: the bottom band starts
 * where music has next to nothing left, the top one ends where hearing does.
 */
function bandEdges(sampleRate: number): number[] {
  return [15, ...BAND_EDGES_HZ, Math.min(20000, sampleRate * 0.45)];
}

/** Points per band where the filters are looked at, spread evenly in pitch. */
const POINTS_PER_BAND = 12;

/**
 * Per band: the average of the EQ's power gain, and the same weighted by the
 * K-weighting, by the low band, and by both, each beside its value without
 * the EQ. The bands are wide, so the average over each stands for what the
 * music in it gets.
 */
function bandWeights(eq: Eq, sampleRate: number) {
  const edges = bandEdges(sampleRate);
  const all = stages(eq, sampleRate);
  const fields = ['plain', 'eq', 'k', 'kEq', 'low', 'lowEq', 'kLow', 'kLowEq'] as const;
  const weights = Object.fromEntries(fields.map((field) => [field, new Float64Array(BANDS)])) as Record<(typeof fields)[number], Float64Array>;
  for (let b = 0; b < BANDS; b++) {
    const lo = edges[b], hi = Math.max(edges[b + 1], lo);
    for (let p = 0; p < POINTS_PER_BAND; p++) {
      const hz = lo * Math.pow(hi / lo, (p + 0.5) / POINTS_PER_BAND);
      let g = 1;
      for (const stage of all) g *= biquadPower(stage, hz, sampleRate);
      const k = kWeightingPower(hz, sampleRate);
      const low = lowBandPower(hz, sampleRate);
      weights.plain[b] += 1;
      weights.eq[b] += g;
      weights.k[b] += k;
      weights.kEq[b] += k * g;
      weights.low[b] += low;
      weights.lowEq[b] += low * g;
      weights.kLow[b] += k * low;
      weights.kLowEq[b] += k * low * g;
    }
  }
  return weights;
}

/**
 * The measurements of a mix as they would be with an EQ: its loudness, its
 * low band, the loudness above it, and its peaks. From the bands, each block
 * gets how much the EQ changes its K-weighted energy, its low band, its
 * K-weighted energy above the low band, and its energy as it is. The first
 * multiplies the block's energy; the short-term curves are moved by as much
 * as those changes move short-term curves made from the bands themselves.
 *
 * The peaks are an estimate, which the limiter backs up. They are taken as
 * the bands' swings adding up, each raised by what its band is boosted, but
 * not lowered by a cut: a filter also shifts the phase of what it passes,
 * and on mastered music that raises the peaks about as much as a cut lowers
 * them. A rumble filter on its own raised them by 0.7 dB on a recording it was tried on.
 * A flat EQ hands back what it was given.
 */
export function withEq(input: EqInput, eq: Eq | undefined): EqOutput {
  const { blocks, peaks, shortTerm, lowShortTerm, restShortTerm, bands } = input;
  const frames = bands.length / BANDS;
  if (!eq || isFlat(eq) || frames === 0) return { blocks, peaks, shortTerm, lowShortTerm, restShortTerm };
  const w = bandWeights(eq, input.sampleRate);
  const n = blocks.length;
  const factor = new Float64Array(n);
  const low = new Float64Array(n), lowEq = new Float64Array(n);
  const rest = new Float64Array(n), restEq = new Float64Array(n);
  const total = new Float64Array(n), totalEq = new Float64Array(n);
  const outPeaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const frame = Math.min(frames - 1, Math.floor((input.firstBlock + i) / BLOCKS_PER_BAND_FRAME));
    let swing = 0, swingEq = 0, k = 0, kEq = 0, lo = 0, loEq = 0, kLow = 0, kLowEq = 0;
    for (let b = 0; b < BANDS; b++) {
      // Energy per point of the band, so that the weights' sums are averages.
      const e = bands[frame * BANDS + b] / POINTS_PER_BAND;
      const swingOf = Math.sqrt(bands[frame * BANDS + b]);
      swing += swingOf;
      swingEq += swingOf * Math.sqrt(Math.max(1, w.eq[b] / w.plain[b]));
      k += e * w.k[b];
      kEq += e * w.kEq[b];
      lo += e * w.low[b];
      loEq += e * w.lowEq[b];
      kLow += e * w.kLow[b];
      kLowEq += e * w.kLowEq[b];
    }
    factor[i] = k > 0 ? kEq / k : 1;
    total[i] = k;
    totalEq[i] = kEq;
    low[i] = lo;
    lowEq[i] = loEq;
    rest[i] = Math.max(0, k - kLow);
    restEq[i] = Math.max(0, kEq - kLowEq);
    outPeaks[i] = peaks[i] * (swing > 0 ? swingEq / swing : 1);
  }
  const moved = (curve: Float32Array, before: Float64Array, after: Float64Array) => {
    const was = shortTermLoudness(before), now = shortTermLoudness(after);
    return curve.map((value, i) => value + now[i] - was[i]);
  };
  return {
    blocks: blocks.map((energy, i) => energy * factor[i]),
    peaks: outPeaks,
    shortTerm: moved(shortTerm, total, totalEq),
    lowShortTerm: moved(lowShortTerm, low, lowEq),
    restShortTerm: moved(restShortTerm, rest, restEq),
  };
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/**
 * An EQ read back from disk or given on the command line, kept within its
 * ranges; undefined when it is not one, or is the flat EQ every mix starts
 * with. One with no gain but its frequencies moved is kept, as they were chosen.
 */
export function checkedEq(value: unknown): Eq | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const given = value as Partial<Record<keyof Eq, unknown>>;
  const gain = (key: keyof Eq) => (isNumber(given[key]) ? clamp(given[key], -EQ_MOST_DB, EQ_MOST_DB) : 0);
  const hz = (key: keyof typeof EQ_RANGES_HZ) =>
    isNumber(given[key]) ? clamp(given[key], EQ_RANGES_HZ[key][0], EQ_RANGES_HZ[key][1]) : FLAT_EQ[key];
  const eq: Eq = {
    highPassHz: isNumber(given.highPassHz) ? clamp(given.highPassHz, 0, EQ_MOST_HIGH_PASS_HZ) : 0,
    lowDb: gain('lowDb'),
    lowHz: hz('lowHz'),
    lowMidDb: gain('lowMidDb'),
    lowMidHz: hz('lowMidHz'),
    highMidDb: gain('highMidDb'),
    highMidHz: hz('highMidHz'),
    highDb: gain('highDb'),
    highHz: hz('highHz'),
  };
  return (Object.keys(FLAT_EQ) as (keyof Eq)[]).every((key) => eq[key] === FLAT_EQ[key]) ? undefined : eq;
}

/**
 * How a stretch's energy divides over the bands, as shares that add up to 1,
 * as an EQ makes it sound; null when the stretch has no measured sound.
 */
export function bandShares(bands: Float32Array, sampleRate: number, startBlock: number, endBlock: number, eq: Eq | undefined): Float64Array | null {
  const frames = bands.length / BANDS;
  const first = Math.floor(startBlock / BLOCKS_PER_BAND_FRAME);
  const last = Math.min(frames, Math.ceil(endBlock / BLOCKS_PER_BAND_FRAME));
  const sums = new Float64Array(BANDS);
  for (let frame = first; frame < last; frame++) {
    for (let b = 0; b < BANDS; b++) sums[b] += bands[frame * BANDS + b];
  }
  if (eq && !isFlat(eq)) {
    const w = bandWeights(eq, sampleRate);
    for (let b = 0; b < BANDS; b++) sums[b] *= w.eq[b] / w.plain[b];
  }
  const total = sums.reduce((sum, e) => sum + e, 0);
  return total > 0 ? sums.map((e) => e / total) : null;
}

/**
 * Shares of the bands as a spectrum to draw: the energy per octave in dB,
 * at the middle of each band in pitch. Per octave is how an analyser shows
 * music, on which pink noise is flat.
 */
export function bandSpectrum(shares: Float64Array, sampleRate: number): { hz: Float64Array; db: Float64Array } {
  const edges = bandEdges(sampleRate);
  const hz = Float64Array.from(shares, (_, b) => Math.sqrt(edges[b] * edges[b + 1]));
  const db = Float64Array.from(shares, (share, b) => 10 * Math.log10(Math.max(share, 1e-12) / Math.log2(edges[b + 1] / edges[b])));
  return { hz, db };
}
