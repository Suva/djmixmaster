// ITU-R BS.1770 loudness, measured as K-weighted energy in 100 ms blocks so that
// momentary, short-term and integrated loudness can all be derived afterwards.

export const HOP_SECONDS = 0.1;
/** Bump whenever a recording would measure differently, so that stored analyses are redone. */
export const ANALYSIS_VERSION = 4;
/** Loudness reported for digital silence. */
export const SILENCE_LUFS = -120;

/** A second-order filter, normalised so that a0 is 1. */
export interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

/** How much a filter multiplies the power of a tone at `hz`. */
export function biquadPower(f: Biquad, hz: number, sampleRate: number): number {
  const w = (2 * Math.PI * hz) / sampleRate;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = f.b0 + f.b1 * c1 + f.b2 * c2, ni = -(f.b1 * s1 + f.b2 * s2);
  const dr = 1 + f.a1 * c1 + f.a2 * c2, di = -(f.a1 * s1 + f.a2 * s2);
  return (nr * nr + ni * ni) / (dr * dr + di * di);
}

/** The two K-weighting stages (high shelf, then high-pass) for any sample rate. */
function kWeighting(sampleRate: number): [Biquad, Biquad] {
  const shelfK = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  const shelfQ = 0.7071752369554196;
  const vh = Math.pow(10, 3.999843853973347 / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const shelfA0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  const shelf: Biquad = {
    b0: (vh + (vb * shelfK) / shelfQ + shelfK * shelfK) / shelfA0,
    b1: (2 * (shelfK * shelfK - vh)) / shelfA0,
    b2: (vh - (vb * shelfK) / shelfQ + shelfK * shelfK) / shelfA0,
    a1: (2 * (shelfK * shelfK - 1)) / shelfA0,
    a2: (1 - shelfK / shelfQ + shelfK * shelfK) / shelfA0,
  };

  const hpK = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  const hpQ = 0.5003270373238773;
  const hpA0 = 1 + hpK / hpQ + hpK * hpK;
  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (hpK * hpK - 1)) / hpA0,
    a2: (1 - hpK / hpQ + hpK * hpK) / hpA0,
  };
  return [shelf, highpass];
}

/** How much the K-weighting multiplies the power of a tone at `hz`. */
export function kWeightingPower(hz: number, sampleRate: number): number {
  const [shelf, highpass] = kWeighting(sampleRate);
  return biquadPower(shelf, hz, sampleRate) * biquadPower(highpass, hz, sampleRate);
}

/** How much of the power of a tone at `hz` the low band takes in. */
export function lowBandPower(hz: number, sampleRate: number): number {
  const [stage] = lowBand(sampleRate);
  return biquadPower(stage, hz, sampleRate) ** 2;
}

/** Bass and kick region used to compare the low-end weight of tracks. */
export const LOW_BAND_HZ = 150;

/** Fourth-order (two cascaded Butterworth stages) low-pass, unweighted. */
function lowBand(sampleRate: number): [Biquad, Biquad] {
  const k = Math.tan((Math.PI * LOW_BAND_HZ) / sampleRate);
  const a0 = 1 + Math.SQRT2 * k + k * k;
  const stage: Biquad = {
    b0: (k * k) / a0,
    b1: (2 * k * k) / a0,
    b2: (k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - Math.SQRT2 * k + k * k) / a0,
  };
  return [stage, stage];
}

export function energyToLufs(energy: number): number {
  return energy > 0 ? Math.max(SILENCE_LUFS, -0.691 + 10 * Math.log10(energy)) : SILENCE_LUFS;
}

/**
 * Streaming meter: feed interleaved samples, get one K-weighted energy value
 * per 100 ms, plus the energy of the low band for the same block, both as it
 * is and K-weighted (its share of the loudness).
 */
export class BlockEnergyMeter {
  readonly #channels: number;
  readonly #hopFrames: number;
  readonly #weighting: [Biquad, Biquad];
  readonly #lowpass: [Biquad, Biquad];
  /** Per channel, z1 and z2 of both stages of: the weighting, the low band, the weighted low band. */
  readonly #state: Float64Array;
  /** One channel's low band for the run being measured. */
  readonly #low: Float32Array;
  readonly #blocks: number[] = [];
  readonly #lowBlocks: number[] = [];
  readonly #weightedLowBlocks: number[] = [];
  readonly #peaks: number[] = [];
  #blockSum = 0;
  #lowSum = 0;
  #weightedLowSum = 0;
  #blockPeak = 0;
  #blockFill = 0;
  #peak = 0;

  constructor(sampleRate: number, channels: number) {
    this.#channels = channels;
    this.#hopFrames = Math.round(sampleRate * HOP_SECONDS);
    this.#weighting = kWeighting(sampleRate);
    this.#lowpass = lowBand(sampleRate);
    this.#state = new Float64Array(channels * 12);
    this.#low = new Float32Array(this.#hopFrames);
  }

  push(samples: Float32Array): void {
    const channels = this.#channels;
    const frames = samples.length / channels;
    const low = this.#low;
    let frame = 0;
    while (frame < frames) {
      const count = Math.min(frames - frame, this.#hopFrames - this.#blockFill);
      for (let c = 0; c < channels; c++) {
        const first = frame * channels + c;
        const state = c * 12;
        this.#blockSum += this.#filter(samples, first, channels, count, this.#weighting, state, null);
        this.#lowSum += this.#filter(samples, first, channels, count, this.#lowpass, state + 4, low);
        this.#weightedLowSum += this.#filter(low, 0, 1, count, this.#weighting, state + 8, null);
      }
      let peak = this.#blockPeak;
      for (let i = frame * channels; i < (frame + count) * channels; i++) {
        const abs = Math.abs(samples[i]);
        if (abs > peak) peak = abs;
      }
      this.#blockPeak = peak;
      this.#blockFill += count;
      frame += count;
      if (this.#blockFill === this.#hopFrames) {
        this.#blocks.push(this.#blockSum / this.#hopFrames);
        this.#lowBlocks.push(this.#lowSum / this.#hopFrames);
        this.#weightedLowBlocks.push(this.#weightedLowSum / this.#hopFrames);
        this.#peaks.push(this.#blockPeak);
        if (this.#blockPeak > this.#peak) this.#peak = this.#blockPeak;
        this.#blockSum = 0;
        this.#lowSum = 0;
        this.#weightedLowSum = 0;
        this.#blockPeak = 0;
        this.#blockFill = 0;
      }
    }
  }

  /** Highest absolute sample value seen. */
  get peak(): number {
    return Math.max(this.#peak, this.#blockPeak);
  }

  /** Highest absolute sample value in each complete 100 ms block, aligned with `blocks()`. */
  peaks(): Float32Array {
    return Float32Array.from(this.#peaks);
  }

  /** Energy per complete 100 ms block; a trailing partial block is dropped. */
  blocks(): Float64Array {
    return Float64Array.from(this.#blocks);
  }

  /** Low-band energy per complete 100 ms block, aligned with `blocks()`. */
  lowBlocks(): Float64Array {
    return Float64Array.from(this.#lowBlocks);
  }

  /**
   * K-weighted energy of everything above the low band, aligned with
   * `blocks()`: the loudness that is left when the bass is taken out.
   */
  restBlocks(): Float64Array {
    return Float64Array.from(this.#blocks, (total, i) => Math.max(total - this.#weightedLowBlocks[i], 0));
  }

  /**
   * Runs `count` samples, `step` apart from `first`, through a two-stage
   * filter. Returns their summed squares and, if `out` is given, stores them.
   */
  #filter(
    samples: Float32Array, first: number, step: number, count: number,
    filters: [Biquad, Biquad], base: number, out: Float32Array | null,
  ): number {
    const [s, h] = filters;
    const state = this.#state;
    let s1 = state[base], s2 = state[base + 1], h1 = state[base + 2], h2 = state[base + 3];
    let sum = 0;
    for (let n = 0, i = first; n < count; n++, i += step) {
      const x = samples[i];
      const y = s.b0 * x + s1;
      s1 = s.b1 * x - s.a1 * y + s2;
      s2 = s.b2 * x - s.a2 * y;
      const z = h.b0 * y + h1;
      h1 = h.b1 * y - h.a1 * z + h2;
      h2 = h.b2 * y - h.a2 * z;
      sum += z * z;
      if (out) out[n] = z;
    }
    // Keep denormals out of the recursion once the input goes silent.
    state[base] = Math.abs(s1) < 1e-30 ? 0 : s1;
    state[base + 1] = Math.abs(s2) < 1e-30 ? 0 : s2;
    state[base + 2] = Math.abs(h1) < 1e-30 ? 0 : h1;
    state[base + 3] = Math.abs(h2) < 1e-30 ? 0 : h2;
    return sum;
  }
}

/**
 * Short-term loudness (3 s window) in LUFS, one value per block. The window is
 * centred on the block so the curve lines up with the audio instead of lagging it.
 */
export function shortTermLoudness(blocks: Float64Array, windowSeconds = 3): Float32Array {
  const n = blocks.length;
  const half = Math.round(windowSeconds / HOP_SECONDS / 2);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + blocks[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half);
    out[i] = energyToLufs((prefix[hi] - prefix[lo]) / (hi - lo));
  }
  return out;
}

/** Gated integrated loudness (BS.1770-4) in LUFS. */
export function integratedLoudness(blocks: Float64Array): number {
  // 400 ms gating blocks with 75% overlap are four consecutive 100 ms blocks.
  const gating: number[] = [];
  for (let i = 0; i + 4 <= blocks.length; i++) {
    gating.push((blocks[i] + blocks[i + 1] + blocks[i + 2] + blocks[i + 3]) / 4);
  }
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const absolute = gating.filter((e) => energyToLufs(e) > -70);
  if (absolute.length === 0) return SILENCE_LUFS;
  const relativeGate = energyToLufs(mean(absolute)) - 10;
  const relative = absolute.filter((e) => energyToLufs(e) > relativeGate);
  return relative.length ? energyToLufs(mean(relative)) : SILENCE_LUFS;
}
