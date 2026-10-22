// Takes what an audio input gives, in the audio thread, and hands it on to the
// capture page in pieces of a tenth of a second, its channels interleaved.
// Nothing is dropped here: a piece the page is slow to take waits in the
// port's queue.

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new (options: { processorOptions: { channels: number } }) => AudioWorkletProcessor): void;

class CaptureProcessor extends AudioWorkletProcessor {
  readonly #channels: number;
  readonly #frames = Math.round(sampleRate / 10);
  #piece: Float32Array;
  #fill = 0;

  constructor(options: { processorOptions: { channels: number } }) {
    super();
    this.#channels = options.processorOptions.channels;
    this.#piece = new Float32Array(this.#frames * this.#channels);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = this.#channels;
    const frames = input[0].length;
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < channels; c++) this.#piece[this.#fill * channels + c] = (input[c] ?? input[0])[f];
      if (++this.#fill === this.#frames) {
        this.port.postMessage(this.#piece, [this.#piece.buffer]);
        this.#piece = new Float32Array(this.#frames * channels);
        this.#fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
