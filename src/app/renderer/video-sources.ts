// The frames of the videos a template shows, for the drawer: in the Video view
// from video elements that play along with the music, and in an export from
// ffmpeg, frame by exact frame. Both work out where each clip is with the
// same function (clipTime in visuals/clip.ts).

import { clipTime, PING_PONG_MOST_SECONDS, usedPart, type ClipTiming } from '../../visuals/clip.ts';
import type { VideoPicture } from '../../visuals/draw.ts';
import type { Api, VideoInfo } from '../api.ts';

/** Where the window gets a video file from, to play it. */
export const videoUrl = (path: string) => `djm://app/video?path=${encodeURIComponent(path)}`;

/** A frame a clip's frames are shown at, when it does not say. */
const FALLBACK_FPS = 30;

/**
 * A clip that plays ping-pong is played from a copy of its part followed by
 * itself reversed (see `pingPongClip` in main.ts), forwards, as a loop: a
 * decoder cannot go backwards a frame at a time. These are the copies, made
 * on first request, by clip and part.
 */
class PingPongs {
  readonly #api: Api;
  readonly #copies = new Map<string, Promise<string>>();
  readonly #made = new Map<string, string>();

  constructor(api: Api) {
    this.#api = api;
  }

  /** The copy for this clip and timing, and the timing to play it with; null if it does not play ping-pong, or is too long to. */
  #wanted(path: string, timing: ClipTiming, duration: number): { key: string; from: number; to: number } | null {
    if (timing.playback !== 'ping-pong') return null;
    const [from, to] = usedPart(timing, duration);
    if (to - from > PING_PONG_MOST_SECONDS || to - from <= 0) return null;
    return { key: `${path}|${from}|${to}`, from, to };
  }

  /** As a loop of the copy: where it is in the copy comes to where it is in the clip, there and back. */
  static #asLoop(copy: string, timing: ClipTiming) {
    return { path: copy, timing: { ...timing, playback: 'loop' as const, inPoint: 0, outPoint: 0 } };
  }

  /** The copy to play now, if it has been made; asks for it to be made if not. `made` is told when it is. */
  now(path: string, timing: ClipTiming, duration: number, made: () => void): { path: string; timing: ClipTiming } | null {
    const wanted = this.#wanted(path, timing, duration);
    if (!wanted) return null;
    const copy = this.#made.get(wanted.key);
    if (copy) return PingPongs.#asLoop(copy, timing);
    if (!this.#copies.has(wanted.key)) this.ready(path, timing, duration).then(made, () => {});
    return null;
  }

  /** The copy to play, once made. */
  async ready(path: string, timing: ClipTiming, duration: number): Promise<{ path: string; timing: ClipTiming } | null> {
    const wanted = this.#wanted(path, timing, duration);
    if (!wanted) return null;
    let copy = this.#copies.get(wanted.key);
    if (!copy) {
      copy = this.#api.pingPongClip(path, wanted.from, wanted.to);
      this.#copies.set(wanted.key, copy);
      copy.then((made) => this.#made.set(wanted.key, made), () => {});
    }
    return PingPongs.#asLoop(await copy, timing);
  }
}

// ---------------------------------------------------------------------------
// The Video view

/** How far a playing clip may drift from where it should be before it is put back, in seconds. */
const DRIFT = 0.15;
/** How long a clip no layer has shown is kept loaded, in case it is shown again. */
const KEPT_MS = 10_000;

interface Playing {
  element: HTMLVideoElement;
  /** The number of the frame that last showed it, and when that was. */
  frame: number;
  used: number;
  /** Whether it has had a frame to show: while it jumps, that one stays on screen. */
  shown: boolean;
}

/** A video as the view plays it: its files one after another, with where each starts. */
interface Playable {
  parts: { path: string; start: number; duration: number }[];
  duration: number;
}

/**
 * Plays the videos of the Video view, one video element per layer and file
 * showing one, kept where the layer's clip should be. While the music plays
 * they play too, and are put back only when they drift; paused, each is put
 * on the exact frame. `changed` is told when a frame arrives that the
 * picture should show.
 */
export class PreviewVideos {
  readonly #api: Api;
  readonly #changed: () => void;
  readonly #playing = new Map<string, Playing>();
  /** What each video is played from, by its path; null while being found out. */
  readonly #playables = new Map<string, Playable | null>();
  readonly #pingPongs: PingPongs;
  #musicPlaying = false;
  #rate = 1;
  /** Counts the frames drawn, to tell which clips the last one showed. */
  #frame = 0;

  constructor(api: Api, changed: () => void) {
    this.#api = api;
    this.#changed = changed;
    this.#pingPongs = new PingPongs(api);
  }

  /** Before a frame is drawn: whether the music plays, and how fast. */
  begin(musicPlaying: boolean, rate: number) {
    this.#musicPlaying = musicPlaying;
    this.#rate = rate;
    this.#frame++;
  }

  /** After a frame is drawn: clips no layer showed stand still, and long unused ones are let go. */
  end() {
    const now = performance.now();
    for (const [key, entry] of this.#playing) {
      if (entry.frame === this.#frame) continue;
      if (!entry.element.paused) entry.element.pause();
      if (now - entry.used > KEPT_MS) this.#forget(key);
    }
  }

  /** Lets every clip go: another recording, or the view closed. */
  clear() {
    for (const key of [...this.#playing.keys()]) this.#forget(key);
  }

  #forget(key: string) {
    const entry = this.#playing.get(key);
    if (!entry) return;
    entry.element.pause();
    entry.element.removeAttribute('src');
    entry.element.load();
    this.#playing.delete(key);
  }

  /** What a video is played from, once known; asked for the first time it is wanted. */
  #playable(path: string): Playable | null {
    if (this.#playables.has(path)) return this.#playables.get(path)!;
    this.#playables.set(path, null);
    this.#api.previewParts(path).then(
      (found) => {
        let start = 0;
        const parts = found.map((part) => {
          const placed = { ...part, start };
          start += part.duration;
          return placed;
        });
        this.#playables.set(path, { parts, duration: start });
        this.#changed();
      },
      // Not a video that can be shown; asked again only after a while, in case it was a moment's trouble.
      () => setTimeout(() => this.#playables.delete(path), KEPT_MS),
    );
    return null;
  }

  picture(path: string, layer: number, timing: ClipTiming): VideoPicture | null {
    const playable = this.#playable(path);
    if (!playable) return null;
    // Until its copy is made, a ping-pong is played backwards by jumping, which is slow but shows where it is.
    const copy = this.#pingPongs.now(path, timing, playable.duration, this.#changed);
    if (copy) return this.picture(copy.path, layer, copy.timing);
    const at = clipTime(timing, playable.duration);
    if (at === null) return null;
    // The file it is in, and where in that file.
    const inside = playable.parts.findIndex((part) => at < part.start + part.duration);
    const part = playable.parts[inside < 0 ? playable.parts.length - 1 : inside];
    const local = Math.min(at - part.start, Math.max(0, part.duration - 0.5 / FALLBACK_FPS));
    // Moving on as it plays, or standing still: held at its end, or about to jump back to its start.
    const soon = clipTime({ ...timing, seconds: timing.seconds + 0.05 }, playable.duration);
    const moving = this.#musicPlaying && soon !== null && soon > at && soon < part.start + part.duration;

    const key = `${layer}|${part.path}`;
    let entry = this.#playing.get(key);
    if (!entry) {
      const element = document.createElement('video');
      element.muted = true;
      element.preload = 'auto';
      element.playsInline = true;
      // A frame that has come in, after a jump or at the start, is shown even while paused.
      element.addEventListener('seeked', () => this.#changed());
      element.addEventListener('loadeddata', () => this.#changed());
      element.src = videoUrl(part.path);
      entry = { element, frame: 0, used: 0, shown: false };
      this.#playing.set(key, entry);
    }
    entry.frame = this.#frame;
    entry.used = performance.now();
    const video = entry.element;
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) return null;
    if (moving) {
      const rate = Math.max(0.0625, Math.min(16, timing.speed * this.#rate));
      if (video.playbackRate !== rate) video.playbackRate = rate;
      if (!video.seeking && Math.abs(video.currentTime - local) > DRIFT) video.currentTime = local;
      if (video.paused) video.play().catch(() => {});
    } else {
      if (!video.paused) video.pause();
      if (!video.seeking && Math.abs(video.currentTime - local) > 0.5 / FALLBACK_FPS) video.currentTime = local;
    }
    // A jump, such as to the exact frame on pausing, has the element say it has no frame until it lands;
    // it still draws the one it had, which beats a moment of nothing.
    const ready = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || (video.seeking && entry.shown);
    if (!ready || !video.videoWidth) return null;
    entry.shown = true;
    return { image: video, width: video.videoWidth, height: video.videoHeight };
  }
}

// ---------------------------------------------------------------------------
// The export

/** The size a clip is decoded at: its own, made smaller to fit the video being made, and even, as I420 needs. */
export function decodeSize(video: VideoInfo, most: { width: number; height: number }): { width: number; height: number } {
  const turned = video.rotation === 90 || video.rotation === 270;
  const [width, height] = turned ? [video.height, video.width] : [video.width, video.height];
  const scale = Math.min(1, most.width / width, most.height / height);
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** Reads exactly as many bytes as asked from a stream, across its chunks. */
class ByteReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #held: Uint8Array = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  /** The next `count` bytes, or null at the end of the stream. */
  async read(count: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      if (this.#held.length === 0) {
        const { value, done } = await this.#reader.read();
        if (done) return null;
        this.#held = value;
      }
      const take = Math.min(count - filled, this.#held.length);
      out.set(this.#held.subarray(0, take), filled);
      this.#held = this.#held.subarray(take);
      filled += take;
    }
    return out;
  }

  cancel() {
    this.#reader.cancel().catch(() => {});
  }
}

/** One clip being read for one layer: decoded from some point onwards, a frame at a time. */
interface Reading {
  path: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  reader: ByteReader | null;
  /** Where in the clip the decoding started, in its seconds. */
  from: number;
  /** The frame on hand, as its number counted from `from`; -1 for none. */
  index: number;
  frame: VideoFrame | null;
  /** The decoder has reached the end of the clip: the last frame stays. */
  ended: boolean;
}

/** A request the drawer will make for a frame: which layer, which file, where in its clip. */
export interface ClipRequest {
  path: string;
  layer: number;
  timing: ClipTiming;
}

/**
 * Reads the frames of an export's videos from ffmpeg. Before each frame of
 * the export is drawn, `prepare` is given what the drawer will ask for and
 * gets those frames ready; `picture` then hands them over as it asks. A clip
 * is decoded forwards from where it is first wanted; a jump back (a loop
 * starting over) or far ahead starts the decoding again from there.
 */
export class ExportVideos {
  readonly #api: Api;
  readonly #most: { width: number; height: number };
  readonly #readings = new Map<string, Reading>();
  readonly #infos = new Map<string, Promise<{ duration: number; video: VideoInfo }>>();
  readonly #pingPongs: PingPongs;

  /** `most` is the size of the video being made: no clip is decoded larger. */
  constructor(api: Api, most: { width: number; height: number }) {
    this.#api = api;
    this.#most = most;
    this.#pingPongs = new PingPongs(api);
  }

  #info(path: string) {
    let info = this.#infos.get(path);
    if (!info) {
      info = this.#api.videoInfo(path);
      this.#infos.set(path, info);
    }
    return info;
  }

  async prepare(requests: ClipRequest[]) {
    for (const request of requests) {
      const { path, layer, timing } = await this.#played(request);
      const key = `${layer}|${path}`;
      let reading = this.#readings.get(key);
      if (!reading) {
        const { duration, video } = await this.#info(path);
        const size = decodeSize(video, this.#most);
        reading = {
          path, ...size, duration, fps: Math.min(60, video.fps || FALLBACK_FPS),
          reader: null, from: 0, index: -1, frame: null, ended: false,
        };
        this.#readings.set(key, reading);
      }
      const at = clipTime(timing, reading.duration, 1 / reading.fps);
      if (at !== null) await this.#seekTo(reading, at);
    }
  }

  async #seekTo(reading: Reading, at: number) {
    // Frame k of a decoding covers from + k / fps up to the next; a little leeway for rounding.
    let wanted = Math.floor((at - reading.from) * reading.fps + 1e-6);
    const behind = wanted < reading.index;
    const farAhead = wanted > reading.index + 2 * reading.fps;
    if (!reading.reader || behind || farAhead) {
      reading.reader?.cancel();
      reading.from = at;
      reading.index = -1;
      reading.ended = false;
      wanted = 0;
      const query = new URLSearchParams({
        path: reading.path, from: String(at), fps: String(reading.fps), w: String(reading.width), h: String(reading.height),
      });
      const response = await fetch(`djm://app/frames?${query}`);
      if (!response.ok || !response.body) throw new Error(`Could not read the video ${reading.path.split(/[\\/]/).pop()}`);
      reading.reader = new ByteReader(response.body);
    }
    const bytes = (reading.width * reading.height * 3) / 2;
    while (reading.index < wanted && !reading.ended) {
      const data = await reading.reader!.read(bytes);
      if (!data) {
        // Past the clip's last frame: the one on hand stays.
        reading.ended = true;
        break;
      }
      reading.frame?.close();
      reading.frame = new VideoFrame(data, {
        format: 'I420',
        codedWidth: reading.width,
        codedHeight: reading.height,
        timestamp: Math.round((reading.from + (reading.index + 1) / reading.fps) * 1e6),
        colorSpace: { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false },
      });
      reading.index++;
    }
  }

  /** What is played for a request: the clip, or for a ping-pong, its copy there and back as a loop. */
  async #played(request: ClipRequest): Promise<ClipRequest> {
    if (request.timing.playback !== 'ping-pong') return request;
    const copy = await this.#pingPongs.ready(request.path, request.timing, (await this.#info(request.path)).duration);
    if (copy) this.#copyOf.set(`${request.layer}|${request.path}`, copy.path);
    return copy ? { ...request, ...copy } : request;
  }

  /** The ping-pong copy played for a layer's clip, by layer and clip. */
  readonly #copyOf = new Map<string, string>();

  picture(path: string, layer: number, timing: ClipTiming): VideoPicture | null {
    const copy = timing.playback === 'ping-pong' ? this.#copyOf.get(`${layer}|${path}`) : undefined;
    if (copy) return this.picture(copy, layer, { ...timing, playback: 'loop', inPoint: 0, outPoint: 0 });
    const reading = this.#readings.get(`${layer}|${path}`);
    if (!reading?.frame || clipTime(timing, reading.duration, 1 / reading.fps) === null) return null;
    return { image: reading.frame, width: reading.width, height: reading.height };
  }

  close() {
    for (const reading of this.#readings.values()) {
      reading.reader?.cancel();
      reading.frame?.close();
    }
    this.#readings.clear();
  }
}
