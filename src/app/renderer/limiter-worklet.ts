// Runs the export limiter live in the audio thread, so the preview sounds like the exported file.
import { Limiter } from '../../limiter.ts';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

const CHANNELS = 2;
/** Frames between level reports to the window. */
const REPORT_FRAMES = 2048;

export interface LimiterSettings {
  ceilingDb?: number;
  bypass?: boolean;
}

export interface LimiterReport {
  /** Highest output sample since the last report, linear. */
  peak: number;
  /** Deepest gain reduction since the last report, as a linear factor (1 = none). */
  gain: number;
}

class LimiterProcessor extends AudioWorkletProcessor {
  #limiter = new Limiter(sampleRate, CHANNELS, -1);
  #bypass = false;
  #interleaved = new Float32Array(128 * CHANNELS);
  #peak = 0;
  #sinceReport = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<LimiterSettings>) => {
      const { ceilingDb, bypass } = event.data;
      if (ceilingDb !== undefined) this.#limiter = new Limiter(sampleRate, CHANNELS, ceilingDb);
      if (bypass !== undefined) this.#bypass = bypass;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const [outLeft, outRight] = outputs[0];
    if (input.length === 0) return true;
    const left = input[0];
    const right = input[1] ?? left;
    const frames = left.length;
    if (this.#interleaved.length !== frames * CHANNELS) this.#interleaved = new Float32Array(frames * CHANNELS);
    const interleaved = this.#interleaved;
    for (let f = 0; f < frames; f++) {
      interleaved[f * 2] = left[f];
      interleaved[f * 2 + 1] = right[f];
    }

    // The limiter keeps running while bypassed so that switching back is seamless.
    const limited = this.#limiter.process(interleaved);
    const source = this.#bypass ? interleaved : limited;
    // Until its look-ahead has filled, the limiter returns fewer frames than it was given.
    const offset = frames - source.length / CHANNELS;
    for (let f = offset; f < frames; f++) {
      const l = source[(f - offset) * 2];
      const r = source[(f - offset) * 2 + 1];
      outLeft[f] = l;
      outRight[f] = r;
      this.#peak = Math.max(this.#peak, Math.abs(l), Math.abs(r));
    }

    this.#sinceReport += frames;
    if (this.#sinceReport >= REPORT_FRAMES) {
      const report: LimiterReport = { peak: this.#peak, gain: this.#bypass ? 1 : this.#limiter.minGain };
      this.port.postMessage(report);
      this.#limiter.minGain = 1;
      this.#peak = 0;
      this.#sinceReport = 0;
    }
    return true;
  }
}

registerProcessor('limiter', LimiterProcessor);
