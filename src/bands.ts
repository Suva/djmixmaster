// How each 100 ms block's energy is spread over the spectrum, in a few broad
// bands. It is what lets an EQ's effect on the loudness, the low band and the
// peaks be worked out from the analysis, without decoding the recording again.
// Free of Node imports.

import { HOP_SECONDS } from './loudness.ts';

/**
 * The edges between the bands, in Hz. Narrow at the bottom, where a rumble
 * filter and the low band's corner sit close together, and an octave or two
 * wide above, where the EQ's filters are broad.
 */
export const BAND_EDGES_HZ = [30, 45, 65, 90, 125, 180, 250, 500, 1000, 2000, 4000, 8000];
export const BANDS = BAND_EDGES_HZ.length + 1;

/** Which band each frequency bin of an FFT of `size` points falls in. */
function bandOfBin(size: number, sampleRate: number): Uint8Array {
  const bands = new Uint8Array(size / 2 + 1);
  for (let k = 0, band = 0; k < bands.length; k++) {
    const hz = (k * sampleRate) / size;
    while (band < BAND_EDGES_HZ.length && hz >= BAND_EDGES_HZ[band]) band++;
    bands[k] = band;
  }
  return bands;
}

/** How many 100 ms blocks share one measurement of the bands. */
export const BLOCKS_PER_BAND_FRAME = 4;

/**
 * Streaming meter: feed interleaved stereo samples, get for every four blocks
 * the energy in each band, unweighted and summed over both channels. Each
 * measurement is a transform of the middle 200 ms or so of its four blocks:
 * long enough to tell the low bands apart, and at half the cost of covering
 * every moment, which would add half as much again to the time an analysis
 * takes. The loudness the bands are used for is a 3 s average, which this
 * samples well enough. The frames line up with `BlockEnergyMeter`'s blocks.
 * Their bands add up to about the energy of what was measured; what matters
 * is how it divides between them.
 */
export class BandMeter {
  readonly #frameLength: number;
  readonly #size: number;
  /** Where in a frame the transformed stretch starts: the middle of it is taken when it is longer. */
  readonly #offset: number;
  readonly #window: Float64Array;
  readonly #bandOf: Uint8Array;
  readonly #cos: Float64Array;
  readonly #sin: Float64Array;
  /** The pairs of places the transform's bit-reversed order swaps. */
  readonly #swaps: Uint32Array;
  /** The frame being gathered: left as the real part, right as the imaginary one, as one complex transform does both. */
  readonly #real: Float64Array;
  readonly #imag: Float64Array;
  /** How much of the frame has come in. */
  #fill = 0;
  readonly #energies: number[] = [];
  readonly #scale: number;

  constructor(sampleRate: number) {
    this.#frameLength = Math.round(sampleRate * HOP_SECONDS) * BLOCKS_PER_BAND_FRAME;
    let size = 1;
    while (size * 4 <= this.#frameLength) size <<= 1;
    this.#size = size;
    this.#offset = (this.#frameLength - size) >> 1;
    this.#window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / size));
    this.#bandOf = bandOfBin(size, sampleRate);
    this.#cos = Float64Array.from({ length: size / 2 }, (_, k) => Math.cos((-2 * Math.PI * k) / size));
    this.#sin = Float64Array.from({ length: size / 2 }, (_, k) => Math.sin((-2 * Math.PI * k) / size));
    const swaps: number[] = [];
    for (let i = 1, j = 0; i < size; i++) {
      let bit = size >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) swaps.push(i, j);
    }
    this.#swaps = Uint32Array.from(swaps);
    this.#real = new Float64Array(size);
    this.#imag = new Float64Array(size);
    // Parseval, and the Hann window keeping 3/8 of the power: the bands then add up to the mean square.
    this.#scale = 1 / (size * size * 0.375);
  }

  push(samples: Float32Array): void {
    const frames = samples.length / 2;
    const real = this.#real, imag = this.#imag, window = this.#window;
    const offset = this.#offset, size = this.#size;
    let frame = 0;
    while (frame < frames) {
      const count = Math.min(frames - frame, this.#frameLength - this.#fill);
      // Only the stretch the transform takes is kept, windowed as it comes in.
      const from = Math.max(this.#fill, offset), to = Math.min(this.#fill + count, offset + size);
      for (let at = from, i = (frame + from - this.#fill) * 2; at < to; at++, i += 2) {
        const w = window[at - offset];
        real[at - offset] = samples[i] * w;
        imag[at - offset] = samples[i + 1] * w;
      }
      this.#fill += count;
      frame += count;
      if (this.#fill === this.#frameLength) this.#analyse();
    }
  }

  /**
   * Energy per band, `BANDS` values for each four blocks. A last frame of
   * fewer is left out; whoever reads the bands uses the one before.
   */
  bands(): Float32Array {
    return Float32Array.from(this.#energies);
  }

  #analyse() {
    const real = this.#real, imag = this.#imag, size = this.#size;
    this.#fft();
    const sums = new Float64Array(BANDS);
    // With left as the real part and right as the imaginary one, the power of
    // both channels at bin k is half of |X(k)|² + |X(size - k)|²; counting both
    // sides of the spectrum doubles it again.
    sums[this.#bandOf[0]] += real[0] * real[0] + imag[0] * imag[0];
    for (let k = 1; k < size / 2; k++) {
      const j = size - k;
      sums[this.#bandOf[k]] += real[k] * real[k] + imag[k] * imag[k] + real[j] * real[j] + imag[j] * imag[j];
    }
    const half = size / 2;
    sums[this.#bandOf[half]] += real[half] * real[half] + imag[half] * imag[half];
    for (let b = 0; b < BANDS; b++) this.#energies.push(sums[b] * this.#scale);
    this.#fill = 0;
  }

  /** In-place FFT of `#real` and `#imag`. */
  #fft() {
    const real = this.#real, imag = this.#imag, n = this.#size;
    const swaps = this.#swaps;
    for (let s = 0; s < swaps.length; s += 2) {
      const i = swaps[s], j = swaps[s + 1];
      let t = real[i]; real[i] = real[j]; real[j] = t;
      t = imag[i]; imag[i] = imag[j]; imag[j] = t;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const stride = n / size;
      // Each twiddle is looked up once per stage, not once per butterfly.
      for (let k = 0; k < half; k++) {
        const cos = this.#cos[k * stride];
        const sin = this.#sin[k * stride];
        for (let start = 0; start < n; start += size) {
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
}
