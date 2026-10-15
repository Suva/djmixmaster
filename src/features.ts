// What the visuals of a video export move to: the spectrum thirty times a
// second, the overall level, and where the beats fall. Worked out in a pass of
// its own, in the background, so opening a recording is no slower for it.
// Kept free of Node imports, like the other measuring code.

/** How many times a second the spectrum and level are taken. A video frame between two is interpolated. */
export const FEATURE_RATE = 30;
/** Bands of the spectrum, spaced evenly in pitch from the lowest to the highest. */
export const BAND_COUNT = 24;
export const LOWEST_HZ = 30;
export const HIGHEST_HZ = 16000;
/** Band values and the level are kept as one byte each, from this many dB below full scale up to it. */
export const FLOOR_DB = -72;
/** Bump when the values would come out differently, so stored ones are worked out again. */
export const FEATURES_VERSION = 1;

export interface Features {
  /** Values per second in `bands` and `level`. */
  rate: number;
  /** `BAND_COUNT` bytes per step, 0 at `FLOOR_DB` and below, 255 at full scale. */
  bands: Uint8Array;
  /** One byte per step, on the same scale. */
  level: Uint8Array;
  /** When each beat falls, in seconds from the start. */
  beats: Float64Array;
  /** How strong the kick on each beat is, 0 to 1; low where the beat runs on through a breakdown. */
  beatStrength: Float32Array;
}

const FFT_SIZE = 2048;
/** The kick is followed at this many steps a second, so beats land within a few milliseconds. */
const ONSET_RATE = 200;
/** Where the kick is looked for. */
const KICK_HZ = 120;

const toByte = (db: number) => Math.round(Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB)) * 255);

/** An in-place complex FFT of a power-of-two size. */
class Fft {
  readonly #size: number;
  readonly #reversed: Uint32Array;
  readonly #cos: Float64Array;
  readonly #sin: Float64Array;

  constructor(size: number) {
    this.#size = size;
    const bits = Math.log2(size);
    this.#reversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.#reversed[i] = r;
    }
    this.#cos = new Float64Array(size / 2);
    this.#sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.#cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.#sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
  }

  transform(re: Float64Array, im: Float64Array) {
    const n = this.#size;
    for (let i = 0; i < n; i++) {
      const j = this.#reversed[i];
      if (j > i) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let length = 2; length <= n; length *= 2) {
      const half = length / 2;
      const step = n / length;
      for (let start = 0; start < n; start += length) {
        for (let k = 0; k < half; k++) {
          const wr = this.#cos[k * step];
          const wi = this.#sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

/** A second-order low-pass filter (RBJ cookbook), one channel. */
class LowPass {
  readonly #b0: number;
  readonly #b1: number;
  readonly #b2: number;
  readonly #a1: number;
  readonly #a2: number;
  #x1 = 0;
  #x2 = 0;
  #y1 = 0;
  #y2 = 0;

  constructor(sampleRate: number, hz: number) {
    const w = (2 * Math.PI * hz) / sampleRate;
    const alpha = Math.sin(w) / Math.SQRT2;
    const a0 = 1 + alpha;
    this.#b0 = (1 - Math.cos(w)) / 2 / a0;
    this.#b1 = (1 - Math.cos(w)) / a0;
    this.#b2 = this.#b0;
    this.#a1 = (-2 * Math.cos(w)) / a0;
    this.#a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.#b0 * x + this.#b1 * this.#x1 + this.#b2 * this.#x2 - this.#a1 * this.#y1 - this.#a2 * this.#y2;
    this.#x2 = this.#x1;
    this.#x1 = x;
    this.#y2 = this.#y1;
    this.#y1 = y;
    return y;
  }
}

/** Takes the sound in as interleaved stereo chunks and gives the features at the end. */
export class FeatureExtractor {
  readonly #sampleRate: number;
  readonly #fft = new Fft(FFT_SIZE);
  readonly #window = new Float64Array(FFT_SIZE);
  /** The last `FFT_SIZE` samples, mono. */
  readonly #ring = new Float64Array(FFT_SIZE);
  readonly #re = new Float64Array(FFT_SIZE);
  readonly #im = new Float64Array(FFT_SIZE);
  /** First and last FFT bin of each band. */
  readonly #bandBins: [number, number][] = [];
  #samples = 0;
  #bands: number[] = [];
  #level: number[] = [];
  /** Squares since the last spectrum, for the level. */
  #levelSum = 0;
  #levelCount = 0;

  readonly #kick: [LowPass, LowPass];
  #kickSum = 0;
  #kickCount = 0;
  #kickEnergy: number[] = [];

  constructor(sampleRate: number) {
    this.#sampleRate = sampleRate;
    for (let i = 0; i < FFT_SIZE; i++) this.#window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
    const binHz = sampleRate / FFT_SIZE;
    for (let b = 0; b < BAND_COUNT; b++) {
      const low = LOWEST_HZ * Math.pow(HIGHEST_HZ / LOWEST_HZ, b / BAND_COUNT);
      const high = LOWEST_HZ * Math.pow(HIGHEST_HZ / LOWEST_HZ, (b + 1) / BAND_COUNT);
      // Every band gets at least one bin, even the lowest, which is narrower than a bin.
      const first = Math.max(1, Math.round(low / binHz));
      const last = Math.min(FFT_SIZE / 2 - 1, Math.max(first, Math.round(high / binHz) - 1));
      this.#bandBins.push([first, last]);
    }
    this.#kick = [new LowPass(sampleRate, KICK_HZ), new LowPass(sampleRate, KICK_HZ)];
  }

  /** Sample at which spectrum number `step` is taken: centred on its moment, so it needs half a window after it. */
  #spectrumDue(step: number): number {
    return Math.round((step * this.#sampleRate) / FEATURE_RATE) + FFT_SIZE / 2;
  }

  push(chunk: Float32Array) {
    const sampleRate = this.#sampleRate;
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      const mono = (chunk[i] + chunk[i + 1]) / 2;
      this.#ring[this.#samples % FFT_SIZE] = mono;
      this.#samples++;
      this.#levelSum += mono * mono;
      this.#levelCount++;
      if (this.#samples === this.#spectrumDue(this.#bands.length / BAND_COUNT)) this.#spectrum();

      const low = this.#kick[1].process(this.#kick[0].process(mono));
      this.#kickSum += low * low;
      this.#kickCount++;
      if (this.#samples >= Math.round(((this.#kickEnergy.length + 1) * sampleRate) / ONSET_RATE)) {
        this.#kickEnergy.push(this.#kickSum / this.#kickCount);
        this.#kickSum = 0;
        this.#kickCount = 0;
      }
    }
  }

  #spectrum() {
    for (let i = 0; i < FFT_SIZE; i++) {
      this.#re[i] = this.#ring[(this.#samples + i) % FFT_SIZE] * this.#window[i];
      this.#im[i] = 0;
    }
    this.#fft.transform(this.#re, this.#im);
    // A full-scale sine comes out near 0 dB in the band it falls in.
    const scale = (FFT_SIZE / 4) ** 2;
    for (const [first, last] of this.#bandBins) {
      let power = 0;
      for (let k = first; k <= last; k++) power += this.#re[k] ** 2 + this.#im[k] ** 2;
      this.#bands.push(toByte(10 * Math.log10(power / scale + 1e-12)));
    }
    this.#level.push(toByte(10 * Math.log10(this.#levelSum / Math.max(1, this.#levelCount) + 1e-12) + 3));
    this.#levelSum = 0;
    this.#levelCount = 0;
  }

  finish(): Features {
    // The last spectra lack the second half of their window; they get silence there.
    const steps = Math.ceil((this.#samples * FEATURE_RATE) / this.#sampleRate);
    while (this.#bands.length / BAND_COUNT < steps) {
      this.#ring[this.#samples % FFT_SIZE] = 0;
      this.#samples++;
      if (this.#samples === this.#spectrumDue(this.#bands.length / BAND_COUNT)) this.#spectrum();
    }
    const { beats, strength } = findBeats(Float64Array.from(this.#kickEnergy), ONSET_RATE);
    return {
      rate: FEATURE_RATE,
      bands: Uint8Array.from(this.#bands.slice(0, steps * BAND_COUNT)),
      level: Uint8Array.from(this.#level.slice(0, steps)),
      beats,
      beatStrength: strength,
    };
  }
}

// ---------------------------------------------------------------------------
// Beats. Dance music has a steady kick, so the beats are found from how
// suddenly the low end gets louder: first the tempo in each stretch, then the
// row of beats that best lines up with the kicks at that tempo (after Ellis,
// "Beat tracking by dynamic programming", 2007). Where the kick stops, as in a
// breakdown, the row carries on at the tempo around it, with low strength.

const SLOWEST_BPM = 70;
const FASTEST_BPM = 190;
/** The tempo a DJ mix most likely has, which settles doubts between half and double. */
const LIKELY_BPM = 125;
const TEMPO_WINDOW_SECONDS = 8;
const TEMPO_STEP_SECONDS = 2;
/** How firmly beats keep to the tempo rather than to each kick. */
const TIGHTNESS = 6000;

export function findBeats(kickEnergy: Float64Array, rate: number): { beats: Float64Array; strength: Float32Array } {
  const n = kickEnergy.length;
  // How suddenly the low end gets louder, in dB, ignoring near-silence. The
  // energy is first averaged over 20 ms: in shorter slices a bass note's own
  // waves come and go, and drown the kicks.
  const smooth = Math.max(1, Math.round(0.02 * rate));
  const level = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += kickEnergy[i] - (i >= smooth ? kickEnergy[i - smooth] : 0);
    level[i] = 10 * Math.log10(Math.max(0, sum) / Math.min(i + 1, smooth) + 1e-12);
  }
  const gap = Math.max(1, smooth >> 1);
  const onset = new Float64Array(n);
  for (let i = gap; i < n; i++) onset[i] = level[i] > -70 ? Math.max(0, level[i] - level[i - gap]) : 0;
  let mean = 0;
  for (const value of onset) mean += value;
  mean /= Math.max(1, n);
  let spread = 0;
  for (const value of onset) spread += (value - mean) ** 2;
  spread = Math.sqrt(spread / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) onset[i] /= spread;

  const period = tempoMap(onset, rate);

  // Each step's best score for a row of beats ending on it, and the beat before.
  const score = new Float64Array(n);
  const before = new Int32Array(n).fill(-1);
  const penalties = new Map<number, Float64Array>();
  for (let t = 0; t < n; t++) {
    const p = Math.round(period[t]);
    let penalty = penalties.get(p);
    if (!penalty) {
      penalty = new Float64Array(2 * p + 1);
      for (let d = 0; d <= 2 * p; d++) penalty[d] = d === 0 ? Infinity : TIGHTNESS * Math.log(d / p) ** 2;
      penalties.set(p, penalty);
    }
    let best = 0;
    let from = -1;
    for (let d = Math.round(p / 2); d <= 2 * p && t - d >= 0; d++) {
      const candidate = score[t - d] - penalty[d];
      if (candidate > best) {
        best = candidate;
        from = t - d;
      }
    }
    score[t] = onset[t] + best;
    before[t] = from;
  }

  // The row ends at the best-scoring step within a beat of the end.
  let last = n - 1;
  for (let t = Math.max(0, n - Math.round(period[n - 1] || rate)); t < n; t++) if (score[t] > score[last]) last = t;
  const steps: number[] = [];
  for (let t = last; t >= 0; t = before[t]) steps.push(t);
  steps.reverse();

  const strongest = Math.max(1e-9, ...steps.map((t) => onset[t]));
  return {
    beats: Float64Array.from(steps, (t) => (t + 0.5) / rate),
    strength: Float32Array.from(steps, (t) => Math.min(1, onset[t] / (strongest * 0.5))),
  };
}

/** The length of a beat, in steps, at every step: the tempo of each stretch, smoothed over its neighbours. */
export function tempoMap(onset: Float64Array, rate: number): Float64Array {
  const n = onset.length;
  const window = Math.round(TEMPO_WINDOW_SECONDS * rate);
  const stride = Math.round(TEMPO_STEP_SECONDS * rate);
  const shortest = Math.floor((60 / FASTEST_BPM) * rate);
  const longest = Math.ceil((60 / SLOWEST_BPM) * rate);
  const found: number[] = [];
  /** How clearly each window repeats at its tempo: its best match against itself unshifted. */
  const clarity: number[] = [];
  for (let start = 0; start === 0 || start + window <= n; start += stride) {
    const end = Math.min(n, start + window);
    let bestLag = Math.round((60 / LIKELY_BPM) * rate);
    let bestScore = 0;
    let bestSum = 0;
    let itself = 0;
    for (let i = start; i < end; i++) itself += onset[i] * onset[i];
    for (let lag = shortest; lag <= longest; lag++) {
      let sum = 0;
      for (let i = start + lag; i < end; i++) sum += onset[i] * onset[i - lag];
      // Favour tempos near the likely one, on a scale of musical intervals.
      const bpm = (60 * rate) / lag;
      const weighted = sum * Math.exp(-0.5 * (Math.log2(bpm / LIKELY_BPM) / 0.9) ** 2);
      if (weighted > bestScore) {
        bestScore = weighted;
        bestSum = sum;
        bestLag = lag;
      }
    }
    found.push(bestLag);
    clarity.push(itself > 0 ? bestSum / itself : 0);
    if (end === n) break;
  }
  // Without a kick (a breakdown, an ambient intro) a window's best guess is
  // noise. It takes the tempo of the nearest window that had a clear one.
  const typical = [...clarity].sort((a, b) => a - b)[clarity.length >> 1];
  const clear = clarity.map((value) => value >= typical * 0.5);
  if (clear.some(Boolean)) {
    for (let i = 0; i < found.length; i++) {
      if (clear[i]) continue;
      for (let d = 1; ; d++) {
        if (clear[i - d]) { found[i] = found[i - d]; break; }
        if (clear[i + d]) { found[i] = found[i + d]; break; }
      }
    }
  }
  // A tempo that jumps for one window is a mistake more often than a change.
  const smoothed = found.map((_, i) => {
    const near = found.slice(Math.max(0, i - 3), i + 4).sort((a, b) => a - b);
    return near[near.length >> 1];
  });
  const period = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const at = Math.min(smoothed.length - 1, Math.max(0, Math.round((t - window / 2) / stride)));
    period[t] = smoothed[at];
  }
  return period;
}
