// Gathers what the check-up needs to know about a recording while it is being
// analysed: how the two channels relate, where it clips, where it falls
// completely silent, and its average spectrum. Free of Node imports.

import { HOP_SECONDS } from './loudness.ts';

/** A sample this close to full scale counts towards clipping. */
const CLIP_LEVEL = 0.99;
/**
 * A limiter touches full scale for a sample at a time; a clipped waveform sits
 * there. Only runs this long are counted.
 */
const CLIP_RUN = 3;
/** Below this, in both channels at once, is silence no music ever holds for long. */
const SILENCE_LEVEL = 1e-4;
/** The shortest silence worth noting, in seconds. */
const MIN_SILENCE_SECONDS = 0.005;
const MAX_SILENCES = 5000;

export const SPECTRUM_SIZE = 4096;
/** How often a stretch is taken for the average spectrum, in seconds. */
const SPECTRUM_INTERVAL_SECONDS = 4;
/** Stretches quieter than this say nothing about the recording's spectrum. */
const SPECTRUM_MIN_RMS = 0.003;

/**
 * The bottom of the spectrum is examined separately and much more finely, at
 * about a thousand samples a second: mains hum is told from a bass note by
 * sitting on exactly 50 or 60 Hz, which takes a quarter-hertz to see.
 */
const LOW_RATE = 1000;
const LOW_CUTOFF_HZ = 250;
/**
 * Samples are first averaged in groups of this many, which is nearly free, and
 * only the result is filtered properly. Filtering every sample of an 8-hour
 * recording for the sake of its lowest 250 Hz would double the analysis time.
 */
const LOW_GROUP = 8;
/** The mains frequencies and the two harmonics above each that are looked at. */
export const MAINS_TONES = [50, 100, 150, 60, 120, 180];
/** Values kept per stretch of the low spectrum; see `Diagnostics.low`. */
export const LOW_FIELDS = 3 + MAINS_TONES.length * 2;

export interface Silence {
  /** Where it starts, in blocks from the start of what was analysed. */
  at: number;
  seconds: number;
}

export interface Diagnostics {
  /** Mean square of the left channel, of the right, and mean of their product, per 100 ms block. */
  left: Float32Array;
  right: Float32Array;
  cross: Float32Array;
  /** Per block, how many samples sat at full scale as part of a run (at most 255). */
  clipped: Uint8Array;
  /** Stretches where both channels were silent at once. */
  silences: Silence[];
  /** Average power per frequency bin, from 0 Hz to half the sample rate. */
  spectrum: Float32Array;
  /**
   * One row of `LOW_FIELDS` numbers per four-second stretch of the low
   * spectrum: the block in the middle of it, the power below 20 Hz, the power
   * of the bass (30 to 200 Hz), and then for each of `MAINS_TONES` the power
   * right on the tone followed by the typical power just beside it.
   */
  low: Float32Array;
  /** How fast the low spectrum was sampled, and the full-scale power of a tone in it. */
  lowRate: number;
  /** The average sample value of the left and of the right channel; not zero means a DC offset. */
  dc: [number, number];
}

/** One stage of a low-pass filter, run in place over a single value at a time. */
class LowPass {
  readonly #b0: number;
  readonly #b1: number;
  readonly #b2: number;
  readonly #a1: number;
  readonly #a2: number;
  #z1 = 0;
  #z2 = 0;

  constructor(sampleRate: number, cutoff: number) {
    const k = Math.tan((Math.PI * cutoff) / sampleRate);
    const a0 = 1 + Math.SQRT2 * k + k * k;
    this.#b0 = (k * k) / a0;
    this.#b1 = (2 * k * k) / a0;
    this.#b2 = (k * k) / a0;
    this.#a1 = (2 * (k * k - 1)) / a0;
    this.#a2 = (1 - Math.SQRT2 * k + k * k) / a0;
  }

  next(x: number): number {
    const y = this.#b0 * x + this.#z1;
    this.#z1 = this.#b1 * x - this.#a1 * y + this.#z2;
    this.#z2 = this.#b2 * x - this.#a2 * y;
    return y;
  }
}

/** In-place FFT of `SPECTRUM_SIZE` points. */
function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const cos = Math.cos(step * k);
        const sin = Math.sin(step * k);
        const a = start + k;
        const b = a + half;
        const tr = real[b] * cos - imag[b] * sin;
        const ti = real[b] * sin + imag[b] * cos;
        real[b] = real[a] - tr;
        imag[b] = imag[a] - ti;
        real[a] += tr;
        imag[a] += ti;
      }
    }
  }
}

/** Feed it the interleaved stereo samples of a recording in order; `finish` hands back what it saw. */
export class RecordingExaminer {
  readonly #hopFrames: number;
  readonly #minSilenceFrames: number;
  readonly #left: number[] = [];
  readonly #right: number[] = [];
  readonly #cross: number[] = [];
  readonly #clipped: number[] = [];
  readonly #silences: Silence[] = [];
  #sumLeft = 0;
  #sumRight = 0;
  #sumCross = 0;
  #blockClipped = 0;
  #blockFill = 0;
  #frame = 0;
  #runLeft = 0;
  #runRight = 0;
  #silentRun = 0;

  readonly #spectrumInterval: number;
  readonly #capture = new Float64Array(SPECTRUM_SIZE);
  readonly #imag = new Float64Array(SPECTRUM_SIZE);
  readonly #window = Float64Array.from({ length: SPECTRUM_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SPECTRUM_SIZE));
  readonly #spectrum = new Float64Array(SPECTRUM_SIZE / 2 + 1);
  #captures = 0;
  #captureFill = -1;
  #untilCapture: number;
  #takeRight = false;

  // The low spectrum: each channel filtered, thinned out, and gathered four seconds at a time.
  readonly #lowFilters: [LowPass[], LowPass[]];
  /** After grouping, every how many values one is kept. */
  readonly #lowEvery: number;
  #groupLeft = 0;
  #groupRight = 0;
  #groupFill = 0;
  readonly #lowRate: number;
  readonly #lowLeft = new Float64Array(SPECTRUM_SIZE);
  readonly #lowRight = new Float64Array(SPECTRUM_SIZE);
  readonly #lowRows: number[] = [];
  #lowSkip = 0;
  #lowFill = 0;
  #dcLeft = 0;
  #dcRight = 0;

  constructor(sampleRate: number) {
    this.#hopFrames = Math.round(sampleRate * HOP_SECONDS);
    this.#minSilenceFrames = Math.max(1, Math.round(sampleRate * MIN_SILENCE_SECONDS));
    this.#spectrumInterval = Math.round(sampleRate * SPECTRUM_INTERVAL_SECONDS);
    this.#untilCapture = Math.round(sampleRate);
    const grouped = sampleRate / LOW_GROUP;
    this.#lowEvery = Math.max(1, Math.round(grouped / LOW_RATE));
    this.#lowRate = grouped / this.#lowEvery;
    const stages = () => [0, 1, 2].map(() => new LowPass(grouped, LOW_CUTOFF_HZ));
    this.#lowFilters = [stages(), stages()];
  }

  push(samples: Float32Array): void {
    const frames = samples.length / 2;
    for (let f = 0; f < frames; f++) {
      const l = samples[f * 2];
      const r = samples[f * 2 + 1];
      this.#sumLeft += l * l;
      this.#sumRight += r * r;
      this.#sumCross += l * r;

      const absLeft = l < 0 ? -l : l;
      const absRight = r < 0 ? -r : r;
      if (absLeft >= CLIP_LEVEL) {
        if (++this.#runLeft === CLIP_RUN) this.#blockClipped += CLIP_RUN;
        else if (this.#runLeft > CLIP_RUN) this.#blockClipped++;
      } else this.#runLeft = 0;
      if (absRight >= CLIP_LEVEL) {
        if (++this.#runRight === CLIP_RUN) this.#blockClipped += CLIP_RUN;
        else if (this.#runRight > CLIP_RUN) this.#blockClipped++;
      } else this.#runRight = 0;

      if (absLeft < SILENCE_LEVEL && absRight < SILENCE_LEVEL) {
        this.#silentRun++;
      } else if (this.#silentRun > 0) {
        this.#endSilence();
      }

      // Every few seconds, take a stretch of one channel for the average spectrum.
      if (this.#captureFill >= 0) {
        this.#capture[this.#captureFill++] = this.#takeRight ? r : l;
        if (this.#captureFill === SPECTRUM_SIZE) this.#analyse();
      } else if (--this.#untilCapture <= 0) {
        this.#captureFill = 0;
      }

      this.#groupLeft += l;
      this.#groupRight += r;
      if (++this.#groupFill === LOW_GROUP) this.#pushLow();

      this.#frame++;
      if (++this.#blockFill === this.#hopFrames) {
        this.#left.push(this.#sumLeft / this.#hopFrames);
        this.#right.push(this.#sumRight / this.#hopFrames);
        this.#cross.push(this.#sumCross / this.#hopFrames);
        this.#clipped.push(Math.min(255, this.#blockClipped));
        this.#sumLeft = this.#sumRight = this.#sumCross = 0;
        this.#blockClipped = 0;
        this.#blockFill = 0;
      }
    }
  }

  finish(): Diagnostics {
    const spectrum = new Float32Array(this.#spectrum.length);
    if (this.#captures > 0) for (let k = 0; k < spectrum.length; k++) spectrum[k] = this.#spectrum[k] / this.#captures;
    return {
      left: Float32Array.from(this.#left),
      right: Float32Array.from(this.#right),
      cross: Float32Array.from(this.#cross),
      clipped: Uint8Array.from(this.#clipped),
      silences: this.#silences,
      spectrum,
      low: Float32Array.from(this.#lowRows),
      lowRate: this.#lowRate,
      dc: this.#frame > 0 ? [this.#dcLeft / this.#frame, this.#dcRight / this.#frame] : [0, 0],
    };
  }

  #endSilence(): void {
    if (this.#silentRun >= this.#minSilenceFrames && this.#silences.length < MAX_SILENCES) {
      this.#silences.push({
        at: (this.#frame - this.#silentRun) / this.#hopFrames,
        seconds: (this.#silentRun / this.#hopFrames) * HOP_SECONDS,
      });
    }
    this.#silentRun = 0;
  }

  /** Takes one averaged group of samples into the low spectrum's filters. */
  #pushLow(): void {
    this.#dcLeft += this.#groupLeft;
    this.#dcRight += this.#groupRight;
    let left = this.#groupLeft / LOW_GROUP;
    let right = this.#groupRight / LOW_GROUP;
    this.#groupLeft = this.#groupRight = 0;
    this.#groupFill = 0;
    const [leftStages, rightStages] = this.#lowFilters;
    for (let i = 0; i < leftStages.length; i++) {
      left = leftStages[i].next(left);
      right = rightStages[i].next(right);
    }
    if (++this.#lowSkip < this.#lowEvery) return;
    this.#lowSkip = 0;
    this.#lowLeft[this.#lowFill] = left;
    this.#lowRight[this.#lowFill] = right;
    if (++this.#lowFill === SPECTRUM_SIZE) this.#analyseLow();
  }

  /** Reduces four seconds of the low spectrum to the few numbers the check-up needs. */
  #analyseLow(): void {
    const power = new Float64Array(SPECTRUM_SIZE / 2 + 1);
    for (const channel of [this.#lowLeft, this.#lowRight]) {
      for (let i = 0; i < SPECTRUM_SIZE; i++) channel[i] *= this.#window[i];
      this.#imag.fill(0);
      fft(channel, this.#imag);
      // The two channels are added as power, so a hum on one side only still shows.
      for (let k = 0; k < power.length; k++) power[k] += channel[k] * channel[k] + this.#imag[k] * this.#imag[k];
    }
    const binHz = this.#lowRate / SPECTRUM_SIZE;
    const bin = (hz: number) => Math.round(hz / binHz);
    const sum = (from: number, to: number) => {
      let total = 0;
      for (let k = bin(from); k <= bin(to); k++) total += power[k];
      return total;
    };
    const middle = (this.#frame - (SPECTRUM_SIZE * this.#lowEvery * LOW_GROUP) / 2) / this.#hopFrames;
    this.#lowRows.push(middle, sum(3, 18), sum(30, 200));
    for (const tone of MAINS_TONES) {
      let peak = 0;
      for (let k = bin(tone - 0.5); k <= bin(tone + 0.5); k++) peak = Math.max(peak, power[k]);
      // What the spectrum is like just beside the tone, leaving a margin either side of it.
      const beside: number[] = [];
      for (let k = bin(tone - 4); k <= bin(tone + 4); k++) {
        if (Math.abs(k * binHz - tone) >= 1.5) beside.push(power[k]);
      }
      beside.sort((a, b) => a - b);
      this.#lowRows.push(peak, beside[beside.length >> 1]);
    }
    this.#lowFill = 0;
  }

  #analyse(): void {
    const real = this.#capture;
    let energy = 0;
    for (let i = 0; i < SPECTRUM_SIZE; i++) energy += real[i] * real[i];
    if (Math.sqrt(energy / SPECTRUM_SIZE) >= SPECTRUM_MIN_RMS) {
      for (let i = 0; i < SPECTRUM_SIZE; i++) real[i] *= this.#window[i];
      this.#imag.fill(0);
      fft(real, this.#imag);
      for (let k = 0; k < this.#spectrum.length; k++) this.#spectrum[k] += real[k] * real[k] + this.#imag[k] * this.#imag[k];
      this.#captures++;
    }
    this.#captureFill = -1;
    this.#untilCapture = this.#spectrumInterval;
    this.#takeRight = !this.#takeRight;
  }
}
