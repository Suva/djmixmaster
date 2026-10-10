/**
 * Look-ahead peak limiter with linked channels. The gain reduction a peak needs
 * is held for the look-ahead time and then averaged over it, so the gain has
 * always finished moving by the time the peak arrives and no sample exceeds the
 * ceiling. Output is time aligned with the input: the look-ahead delay is
 * swallowed at the start and paid back by `flush()`.
 */
export class Limiter {
  /** Deepest gain reduction applied so far, as a linear factor. */
  minGain = 1;

  readonly #channels: number;
  readonly #ceiling: number;
  readonly #lookahead: number;
  readonly #releaseCoef: number;

  readonly #delay: Float32Array;
  #pos = 0;
  #pending: number;

  // Monotonic queue for the sliding minimum of the required gain.
  readonly #queueGain: Float64Array;
  readonly #queueIndex: Float64Array;
  #queueHead = 0;
  #queueTail = 0;
  #index = 0;

  #envelope = 1;
  readonly #average: Float64Array;
  #averageSum: number;

  constructor(sampleRate: number, channels: number, ceilingDb: number, lookaheadMs = 5, releaseMs = 150) {
    this.#channels = channels;
    this.#ceiling = Math.pow(10, ceilingDb / 20);
    this.#lookahead = Math.max(1, Math.round((sampleRate * lookaheadMs) / 1000));
    this.#releaseCoef = Math.exp(-1 / ((sampleRate * releaseMs) / 1000));
    this.#delay = new Float32Array(this.#lookahead * channels);
    this.#pending = this.#lookahead;
    this.#queueGain = new Float64Array(this.#lookahead + 2);
    this.#queueIndex = new Float64Array(this.#lookahead + 2);
    this.#average = new Float64Array(this.#lookahead).fill(1);
    this.#averageSum = this.#lookahead;
  }

  process(input: Float32Array): Float32Array {
    const channels = this.#channels;
    const lookahead = this.#lookahead;
    const ceiling = this.#ceiling;
    const capacity = this.#queueGain.length;
    const frames = input.length / channels;
    const skip = Math.min(this.#pending, frames);
    this.#pending -= skip;
    const output = new Float32Array((frames - skip) * channels);
    let written = 0;

    for (let f = 0; f < frames; f++) {
      const at = f * channels;
      let peak = 0;
      for (let c = 0; c < channels; c++) {
        const abs = Math.abs(input[at + c]);
        if (abs > peak) peak = abs;
      }
      const required = peak > ceiling ? ceiling / peak : 1;

      // Sliding minimum over this frame and the `lookahead` frames before it.
      while (this.#queueHead !== this.#queueTail) {
        const last = (this.#queueTail + capacity - 1) % capacity;
        if (this.#queueGain[last] < required) break;
        this.#queueTail = last;
      }
      this.#queueGain[this.#queueTail] = required;
      this.#queueIndex[this.#queueTail] = this.#index;
      this.#queueTail = (this.#queueTail + 1) % capacity;
      if (this.#queueIndex[this.#queueHead] < this.#index - lookahead) {
        this.#queueHead = (this.#queueHead + 1) % capacity;
      }
      this.#index++;
      const held = this.#queueGain[this.#queueHead];

      // Instant attack onto the held minimum, exponential release back to unity.
      const released = 1 - (1 - this.#envelope) * this.#releaseCoef;
      this.#envelope = held < released ? held : released;

      const slot = this.#pos;
      this.#averageSum += this.#envelope - this.#average[slot];
      this.#average[slot] = this.#envelope;
      const gain = Math.min(1, this.#averageSum / lookahead);
      if (gain < this.minGain) this.minGain = gain;

      const delayAt = slot * channels;
      if (f >= skip) {
        for (let c = 0; c < channels; c++) {
          const y = this.#delay[delayAt + c] * gain;
          // The running sum can drift by a few ulps; never let that through.
          output[written++] = y > ceiling ? ceiling : y < -ceiling ? -ceiling : y;
        }
      }
      for (let c = 0; c < channels; c++) this.#delay[delayAt + c] = input[at + c];
      this.#pos = slot + 1 === lookahead ? 0 : slot + 1;
    }
    return output;
  }

  /** Returns the tail still held in the look-ahead delay. */
  flush(): Float32Array {
    const held = this.#lookahead - this.#pending;
    this.#pending = 0;
    const tail = this.process(new Float32Array(this.#lookahead * this.#channels));
    return tail.subarray((this.#lookahead - held) * this.#channels);
  }
}
