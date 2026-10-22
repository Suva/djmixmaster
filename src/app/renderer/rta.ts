// The analyser drawn behind the EQ: the spectrum of what is playing, after
// the EQ, averaged over a second or two so that it shows the balance of the
// sound rather than each kick and hi-hat, and smoothed to a third of an
// octave so that it reads as a line rather than grass.

/** How long the average takes to follow a change, in seconds. */
const AVERAGE_SECONDS = 1.5;
/** How wide a stretch of the spectrum each point of the line stands for, in octaves. */
const SMOOTHING_OCTAVES = 1 / 3;

export class Rta {
  /** Power per bin, averaged over time; null until something has played. */
  #power: Float64Array | null = null;
  #sampleRate = 0;
  #last = 0;

  /** Starts again, as for another mix. */
  reset() {
    this.#power = null;
  }

  get empty(): boolean {
    return this.#power === null;
  }

  /** Takes in the spectrum of the moment, in dB per bin, at `now` in milliseconds. */
  update(spectrum: { db: Float32Array; sampleRate: number }, now: number) {
    const { db, sampleRate } = spectrum;
    if (!this.#power || this.#power.length !== db.length || this.#sampleRate !== sampleRate) {
      this.#power = Float64Array.from(db, (value) => Math.pow(10, value / 10));
      this.#sampleRate = sampleRate;
      this.#last = now;
      return;
    }
    // A pause or a jump in time does not count as time to average over.
    const elapsed = Math.min(0.1, Math.max(0, (now - this.#last) / 1000));
    this.#last = now;
    const share = 1 - Math.exp(-elapsed / AVERAGE_SECONDS);
    const power = this.#power;
    for (let k = 0; k < db.length; k++) {
      const value = db[k] > -200 ? Math.pow(10, db[k] / 10) : 0;
      power[k] += share * (value - power[k]);
    }
  }

  /**
   * The averaged spectrum as energy per octave in dB, as the analysis's bands
   * are drawn, at each of `frequencies`; null until something has played.
   */
  line(frequencies: Float64Array): Float64Array | null {
    const power = this.#power;
    if (!power) return null;
    const binHz = this.#sampleRate / 2 / power.length;
    const half = Math.pow(2, SMOOTHING_OCTAVES / 2);
    return frequencies.map((hz) => {
      const from = Math.max(1, Math.ceil(hz / half / binHz));
      const to = Math.min(power.length - 1, Math.floor((hz * half) / binHz));
      let sum = 0;
      let count = 0;
      for (let k = from; k <= to; k++, count++) sum += power[k];
      // Low down, a third of an octave is narrower than a bin: the nearest one stands for it.
      if (count === 0) {
        sum = power[Math.min(power.length - 1, Math.max(1, Math.round(hz / binHz)))];
        count = 1;
      }
      // Power per Hz, times the Hz in an octave there.
      return 10 * Math.log10(Math.max((sum / count / binHz) * hz * Math.LN2, 1e-20));
    });
  }
}
