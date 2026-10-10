// Plays the original file and applies the levelling live:
// media element -> bass shelf -> gain -> limiter -> speakers.
import { BASS_SHELF_HZ } from '../../shelf.ts';
import type { LimiterReport, LimiterSettings } from './limiter-worklet.ts';

export class Player {
  readonly audio = new Audio();
  onReport: (report: LimiterReport) => void = () => {};

  readonly #silent: boolean;
  #context: AudioContext | null = null;
  #gain: GainNode | null = null;
  #shelf: BiquadFilterNode | null = null;
  #limiter: AudioWorkletNode | null = null;
  #settings: Required<LimiterSettings> = { ceilingDb: -1, bypass: false };

  /** `silent` runs the whole chain without an output device, for automated checks. */
  constructor(silent: boolean) {
    this.#silent = silent;
    this.audio.preload = 'auto';
  }

  load(url: string) {
    this.audio.pause();
    this.audio.src = url;
    this.audio.load();
  }

  async play() {
    await this.#connect();
    await this.#context!.resume();
    await this.audio.play();
  }

  /**
   * Sets what is being heard right now. Called every frame during playback;
   * the gain curve moves slowly enough that following it this way is inaudible.
   */
  apply(gain: number, bassDb: number, settings: Required<LimiterSettings>) {
    if (!this.#context || !this.#gain || !this.#shelf || !this.#limiter) return;
    this.#gain.gain.setTargetAtTime(gain, this.#context.currentTime, 0.03);
    this.#shelf.gain.setTargetAtTime(bassDb, this.#context.currentTime, 0.03);
    const changed: LimiterSettings = {};
    if (settings.ceilingDb !== this.#settings.ceilingDb) changed.ceilingDb = settings.ceilingDb;
    if (settings.bypass !== this.#settings.bypass) changed.bypass = settings.bypass;
    if (Object.keys(changed).length) {
      this.#limiter.port.postMessage(changed);
      this.#settings = { ...settings };
    }
  }

  async #connect() {
    if (this.#context) return;
    const context = new AudioContext(this.#silent ? ({ sinkId: { type: 'none' } } as AudioContextOptions) : {});
    await context.audioWorklet.addModule('limiter-worklet.js');
    const source = context.createMediaElementSource(this.audio);
    const gain = context.createGain();
    const shelf = new BiquadFilterNode(context, { type: 'lowshelf', frequency: BASS_SHELF_HZ, gain: 0 });
    const limiter = new AudioWorkletNode(context, 'limiter', {
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
    });
    limiter.port.onmessage = (event: MessageEvent<LimiterReport>) => this.onReport(event.data);
    limiter.port.postMessage(this.#settings);
    source.connect(shelf).connect(gain).connect(limiter).connect(context.destination);
    this.#context = context;
    this.#gain = gain;
    this.#shelf = shelf;
    this.#limiter = limiter;
  }
}
