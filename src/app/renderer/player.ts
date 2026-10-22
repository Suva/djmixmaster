// Plays the recording and applies the levelling live:
// audio element -> channel fix -> EQ -> bass shelf -> gain -> limiter -> fade -> speakers.
//
// Most recordings are played by the audio element straight from the file. The
// ones it cannot seek in exactly are streamed instead: each time playback
// starts or jumps, the main process decodes from that position onwards.
import { UNMIXED, type ChannelMix } from '../../channels.ts';
import { BASS_SHELF_HZ } from '../../shelf.ts';
import { eqFilters, FLAT_EQ, type Eq } from '../../eq.ts';
import type { MediaSource } from '../api.ts';
import type { LimiterReport, LimiterSettings } from './limiter-worklet.ts';

/** How long after the last jump a streamed recording starts playing again from the new place. */
const STREAM_RESTART_MS = 150;

export class Player {
  onReport: (report: LimiterReport) => void = () => {};
  onPlay: () => void = () => {};
  onPause: () => void = () => {};
  /** The position changed other than by playing on. */
  onSeek: () => void = () => {};

  readonly #audio = new Audio();
  readonly #silent: boolean;
  #source: MediaSource = { url: '', streamed: false, video: null };
  #playing = false;
  /** For a streamed recording: where the current stream starts, and whether one is loaded. */
  #streamStart = 0;
  #streamLoaded = false;
  #restart: ReturnType<typeof setTimeout> | undefined;

  #context: AudioContext | null = null;
  #connecting: Promise<void> | null = null;
  #gain: GainNode | null = null;
  #shelf: BiquadFilterNode | null = null;
  #limiter: AudioWorkletNode | null = null;
  #fade: GainNode | null = null;
  #meters: [AnalyserNode, AnalyserNode] | null = null;
  /** A fix for the recording's channels: four gains, from each channel in to each channel out. */
  #channels: { ll: GainNode; lr: GainNode; rl: GainNode; rr: GainNode } | null = null;
  #mix: ChannelMix = UNMIXED;
  /** The selected mix's EQ: always the same five filters, whose settings change. */
  #eqNodes: BiquadFilterNode[] = [];
  #eq: Eq = FLAT_EQ;
  /** Listens in after the EQ, for the analyser drawn behind it: what the EQ has made of the sound, before the levelling moves it. */
  #rta: AnalyserNode | null = null;
  #rtaData: Float32Array<ArrayBuffer> | null = null;
  readonly #heard = new Float32Array(2048);
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

  get rate(): number {
    return this.#audio.playbackRate;
  }

  /** How fast it plays: 1 is as recorded, 2 twice as fast. Above 4 the browser plays no sound. */
  set rate(rate: number) {
    // Both, or the next stream of a streamed recording would start at the old speed.
    this.#audio.defaultPlaybackRate = rate;
    this.#audio.playbackRate = rate;
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

  /** Lets go of the recording, when it is closed. */
  unload() {
    this.load({ url: '', streamed: true, video: null });
  }

  seek(seconds: number) {
    if (!this.#source.streamed) {
      this.#audio.currentTime = seconds;
      return;
    }
    this.#streamStart = seconds;
    this.#streamLoaded = false;
    // A playing stream is replaced by one from the new position, but only once
    // the jumping has stopped: holding a button down jumps many times a second.
    if (this.#playing) {
      this.#audio.pause();
      clearTimeout(this.#restart);
      this.#restart = setTimeout(() => {
        if (this.#playing && !this.#streamLoaded) this.#startStream().catch(() => {});
      }, STREAM_RESTART_MS);
    }
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
  /** Puts the recording's channels right as heard, before anything else: the same mix the export applies. */
  setChannels(mix: ChannelMix) {
    this.#mix = mix;
    if (!this.#channels) return;
    for (const key of ['ll', 'lr', 'rl', 'rr'] as const) this.#channels[key].gain.value = mix[key];
  }

  /** The EQ heard, the one the export applies after the channel fix; undefined is flat. */
  setEq(eq: Eq | undefined) {
    const next = eq ?? FLAT_EQ;
    if (JSON.stringify(next) === JSON.stringify(this.#eq)) return;
    this.#eq = next;
    if (!this.#context) return;
    // Glided over a moment, as a slider moves it, so that it does not click.
    const at = this.#context.currentTime;
    eqFilters(next).forEach((filter, i) => {
      const node = this.#eqNodes[i];
      node.frequency.setTargetAtTime(filter.frequency, at, 0.02);
      node.gain.setTargetAtTime(filter.gain, at, 0.02);
    });
  }

  apply(gain: number, bassDb: number, fade: number, settings: Required<LimiterSettings>) {
    if (!this.#context || !this.#gain || !this.#shelf || !this.#limiter || !this.#fade) return;
    this.#gain.gain.setTargetAtTime(gain, this.#context.currentTime, 0.03);
    this.#fade.gain.setTargetAtTime(fade, this.#context.currentTime, 0.015);
    this.#shelf.gain.setTargetAtTime(bassDb, this.#context.currentTime, 0.03);
    const changed: LimiterSettings = {};
    if (settings.ceilingDb !== this.#settings.ceilingDb) changed.ceilingDb = settings.ceilingDb;
    if (settings.bypass !== this.#settings.bypass) changed.bypass = settings.bypass;
    if (Object.keys(changed).length) {
      this.#limiter.port.postMessage(changed);
      this.#settings = { ...settings };
    }
  }

  /**
   * The spectrum of the last moment after the EQ, in dB per bin up to half
   * the sample rate, and that rate; null before anything has played.
   */
  spectrum(): { db: Float32Array; sampleRate: number } | null {
    if (!this.#rta || !this.#rtaData || !this.#context) return null;
    this.#rta.getFloatFrequencyData(this.#rtaData);
    return { db: this.#rtaData, sampleRate: this.#context.sampleRate };
  }

  /** The highest level in the last moment of what reached the left and the right speaker, linear. */
  outputPeaks(): [number, number] {
    if (!this.#meters) return [0, 0];
    return this.#meters.map((meter) => {
      meter.getFloatTimeDomainData(this.#heard);
      let peak = 0;
      for (const sample of this.#heard) peak = Math.max(peak, Math.abs(sample));
      return peak;
    }) as [number, number];
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

  /** Builds the chain on first use. Two presses in quick succession must not build it twice. */
  #connect(): Promise<void> {
    this.#connecting ??= this.#build();
    return this.#connecting;
  }

  async #build() {
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
    const fade = context.createGain();
    // Listens in on what goes to each speaker, after everything else.
    const split = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
    const meters: [AnalyserNode, AnalyserNode] = [
      new AnalyserNode(context, { fftSize: this.#heard.length }),
      new AnalyserNode(context, { fftSize: this.#heard.length }),
    ];
    // The channels first: each one out made of both in, as the fix for the recording says.
    const apart = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
    const together = new ChannelMergerNode(context, { numberOfInputs: 2 });
    const channels = {
      ll: new GainNode(context, { gain: this.#mix.ll }),
      lr: new GainNode(context, { gain: this.#mix.lr }),
      rl: new GainNode(context, { gain: this.#mix.rl }),
      rr: new GainNode(context, { gain: this.#mix.rr }),
    };
    // Always two channels into the splitter: a mono recording spread to both, as speakers would play it.
    const stereo = new GainNode(context, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    source.connect(stereo).connect(apart);
    apart.connect(channels.ll, 0).connect(together, 0, 0);
    apart.connect(channels.lr, 1).connect(together, 0, 0);
    apart.connect(channels.rl, 0).connect(together, 0, 1);
    apart.connect(channels.rr, 1).connect(together, 0, 1);
    const eqNodes = eqFilters(this.#eq).map((filter) => new BiquadFilterNode(context, filter));
    let last: AudioNode = together;
    for (const node of eqNodes) last = last.connect(node);
    this.#eqNodes = eqNodes;
    // Long enough to tell 30 Hz from 40; the window averages what it shows over time itself.
    this.#rta = new AnalyserNode(context, { fftSize: 8192, smoothingTimeConstant: 0 });
    this.#rtaData = new Float32Array(this.#rta.frequencyBinCount);
    last.connect(this.#rta);
    last.connect(shelf).connect(gain).connect(limiter).connect(fade).connect(context.destination);
    this.#channels = channels;
    fade.connect(split);
    split.connect(meters[0], 0);
    split.connect(meters[1], 1);
    this.#context = context;
    this.#gain = gain;
    this.#shelf = shelf;
    this.#limiter = limiter;
    this.#fade = fade;
    this.#meters = meters;
  }
}
