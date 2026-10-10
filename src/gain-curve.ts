// Turns a short-term loudness curve into a slow gain curve that evens out the
// level between tracks while leaving the dynamics inside each track alone.

import { HOP_SECONDS } from './loudness.ts';

export interface LevelOptions {
  /**
   * Quiet passages shorter than roughly `percentile * windowSeconds` count as
   * breakdowns and keep the gain of the music around them; longer ones are
   * treated as a quieter track and brought up.
   */
  windowSeconds: number;
  /** Loudness percentile inside the window that counts as full energy. */
  percentile: number;
  /**
   * What "equally loud" means: 0 matches perceived loudness, 1 matches the
   * level of the bass and kick, values in between blend the two.
   */
  bassWeight: number;
  /** Loudness the full-energy sections are brought to. Defaults to the mix's own typical level. */
  targetLufs?: number;
  /** Most a quiet track is raised, and a loud one lowered, relative to the mix's typical level. */
  maxBoostDb: number;
  maxCutDb: number;
  /** Width of the smoothing applied to the gain, i.e. roughly how long a gain change takes. */
  smoothSeconds: number;
  /** Hard cap on how fast the gain may move. */
  slewDbPerSecond: number;
}

export const DEFAULT_LEVEL_OPTIONS: LevelOptions = {
  windowSeconds: 100,
  percentile: 0.9,
  bassWeight: 0,
  maxBoostDb: 6,
  maxCutDb: 12,
  smoothSeconds: 10,
  slewDbPerSecond: 0.25,
};

/** Anything quieter is treated as a gap in the music and does not steer the gain. */
const GATE_LUFS = -50;
const BIN_DB = 0.1;
const BINS = Math.round((10 - GATE_LUFS) / BIN_DB);

/**
 * Sliding percentile over a centred window, skipping gated values. Entries
 * whose window holds nothing but gated values come back as NaN.
 */
function slidingPercentile(values: Float32Array, half: number, percentile: number): Float32Array {
  const n = values.length;
  const histogram = new Uint32Array(BINS);
  let count = 0;
  const bin = (lufs: number) => Math.min(BINS - 1, Math.floor((lufs - GATE_LUFS) / BIN_DB));

  // Only bins between the quietest and loudest value can ever be occupied.
  let lowest = BINS - 1;
  let highest = 0;
  for (let i = 0; i < n; i++) {
    if (values[i] >= GATE_LUFS) {
      lowest = Math.min(lowest, bin(values[i]));
      highest = Math.max(highest, bin(values[i]));
    }
  }

  const out = new Float32Array(n).fill(NaN);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const wantHi = Math.min(n, i + half + 1);
    const wantLo = Math.max(0, i - half);
    for (; hi < wantHi; hi++) {
      if (values[hi] >= GATE_LUFS) {
        histogram[bin(values[hi])]++;
        count++;
      }
    }
    for (; lo < wantLo; lo++) {
      if (values[lo] >= GATE_LUFS) {
        histogram[bin(values[lo])]--;
        count--;
      }
    }
    if (count === 0) continue;
    // Count in from whichever end of the histogram the percentile is nearer to.
    const rank = Math.max(1, Math.ceil(count * (1 - percentile)));
    let b: number;
    if (percentile >= 0.5) {
      b = highest;
      for (let above = histogram[b]; above < rank; above += histogram[b]) b--;
    } else {
      b = lowest;
      for (let below = histogram[b]; below < count - rank + 1; below += histogram[b]) b++;
    }
    out[i] = GATE_LUFS + (b + 0.5) * BIN_DB;
  }
  return out;
}

/**
 * The level of the full-energy music around each moment: the short-term
 * loudness with its dips filled in. A high sliding percentile lifts every dip
 * shorter than the window up to the level beside it, then the mirrored low
 * percentile pulls the edges it smeared back into place. Breakdowns vanish,
 * while a change of level between two tracks stays a step at the same spot.
 */
export function fullEnergyEnvelope(shortTerm: Float32Array, options: LevelOptions): Float32Array {
  const n = shortTerm.length;
  const half = Math.max(1, Math.round(options.windowSeconds / HOP_SECONDS / 2));
  const lifted = slidingPercentile(shortTerm, half, options.percentile);

  // Stretches with nothing but silence around them inherit the nearest level.
  let last = NaN;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(lifted[i])) lifted[i] = last;
    else last = lifted[i];
  }
  for (let i = n - 1; i >= 0; i--) {
    if (Number.isNaN(lifted[i])) lifted[i] = last;
    else last = lifted[i];
  }
  if (Number.isNaN(last)) throw new Error('The selected region is silent');

  return slidingPercentile(lifted, half, 1 - options.percentile);
}

export function median(values: Float32Array): number {
  const sorted = Float32Array.from(values).sort();
  return sorted[sorted.length >> 1];
}

function boxSmooth(values: Float32Array, width: number): Float32Array {
  const n = values.length;
  const half = width >> 1;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    out[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
  }
  return out;
}

/** Gain in dB per block that moves the envelope onto the reference level. */
export function gainCurve(envelope: Float32Array, referenceLufs: number, options: LevelOptions): Float32Array {
  const n = envelope.length;
  const clamped = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    clamped[i] = Math.min(options.maxBoostDb, Math.max(-options.maxCutDb, referenceLufs - envelope[i]));
  }

  const width = Math.max(1, Math.round(options.smoothSeconds / HOP_SECONDS));
  const gain = boxSmooth(boxSmooth(clamped, width), width);

  // Limit the slope in both directions and keep the lower result, so the cap
  // never makes anything louder than the smoothed curve asked for.
  const step = options.slewDbPerSecond * HOP_SECONDS;
  const forward = Float32Array.from(gain);
  for (let i = 1; i < n; i++) {
    forward[i] = Math.min(forward[i - 1] + step, Math.max(forward[i - 1] - step, gain[i]));
  }
  const backward = Float32Array.from(gain);
  for (let i = n - 2; i >= 0; i--) {
    backward[i] = Math.min(backward[i + 1] + step, Math.max(backward[i + 1] - step, gain[i]));
  }
  for (let i = 0; i < n; i++) gain[i] = Math.min(forward[i], backward[i]);
  return gain;
}
