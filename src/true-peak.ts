// True-peak estimation: the highest level the waveform reaches between its
// samples as well as on them, found by interpolating at four times the rate.

const TAPS = 12;
const PHASES = 4;

/** How many samples the estimate lags behind the input. */
export const TRUE_PEAK_DELAY = TAPS / 2;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

/**
 * The three in-between phases of a Kaiser-windowed sinc interpolator, twelve
 * taps each. The fourth phase is the sample itself and needs no filter.
 */
const COEFFICIENTS = (() => {
  const length = TAPS * PHASES + 1;
  const centre = (length - 1) / 2;
  const beta = 6;
  const out = new Float64Array((PHASES - 1) * TAPS);
  for (let phase = 1; phase < PHASES; phase++) {
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const k = PHASES * j + phase;
      const t = (k - centre) / PHASES;
      const window = besselI0(beta * Math.sqrt(1 - ((k - centre) / centre) ** 2)) / besselI0(beta);
      const h = (Math.sin(Math.PI * t) / (Math.PI * t)) * window;
      out[(phase - 1) * TAPS + j] = h;
      sum += h;
    }
    for (let j = 0; j < TAPS; j++) out[(phase - 1) * TAPS + j] /= sum;
  }
  return out;
})();

/**
 * The most the estimate can exceed the largest of the last twelve samples.
 * While they all stay below a level divided by this, so does the true peak.
 */
export const TRUE_PEAK_WORST_CASE = (() => {
  let worst = 1;
  for (let phase = 0; phase < PHASES - 1; phase++) {
    let sum = 0;
    for (let j = 0; j < TAPS; j++) sum += Math.abs(COEFFICIENTS[phase * TAPS + j]);
    worst = Math.max(worst, sum);
  }
  return worst;
})();

export class TruePeakMeter {
  /** The last twelve samples per channel, newest first, stored twice over so a read never wraps. */
  readonly #history: Float64Array;
  readonly #position: Int32Array;

  constructor(channels: number) {
    this.#history = new Float64Array(channels * TAPS * 2);
    this.#position = new Int32Array(channels);
  }

  /** Takes the next sample of a channel without estimating anything. */
  push(channel: number, sample: number): void {
    const base = channel * TAPS * 2;
    const position = this.#position[channel] === 0 ? TAPS - 1 : this.#position[channel] - 1;
    this.#history[base + position] = sample;
    this.#history[base + position + TAPS] = sample;
    this.#position[channel] = position;
  }

  /**
   * Takes the next sample of a channel and returns the true peak of the
   * waveform between the sample `TRUE_PEAK_DELAY` back and the one after it.
   */
  next(channel: number, sample: number): number {
    this.push(channel, sample);
    const history = this.#history;
    const at = channel * TAPS * 2 + this.#position[channel];
    let peak = Math.abs(history[at + TRUE_PEAK_DELAY]);
    for (let phase = 0; phase < PHASES - 1; phase++) {
      const c = phase * TAPS;
      let value = 0;
      for (let j = 0; j < TAPS; j++) value += COEFFICIENTS[c + j] * history[at + j];
      if (value < 0) value = -value;
      if (value > peak) peak = value;
    }
    return peak;
  }
}
