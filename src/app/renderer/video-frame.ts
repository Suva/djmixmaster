// A frame of a mix's video, drawn the same way for the Video view and for the
// export: the template chosen for the mix, the text it can show, and the music
// at that moment.

import type { Api, VideoMixInfo } from '../api.ts';
import type { FrameDrawer } from '../../visuals/draw.ts';
import type { MusicReader } from '../../visuals/music.ts';
import { ASSET_PREFIX, checkTemplate, TEXT_VARIABLES, type PreparedLayer, type Template, type TextValues } from '../../visuals/template.ts';
import { MUSIC_NAMES } from '../../visuals/music.ts';
import { BUILT_IN_TEMPLATES } from '../../visuals/templates.ts';
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

/** Draws the moment `seconds` into the mix; `dt` is the time since the frame before. */
export function drawVideoFrame(
  drawer: FrameDrawer,
  layers: PreparedLayer[],
  reader: MusicReader | null,
  mix: VideoMix,
  seconds: number,
  dt: number,
  images: Map<string, ImageBitmap>,
) {
  const length = mix.end - mix.start;
  const music = reader ? reader.at(seconds, dt) : { time: seconds, dt, length, progress: seconds / Math.max(1, length) };
  drawer.draw(layers, {
    seconds,
    dt,
    length,
    music,
    spectrum: reader ? reader.spectrum(seconds) : new Float32Array(BAND_COUNT),
    levelHistory: (span, points) => (reader ? reader.levelHistory(seconds, span, points) : new Float32Array(points)),
    text: textValues(mix, seconds, typeof music.tempo === 'number' ? music.tempo : 0),
    images,
    shown: fadeGain(seconds, length, mix.fadeIn, mix.fadeOut),
  });
}
