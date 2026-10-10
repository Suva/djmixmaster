// Plays the recording and applies the levelling live:
// audio element -> bass shelf -> gain -> limiter -> speakers.
//
// Most recordings are played by the audio element straight from the file. The
// ones it cannot seek in exactly are streamed instead: each time playback
// starts or jumps, the main process decodes from that position onwards.
import { BASS_SHELF_HZ } from '../../shelf.ts';
import type { MediaSource } from '../api.ts';
import type { LimiterReport, LimiterSettings } from './limiter-worklet.ts';

export class Player {
  onReport: (report: LimiterReport) => void = () => {};
  onPlay: () => void = () => {};
  onPause: () => void = () => {};
  /** The position changed other than by playing on. */
  onSeek: () => void = () => {};

  readonly #audio = new Audio();
  readonly #silent: boolean;
  #source: MediaSource = { url: '', streamed: false };
  #playing = false;
  /** For a streamed recording: where the current stream starts, and whether one is loaded. */
  #streamStart = 0;
  #streamLoaded = false;

  #context: AudioContext | null = null;
  #gain: GainNode | null = null;
  #shelf: BiquadFilterNode | null = null;
  #limiter: AudioWorkletNode | null = null;
  #settings: Required<LimiterSettings> = { ceilingDb: -1, bypass: false };

  /** `silent` runs the whole chain without an output device, for automated checks. */
  constructor(silent: boolean) {
    this.#silent = silent;
    this.#audio.preload = 'auto';
    this.#audio.addEventListener('seeked', () => this.onSeek());
    this.#audio.addEventListener('ended', () => this.#stopped());
  }

  /** Position in the recording, in seconds. */
  get time(): number {
    if (!this.#source.streamed) return this.#audio.currentTime;
    return this.#streamStart + (this.#streamLoaded ? this.#audio.currentTime : 0);
  }

  get paused(): boolean {
    return !this.#playing;
  }

  load(source: MediaSource) {
    this.#audio.pause();
    this.#playing = false;
    this.#source = source;
    this.#streamStart = 0;
    this.#streamLoaded = false;
    if (source.streamed) this.#audio.removeAttribute('src');
    else this.#audio.src = source.url;
    this.#audio.load();
    this.onPause();
  }

  seek(seconds: number) {
    if (!this.#source.streamed) {
      this.#audio.currentTime = seconds;
      return;
    }
    this.#streamStart = seconds;
    this.#streamLoaded = false;
    // A playing stream is replaced by one from the new position.
    if (this.#playing) this.#startStream().catch(() => {});
    this.onSeek();
  }

  async play() {
    await this.#connect();
    await this.#context!.resume();
    this.#playing = true;
    this.onPlay();
    try {
      if (this.#source.streamed && !this.#streamLoaded) await this.#startStream();
      else await this.#audio.play();
    } catch (error) {
      this.#stopped();
      throw error;
    }
  }

  pause() {
    if (this.#source.streamed && this.#streamLoaded) {
      // Let go of the stream; playing again starts a new one from here.
      this.#streamStart = this.time;
      this.#streamLoaded = false;
      this.#audio.pause();
      this.#audio.removeAttribute('src');
      this.#audio.load();
    } else {
      this.#audio.pause();
    }
    this.#stopped();
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

  #stopped() {
    if (!this.#playing) return;
    this.#playing = false;
    this.onPause();
  }

  #startStream() {
    this.#audio.src = `${this.#source.url}?t=${this.#streamStart.toFixed(3)}`;
    this.#streamLoaded = true;
    return this.#audio.play();
  }

  async #connect() {
    if (this.#context) return;
    const context = new AudioContext(this.#silent ? ({ sinkId: { type: 'none' } } as AudioContextOptions) : {});
    await context.audioWorklet.addModule('limiter-worklet.js');
    const source = context.createMediaElementSource(this.#audio);
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
