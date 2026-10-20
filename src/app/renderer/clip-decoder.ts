// Decodes a video layer's clip for an export with the browser's own video
// decoder, on the graphics card where there is one. The main process serves
// the clip's picture as it is stored (serveClip in main.ts), from the keyframe
// before where it is wanted; here each frame is decoded and the one for each
// moment picked by its time. Having ffmpeg decode and scale every frame and
// pass it over as raw pixels, as is done for clips the decoder will not take
// (see ExportVideos in video-sources.ts), takes several times as long.

import type { VideoPicture } from '../../visuals/draw.ts';
import { Mp4Reader, type Mp4Track } from './mp4-packets.ts';

/**
 * How far past a frame's time a moment may be and still be before it: the
 * times of some files are kept to the millisecond, so a frame of a 30 fps
 * clip meant for 66.667 ms is at 67.
 */
const LEEWAY_US = 1000;
/** How far ahead of what has been decoded a clip may be wanted before it is started again from there, rather than decoded on to it. */
const FAR_US = 3_000_000;
/** Decoded frames held at most, the one shown among them: enough to decode ahead while a frame is drawn, few enough that memory stays flat. */
const HELD = 4;
/** Compressed frames waiting in the decoder at most. */
const QUEUED = 8;

/** The decoder cannot take this clip: it is for ffmpeg to decode. */
export class NotDecodable extends Error {}

/** Set for a check (DJMASTER_DECODER=ffmpeg): every clip is taken as one the browser cannot decode. */
let refusing = false;
export const refuseEveryClip = () => (refusing = true);

/** The settings each codec and size was found to work with, or null for none: asked of the browser once. */
const configs = new Map<string, Promise<VideoDecoderConfig | null>>();

/** The settings to decode a track with: on the graphics card if it can be, else in software; null if neither. */
function configFor(track: Mp4Track, rotation: number): Promise<VideoDecoderConfig | null> {
  if (refusing) return Promise.resolve(null);
  const key = JSON.stringify([track.codec, track.codedWidth, track.codedHeight, track.colorSpace, rotation]);
  let found = configs.get(key);
  if (!found) {
    found = (async () => {
      const base: VideoDecoderConfig = {
        codec: track.codec,
        codedWidth: track.codedWidth,
        codedHeight: track.codedHeight,
        // Each frame as soon as it is decoded, rather than a few held back.
        optimizeForLatency: true,
        ...(track.description ? { description: track.description } : {}),
        ...(track.colorSpace ? { colorSpace: track.colorSpace } : {}),
        ...(rotation ? { rotation } : {}),
      };
      for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
        const config = { ...base, hardwareAcceleration };
        const support = await VideoDecoder.isConfigSupported(config).catch(() => null);
        // A turn the browser does not know is left out of what it says it supports: ffmpeg turns such a clip.
        if (support?.supported && (!rotation || (support.config as { rotation?: number } | undefined)?.rotation === rotation)) return config;
      }
      return null;
    })();
    configs.set(key, found);
  }
  return found;
}

/**
 * One reading of a clip from a point: the compressed frames streamed in,
 * decoded, and held in order of their time until they are passed.
 */
class Session {
  /** Decoded frames in order of their time, the first the one shown. */
  readonly frames: VideoFrame[] = [];
  /** Microseconds into the clip it was asked to start at. */
  readonly from: number;
  /** The latest time of a frame given to the decoder. */
  fed = -Infinity;
  /** Frames decoded so far. */
  decoded = 0;
  /** A frame has been let go as passed: the first one held is no longer the first of the reading. */
  movedOn = false;
  /** Every frame of the clip from `from` has been decoded. */
  done = false;
  error: unknown = null;
  closed = false;
  readonly #decoder: VideoDecoder;
  #stream: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #waiting: (() => void)[] = [];

  constructor(path: string, from: number, rotation: number) {
    this.from = from * 1e6;
    this.#decoder = new VideoDecoder({
      output: (frame) => {
        // Nothing comes out of order, but a frame from before one already shown would be one too late.
        if (this.closed || (this.movedOn && frame.timestamp < this.frames[0]?.timestamp)) return frame.close();
        let at = this.frames.length;
        while (at > 0 && this.frames[at - 1].timestamp > frame.timestamp) at--;
        this.frames.splice(at, 0, frame);
        this.decoded++;
        this.changed();
      },
      error: (error) => {
        this.error ??= error;
        this.changed();
      },
    });
    this.#decoder.addEventListener('dequeue', () => this.changed());
    this.#read(path, from, rotation).then(
      () => (this.done = true),
      (error) => (this.error ??= error),
    ).finally(() => this.changed());
  }

  /** Something has changed: a frame decoded or let go, the end reached, a failure. */
  changed() {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const wake of waiting) wake();
  }

  /** Waits for the next change. */
  next(): Promise<void> {
    return new Promise((wake) => this.#waiting.push(wake));
  }

  async #read(path: string, from: number, rotation: number) {
    const response = await fetch(`djm://app/clip?${new URLSearchParams({ path, from: String(from) })}`);
    if (!response.ok || !response.body) throw new NotDecodable('The clip could not be read as it is stored');
    this.#stream = response.body.getReader();
    if (this.closed) return this.#stream.cancel().catch(() => {});
    const mp4 = new Mp4Reader();
    let configured = false;
    let keyed = false;
    for (;;) {
      const { value, done } = await this.#stream.read();
      if (this.closed) return;
      if (done) break;
      mp4.push(value);
      for (const item of mp4.take()) {
        if ('codec' in item) {
          // The next file of a recording in several: what came before is decoded out, and the decoder set up anew.
          if (configured) await this.#decoder.flush();
          const config = await configFor(item, rotation);
          if (!config) throw new NotDecodable(`The browser cannot decode ${item.codec}`);
          if (this.closed) return;
          this.#decoder.configure(config);
          configured = true;
          keyed = false;
          continue;
        }
        // Decoding starts on a keyframe; ffmpeg starts each file on one, but in case it does not.
        keyed ||= item.key;
        if (!configured || !keyed) continue;
        while (!this.closed && (this.#decoder.decodeQueueSize >= QUEUED || this.frames.length >= HELD)) await this.next();
        if (this.closed) return;
        this.#decoder.decode(new EncodedVideoChunk({ type: item.key ? 'key' : 'delta', timestamp: item.timestamp, duration: item.duration, data: item.data }));
        this.fed = Math.max(this.fed, item.timestamp);
      }
    }
    if (!configured) throw new NotDecodable('ffmpeg could not copy the clip\'s picture');
    await this.#decoder.flush();
  }

  close() {
    this.closed = true;
    this.#stream?.cancel().catch(() => {});
    if (this.#decoder.state !== 'closed') this.#decoder.close();
    for (const frame of this.frames.splice(0)) frame.close();
    this.changed();
  }
}

/**
 * A clip of an export decoded by the browser, for one layer. `seek` gets the
 * frame for a moment ready, decoding on from where it was, or starting again
 * from the keyframe before when the moment is behind (a loop starting over)
 * or far ahead; `picture` hands it over. Fails with `NotDecodable`, or with
 * the decoder's own error, when the clip is for ffmpeg after all.
 */
export class ClipDecoder {
  readonly #path: string;
  readonly #rotation: number;
  #session: Session | null = null;
  /** The frame shown before the clip was started again, until the new start has one. */
  #before: VideoFrame | null = null;
  /** The reading was started again after it failed, and has not decoded a frame since. */
  #retried = false;

  constructor(path: string, rotation: number) {
    this.#path = path;
    this.#rotation = rotation;
  }

  async seek(seconds: number) {
    const at = seconds * 1e6;
    let session = this.#session;
    const behind = session && (at < session.from - LEEWAY_US || (session.movedOn && at < session.frames[0].timestamp - LEEWAY_US));
    if (!session || behind || at > Math.max(session.fed, session.from) + FAR_US) session = this.#start(seconds);
    for (;;) {
      if (session.error) {
        // A reading that worked before and failed now, as when the browser takes back a decoder left idle,
        // is started again once; one that never worked is for ffmpeg.
        if (session.decoded === 0 || this.#retried) throw session.error;
        this.#retried = true;
        session = this.#start(seconds);
        continue;
      }
      const { frames } = session;
      // Frames this moment is past are let go.
      while (frames.length >= 2 && frames[1].timestamp <= at + LEEWAY_US) {
        frames.shift()!.close();
        session.movedOn = true;
        session.changed();
      }
      // The first frame held is this moment's when the next is later, or there is no next; or when it is
      // itself later, which happens only at the start of a reading that came out after the moment.
      if (frames.length >= 2 || session.done || (frames.length === 1 && frames[0].timestamp > at + LEEWAY_US)) break;
      await session.next();
    }
    if (session.frames.length) {
      this.#before?.close();
      this.#before = null;
      this.#retried = false;
    }
  }

  #start(seconds: number): Session {
    const old = this.#session;
    if (old) {
      // Its frame stays on hand, should the new start have none: past the end of the clip, the last frame stays.
      const shown = old.frames.shift();
      if (shown) {
        this.#before?.close();
        this.#before = shown;
      }
      old.close();
    }
    this.#session = new Session(this.#path, seconds, this.#rotation);
    return this.#session;
  }

  picture(): VideoPicture | null {
    const frame = this.#session?.frames[0] ?? this.#before;
    if (!frame) return null;
    // The browser gives a turned frame's size as shown, turned; should one give it as stored, it is turned here.
    const turned = this.#rotation === 90 || this.#rotation === 270;
    const stored = frame.visibleRect ?? { width: frame.codedWidth, height: frame.codedHeight };
    const asStored = (frame.displayWidth > frame.displayHeight) === (stored.width > stored.height);
    const swap = turned && asStored && stored.width !== stored.height;
    return { image: frame, width: swap ? frame.displayHeight : frame.displayWidth, height: swap ? frame.displayWidth : frame.displayHeight };
  }

  close() {
    this.#session?.close();
    this.#session = null;
    this.#before?.close();
    this.#before = null;
  }
}
