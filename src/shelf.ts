/** Corner of the bass correction shelf; the measured low band sits well below it. */
export const BASS_SHELF_HZ = 180;

/**
 * Low-shelf filter whose gain can be moved while it runs. Uses the same
 * formulas as the Web Audio "lowshelf" filter, so the live preview and the
 * export sound alike.
 */
export class LowShelf {
  readonly #channels: number;
  readonly #cos: number;
  readonly #alpha: number;
  /** z1, z2 per channel. */
  readonly #state: Float64Array;
  #b0 = 1;
  #b1 = 0;
  #b2 = 0;
  #a1 = 0;
  #a2 = 0;

  constructor(sampleRate: number, channels: number) {
    this.#channels = channels;
    const omega = (2 * Math.PI * BASS_SHELF_HZ) / sampleRate;
    this.#cos = Math.cos(omega);
    this.#alpha = (Math.sin(omega) / 2) * Math.SQRT2;
    this.#state = new Float64Array(channels * 2);
  }

  /** Sets the gain below the corner. Meant to be moved in small steps. */
  setGain(gainDb: number): void {
    const a = Math.pow(10, gainDb / 40);
    const cos = this.#cos;
    const beta = 2 * this.#alpha * Math.sqrt(a);
    const a0 = a + 1 + (a - 1) * cos + beta;
    this.#b0 = (a * (a + 1 - (a - 1) * cos + beta)) / a0;
    this.#b1 = (2 * a * (a - 1 - (a + 1) * cos)) / a0;
    this.#b2 = (a * (a + 1 - (a - 1) * cos - beta)) / a0;
    this.#a1 = (-2 * (a - 1 + (a + 1) * cos)) / a0;
    this.#a2 = (a + 1 + (a - 1) * cos - beta) / a0;
  }

  /** Filters frames `from` to `to` of interleaved samples in place. */
  process(samples: Float32Array, from: number, to: number): void {
    const channels = this.#channels;
    const b0 = this.#b0, b1 = this.#b1, b2 = this.#b2, a1 = this.#a1, a2 = this.#a2;
    for (let c = 0; c < channels; c++) {
      let z1 = this.#state[c * 2];
      let z2 = this.#state[c * 2 + 1];
      for (let i = from * channels + c; i < to * channels; i += channels) {
        const x = samples[i];
        const y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        samples[i] = y;
      }
      this.#state[c * 2] = Math.abs(z1) < 1e-30 ? 0 : z1;
      this.#state[c * 2 + 1] = Math.abs(z2) < 1e-30 ? 0 : z2;
    }
  }
}
