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

  constructor(sampleRate: number) {
    this.#hopFrames = Math.round(sampleRate * HOP_SECONDS);
    this.#minSilenceFrames = Math.max(1, Math.round(sampleRate * MIN_SILENCE_SECONDS));
    this.#spectrumInterval = Math.round(sampleRate * SPECTRUM_INTERVAL_SECONDS);
    this.#untilCapture = Math.round(sampleRate);
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
