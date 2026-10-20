// A frame of a mix's video, drawn the same way for the Video view and for the
// export: the template chosen for the mix, the text it can show, and the music
// at that moment.

import type { Api, VideoMixInfo } from '../api.ts';
import { clipTimingOf, type FrameDrawer, type VideoPicture } from '../../visuals/draw.ts';
import { beatsOf, type ClipTiming } from '../../visuals/clip.ts';
import type { MusicReader } from '../../visuals/music.ts';
import {
  ASSET_PREFIX, checkTemplate, FOLDER_LUT_PREFIX, LUT_PREFIX, RECORDING_VIDEO, TEXT_VARIABLES, videoFile, type PreparedLayer, type ResolvedParams, type Template, type TextValues,
} from '../../visuals/template.ts';
import { MUSIC_NAMES } from '../../visuals/music.ts';
import { BUILT_IN_TEMPLATES } from '../../visuals/templates.ts';
import { parseCube, unpackLut, type Lut } from '../../visuals/lut.ts';
import { BUILTIN_LUT_PREFIX, builtinLut, builtinLutFile, decodeBuiltinLut } from '../../visuals/builtin-luts.ts';
import { BAND_COUNT } from '../../features.ts';
import { fadeGain } from '../../fade.ts';
import { splitName, trackAt } from '../../tracks.ts';

/** What a video needs to know about its mix: its name, place and length, and the template chosen for it. */
export type VideoMix = VideoMixInfo;

/** The built-in templates, checked once. */
export const TEMPLATES = new Map<string, Template>(
  BUILT_IN_TEMPLATES.map((builtIn) => [builtIn.id, checkTemplate(builtIn.template, MUSIC_NAMES, TEXT_VARIABLES).template]),
);
// Built-in templates are read only: a template of the user's own starts as a copy of one.
/** What a mix's video looks like when nobody chose a template for it. */
export const DEFAULT_TEMPLATE = BUILT_IN_TEMPLATES[0].id;
/** What a mix's video looks like when nobody chose a template for it and the recording is a video: its own picture. */
export const VIDEO_RECORDING_TEMPLATE = 'original';

/** How a mix names a template of the user's own: this, then the template's id. */
export const USER_TEMPLATE = 'user:';

/** The user's own templates, by their names in a mix's choice (`user:` and the id), checked. */
export const USER_TEMPLATES = new Map<string, Template>();

/** Checks a template as stored or imported; what cannot be used is left out or set to its default. */
export const checked = (raw: unknown) => checkTemplate(raw, MUSIC_NAMES, TEXT_VARIABLES);

/** The template a mix chose; the default when there is none, or it has been deleted. */
export const templateOf = (choice: VideoMixInfo['visuals']): Template =>
  TEMPLATES.get(choice?.template ?? DEFAULT_TEMPLATE) ?? USER_TEMPLATES.get(choice?.template ?? '') ?? TEMPLATES.get(DEFAULT_TEMPLATE)!;

/**
 * Loads a picture a template shows: one packed into the template from its
 * data, any other from its file.
 */
export async function pictureOf(name: string, template: Template, api: Api): Promise<ImageBitmap> {
  if (name.startsWith(ASSET_PREFIX)) {
    const data = template.assets?.[name.slice(ASSET_PREFIX.length)];
    if (!data) throw new Error(`No picture called ${name.slice(ASSET_PREFIX.length)} in the template`);
    const [head, base64] = data.split(',');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return createImageBitmap(new Blob([bytes], { type: head.slice(5, head.indexOf(';')) }));
  }
  return createImageBitmap(new Blob([(await api.readImage(name)) as BlobPart]));
}

/** Reads a LUT a template uses: one it keeps from what is kept, one of the LUT folder from there, any other from its .cube file. */
export async function lutOf(name: string, template: Template, api: Api): Promise<Lut> {
  if (name.startsWith(LUT_PREFIX)) {
    const packed = template.luts?.[name.slice(LUT_PREFIX.length)];
    if (!packed) throw new Error(`No LUT called ${name.slice(LUT_PREFIX.length)} in the template`);
    return unpackLut(packed);
  }
  if (name.startsWith(FOLDER_LUT_PREFIX)) return parseCube(await api.readFolderLut(name.slice(FOLDER_LUT_PREFIX.length)));
  if (name.startsWith(BUILTIN_LUT_PREFIX)) return builtinLutOf(name.slice(BUILTIN_LUT_PREFIX.length));
  return parseCube(await api.readLut(name));
}

/** One of the LUTs that come with the app, by its name: its file is served beside the page, compressed. */
async function builtinLutOf(name: string): Promise<Lut> {
  if (!builtinLut(name)) throw new Error(`No LUT called ${name} comes with the app`);
  const response = await fetch(`luts/${builtinLutFile(name)}`);
  if (!response.ok || !response.body) throw new Error(`The LUT ${name} is missing from the app`);
  const inflated = response.body.pipeThrough(new DecompressionStream('deflate-raw'));
  return decodeBuiltinLut(new Uint8Array(await new Response(inflated).arrayBuffer()));
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** The variables a text can show, for the moment `seconds` into the mix. */
export function textValues(mix: VideoMix, seconds: number, tempo: number): TextValues {
  const length = mix.end - mix.start;
  const playing = trackAt(mix.tracks, seconds);
  const { artist, title } = splitName(playing?.track.name ?? '');
  return {
    mixName: mix.name,
    mixNumber: mix.number,
    mixCount: mix.count,
    mixLength: clock(length),
    elapsed: clock(seconds),
    remaining: clock(length - seconds),
    artist: mix.artist,
    title: mix.name,
    album: mix.album,
    recordingName: mix.recordingName,
    date: new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
    // Empty for a mix without tracks marked, or a track not named, so that the text showing it hides.
    currentTrack: playing?.track.name ?? '',
    currentArtist: artist,
    currentTitle: title,
    trackNumber: playing ? playing.index + 1 : '',
    trackCount: mix.tracks.length || '',
    nextTrack: playing?.next?.name ?? '',
    tempo: Math.round(tempo),
  };
}

/** What gives the frames of the videos a template shows: see video-sources.ts. */
export interface VideoFrames {
  picture(path: string, layer: number, timing: ClipTiming): VideoPicture | null;
}

/**
 * When a clip last started again by one of the rules of RESTARTS: at the
 * last beat (or every so many beats, counted from the mix's first), or at the
 * start of the track playing. In seconds into the mix; -Infinity if never.
 */
export function restartedAt(mix: VideoMix, reader: MusicReader | null, rule: string, seconds: number): number {
  if (rule === 'each track') {
    let last = -Infinity;
    for (const track of mix.tracks) if (track.at <= seconds && track.at > last) last = track.at;
    return last;
  }
  const every = beatsOf(rule);
  return every && reader ? reader.lastBeat(seconds, every) : -Infinity;
}

/**
 * Where the recording's own picture is for the moment `seconds` into the mix:
 * the same moment of the recording, as late as the picture is put to be in
 * step with the sound. Whatever the layer's settings for playing a clip.
 */
export function recordingTiming(mix: VideoMix, seconds: number): ClipTiming {
  return { seconds: mix.start + seconds - mix.pictureDelay, started: 0, playback: 'once, then hold', speed: 1, inPoint: 0, outPoint: 0, offset: 0 };
}

/** The file a video layer's source stands for, in this mix: one it names, the template's own, or the recording. */
export function videoPathOf(source: string, mix: VideoMix): string | null {
  return videoFile(source, mix.template, { path: mix.path, video: mix.video !== null });
}

/**
 * What the drawer will ask for to draw the moment `seconds` into the mix: a
 * frame of each video layer's clip, where its clip should be. Worked out
 * from the layers' settings before the frame is drawn, so that an export
 * can have the frames ready; a video's timing settings are plain numbers
 * and choices, and its "shown from", if made to follow the music, is taken
 * as it was in the frame before.
 */
export function clipRequests(mix: VideoMix, layers: PreparedLayer[], reader: MusicReader | null, seconds: number): { path: string; layer: number; timing: ClipTiming }[] {
  const fields = mix.visuals?.fields ?? {};
  const requests: { path: string; layer: number; timing: ClipTiming }[] = [];
  mix.template.layers.forEach((layer, index) => {
    if (layer.type !== 'video') return;
    let source = String(layer.params.video ?? '');
    const whole = /^%([A-Za-z_][A-Za-z0-9_]*)%$/.exec(source);
    if (whole) {
      const field = mix.template.fields.find((f) => f.key === whole[1]);
      source = field ? String(fields[field.key] ?? field.default) : '';
    }
    const path = videoPathOf(source, mix);
    if (!path) return;
    if (source === RECORDING_VIDEO) return requests.push({ path, layer: index, timing: recordingTiming(mix, seconds) });
    const last = layers[index]?.last;
    const params: ResolvedParams = { ...layer.params };
    for (const key of ['from', 'until']) if (typeof params[key] !== 'number') params[key] = typeof last?.[key] === 'number' ? last[key] : 0;
    const length = mix.end - mix.start;
    if (seconds < (params.from as number) || seconds > length - (params.until as number)) return;
    requests.push({ path, layer: index, timing: clipTimingOf(params, { seconds, restartedAt: (rule, at) => restartedAt(mix, reader, rule, at) }) });
  });
  return requests;
}

/**
 * Draws the moment `seconds` into the mix; `dt` is the time in the mix since
 * the frame before, `clockDt` that on the clock (see `Frame`).
 */
export function drawVideoFrame(
  drawer: FrameDrawer,
  layers: PreparedLayer[],
  reader: MusicReader | null,
  mix: VideoMix,
  seconds: number,
  dt: number,
  images: Map<string, ImageBitmap>,
  videos?: VideoFrames,
  clockDt = dt,
  luts?: Map<string, Lut>,
) {
  const length = mix.end - mix.start;
  const music = reader ? reader.at(seconds, dt) : { time: seconds, dt, length, progress: seconds / Math.max(1, length) };
  // So that a template can show something else where the recording has no picture of its own.
  music.hasVideo = mix.video ? 1 : 0;
  // So that a template can lay itself out otherwise in a vertical or square picture.
  const { width, height } = drawer.size;
  music.portrait = height > width ? 1 : 0;
  music.aspect = width / height;
  // The track's part of the mix, from its marker to the next or the mix's end, for a bar that fills once a track.
  const playing = trackAt(mix.tracks, seconds);
  const trackEnd = playing?.next?.at ?? length;
  music.trackProgress = playing && trackEnd > playing.track.at ? Math.min(1, Math.max(0, (seconds - playing.track.at) / (trackEnd - playing.track.at))) : 0;
  drawer.draw(layers, {
    seconds,
    dt,
    clockDt,
    length,
    music,
    spectrum: reader ? reader.spectrum(seconds) : new Float32Array(BAND_COUNT),
    levelHistory: (span, points) => (reader ? reader.levelHistory(seconds, span, points) : new Float32Array(points)),
    text: textValues(mix, seconds, typeof music.tempo === 'number' ? music.tempo : 0),
    images,
    luts,
    shown: fadeGain(seconds, length, mix.fadeIn, mix.fadeOut),
    video: (source, layer, timing) => {
      const path = videos && videoPathOf(source, mix);
      if (!path) return null;
      return videos.picture(path, layer, source === RECORDING_VIDEO ? recordingTiming(mix, seconds) : timing);
    },
    restartedAt: (rule, at) => restartedAt(mix, reader, rule, at),
  });
}
