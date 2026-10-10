import { TRUE_PEAK_DELAY, TRUE_PEAK_WORST_CASE, TruePeakMeter } from './true-peak.ts';

/**
 * Look-ahead true-peak limiter with linked channels. The gain reduction a peak
 * needs is held for the look-ahead time and then averaged over it, so the gain
 * has always finished moving by the time the peak arrives. Peaks are measured
 * between the samples as well as on them, so the ceiling also holds once the
 * audio is turned back into a waveform. Output is time aligned with the input:
 * the delay is swallowed at the start and paid back by `flush()`.
 */
export class Limiter {
  /** Deepest gain reduction applied so far, as a linear factor. */
  minGain = 1;

  readonly #channels: number;
  readonly #ceiling: number;
  /** Frames over which the gain moves ahead of a peak. */
  readonly #lookahead: number;
  /** Frames the audio is held back: the look-ahead plus the lag of the peak estimate. */
  readonly #delayFrames: number;
  readonly #releaseCoef: number;
  readonly #truePeak: TruePeakMeter;
  /** Samples below this cannot add up to a true peak above the ceiling. */
  readonly #quiet: number;
  /** Frames left for which recent samples were loud enough to need the full estimate. */
  #loudFor = 0;

  readonly #delay: Float32Array;
  #delayPos = 0;
  #pending: number;

  // Monotonic queue for the sliding minimum of the required gain.
  readonly #queueGain: Float64Array;
  readonly #queueIndex: Float64Array;
  #queueHead = 0;
  #queueTail = 0;
  #index = 0;

  #envelope = 1;
  readonly #average: Float64Array;
  #averagePos = 0;
  #averageSum: number;

  constructor(sampleRate: number, channels: number, ceilingDb: number, lookaheadMs = 5, releaseMs = 150) {
    this.#channels = channels;
    this.#ceiling = Math.pow(10, ceilingDb / 20);
    this.#lookahead = Math.max(1, Math.round((sampleRate * lookaheadMs) / 1000));
    this.#delayFrames = this.#lookahead + TRUE_PEAK_DELAY;
    this.#releaseCoef = Math.exp(-1 / ((sampleRate * releaseMs) / 1000));
    this.#truePeak = new TruePeakMeter(channels);
    this.#quiet = this.#ceiling / TRUE_PEAK_WORST_CASE;
    this.#delay = new Float32Array(this.#delayFrames * channels);
    this.#pending = this.#delayFrames;
    this.#queueGain = new Float64Array(this.#delayFrames + 2);
    this.#queueIndex = new Float64Array(this.#delayFrames + 2);
    this.#average = new Float64Array(this.#lookahead).fill(1);
    this.#averageSum = this.#lookahead;
  }

  process(input: Float32Array): Float32Array {
    const channels = this.#channels;
    const lookahead = this.#lookahead;
    const delayFrames = this.#delayFrames;
    const ceiling = this.#ceiling;
    const quiet = this.#quiet;
    const truePeak = this.#truePeak;
    const capacity = this.#queueGain.length;
    const frames = input.length / channels;
    const skip = Math.min(this.#pending, frames);
    this.#pending -= skip;
    const output = new Float32Array((frames - skip) * channels);
    let written = 0;

    for (let f = 0; f < frames; f++) {
      const at = f * channels;
      // The estimate is only worth its cost while recent samples are loud
      // enough to possibly add up to something above the ceiling.
      for (let c = 0; c < channels; c++) {
        if (Math.abs(input[at + c]) > quiet) this.#loudFor = TRUE_PEAK_DELAY * 2;
      }
      let peak = 0;
      if (this.#loudFor > 0) {
        this.#loudFor--;
        for (let c = 0; c < channels; c++) {
          const estimate = truePeak.next(c, input[at + c]);
          if (estimate > peak) peak = estimate;
        }
      } else {
        for (let c = 0; c < channels; c++) truePeak.push(c, input[at + c]);
      }
      // This is the gain the audio from `TRUE_PEAK_DELAY` frames ago needs.
      const required = peak > ceiling ? ceiling / peak : 1;

      // Sliding minimum over this frame and the `delayFrames` frames before it.
      while (this.#queueHead !== this.#queueTail) {
        const last = (this.#queueTail + capacity - 1) % capacity;
        if (this.#queueGain[last] < required) break;
        this.#queueTail = last;
      }
      this.#queueGain[this.#queueTail] = required;
      this.#queueIndex[this.#queueTail] = this.#index;
      this.#queueTail = (this.#queueTail + 1) % capacity;
      if (this.#queueIndex[this.#queueHead] < this.#index - delayFrames) {
        this.#queueHead = (this.#queueHead + 1) % capacity;
      }
      this.#index++;
      const held = this.#queueGain[this.#queueHead];

      // Instant attack onto the held minimum, exponential release back to unity.
      const released = 1 - (1 - this.#envelope) * this.#releaseCoef;
      this.#envelope = held < released ? held : released;

      const slot = this.#averagePos;
      this.#averageSum += this.#envelope - this.#average[slot];
      this.#average[slot] = this.#envelope;
      this.#averagePos = slot + 1 === lookahead ? 0 : slot + 1;
      const gain = Math.min(1, this.#averageSum / lookahead);
      if (gain < this.minGain) this.minGain = gain;

      const delayAt = this.#delayPos * channels;
      if (f >= skip) {
        for (let c = 0; c < channels; c++) {
          const y = this.#delay[delayAt + c] * gain;
          // The running sum can drift by a few ulps; never let that through.
          output[written++] = y > ceiling ? ceiling : y < -ceiling ? -ceiling : y;
        }
      }
      for (let c = 0; c < channels; c++) this.#delay[delayAt + c] = input[at + c];
      this.#delayPos = this.#delayPos + 1 === delayFrames ? 0 : this.#delayPos + 1;
    }
    return output;
  }

  /** Returns the tail still held in the delay. */
  flush(): Float32Array {
    const held = this.#delayFrames - this.#pending;
    this.#pending = 0;
    const tail = this.process(new Float32Array(this.#delayFrames * this.#channels));
    return tail.subarray((this.#delayFrames - held) * this.#channels);
  }
}
