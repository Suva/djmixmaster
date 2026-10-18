import type { MediaFile, Template } from '../visuals/template.ts';
import type { ChannelMix } from '../channels.ts';
import type { Shape } from '../visuals/shape.ts';
import type { EncodeOptions, VideoInfo } from '../audio-io.ts';

export type { VideoInfo } from '../audio-io.ts';
import type { Features } from '../features.ts';
import type { Examination, RenderResult } from '../master.ts';

export interface RenderRequest {
  input: string;
  output: string;
  /** Region in seconds from the start of the file. */
  start: number;
  end: number;
  gainDb: Float32Array;
  bassDb: Float32Array;
  /** Format details of the exported file, including its tags. */
  encode: EncodeOptions;
  /** How much quieter to make the result, ceiling included, for a lossy format. */
  headroomDb: number;
  /** Length in seconds of the fades at the two ends. */
  fadeInSeconds: number;
  fadeOutSeconds: number;
  ceilingDb: number | null;
  /** A fix for the recording's channels, applied before anything else. */
  channels?: ChannelMix;
  /** For an MP4: the picture to go with the sound. */
  video?: VideoRequest;
  /**
   * For a recording that is a video: put its own picture with the sound,
   * copied as it is rather than drawn and encoded again.
   */
  originalPicture?: boolean;
  /** For that: how much later than its sound the picture is shown, in seconds. */
  pictureDelay?: number;
}

/** The picture of a video export. */
export interface VideoRequest {
  /** The mix as the template sees it, with the template and fields chosen for it. */
  mix: VideoMixInfo;
  width: number;
  height: number;
  fps: number;
  /** Bitrate of the picture, in kbps. */
  kbps: number;
}

/** What the drawing of a mix's video needs to know about it. */
export interface VideoMixInfo {
  path: string;
  recordingName: string;
  name: string;
  number: number;
  count: number;
  start: number;
  end: number;
  artist: string;
  album: string;
  visuals: VisualsChoice | undefined;
  /** The shape the picture is drawn in: the one chosen, or landscape. */
  shape: Shape;
  /**
   * The template itself, checked: the export's hidden page does not know the
   * user's own templates, and is to draw exactly what the view showed.
   */
  template: Template;
  /** The tracks played in the mix, timed from its start. */
  tracks: { at: number; name: string }[];
  /** The mix's fades in and out, in seconds, which the picture follows. */
  fadeIn: number;
  fadeOut: number;
  /** The recording's own picture, when it is a video, which a template can show. */
  video: VideoInfo | null;
  /** How much later than its sound the recording's picture is shown, in seconds, to put the two in step. */
  pictureDelay: number;
}

/** One of the files the Video view plays a video from. */
export interface PreviewPart {
  path: string;
  duration: number;
}

/** What is remembered between sessions. The window decides what goes in; the main process only stores it. */
export interface Remembered {
  /** The mixes last marked in this recording, if it has been opened before. */
  session: unknown;
  /** The settings last in use, for recordings opened for the first time. */
  defaults: unknown;
}

/** Where the window's player gets a recording from. */
export interface MediaSource {
  url: string;
  /**
   * False when the player can be given the file itself. True when it cannot
   * seek in it exactly: `url` then serves the audio decoded from the position
   * given as `?t=<seconds>` onwards.
   */
  streamed: boolean;
  /** The recording's picture, when it is a video. */
  video: VideoInfo | null;
}

/** A recording opened lately that is still where it was. */
export interface RecentRecording {
  path: string;
  name: string;
  /** Its folder, for showing: the home folder is shortened to "~". */
  folder: string;
}

/**
 * A stretch of the recording as a wave, for drawing it close up: the lowest
 * and the highest sample value in each slice of time, across both channels.
 */
export interface FineWave {
  low: Float32Array;
  high: Float32Array;
}

/** The template a mix's video uses, and what was filled in for it. */
export interface VisualsChoice {
  template: string;
  fields: Record<string, string | number>;
  /** The shape of the picture; absent for one chosen before there were shapes, which was landscape. */
  shape?: Shape;
}

export type MenuCommand = 'open' | 'close' | 'undo' | 'redo' | 'help';

/** What the window may ask the main process to do. */
export interface Api {
  /** Asks for one recording: a file, or several that are its parts. */
  pickFiles(): Promise<string[] | null>;
  /** Turns the files chosen into one recording to open: a file stands for itself, several get a list joining them. */
  recordingOf(files: string[]): Promise<{ path: string; name: string }>;
  /** The recording to start with, as its files: the ones handed to the app, or else the one worked on last time. */
  initialFile(): Promise<string[] | null>;
  pathForFile(file: File): string;
  measure(path: string): Promise<Examination>;
  recall(path: string): Promise<Remembered>;
  remember(path: string, remembered: Remembered): void;
  /**
   * Decodes the stretch from `start` to `end` seconds and returns its shape in
   * `perSecond` slices a second. Requests are served one after another.
   */
  fineWave(path: string, start: number, end: number, sampleRate: number, perSecond: number): Promise<FineWave>;
  /** How the window can play this recording. */
  mediaUrl(path: string): Promise<MediaSource>;
  pickOutput(suggested: string): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  /** Which of these files already exist. */
  existing(paths: string[]): Promise<string[]>;
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  render(request: RenderRequest): Promise<RenderResult>;
  /** Stops the analysis or export in progress; its call then fails with "Cancelled". */
  cancel(): void;
  reveal(path: string): void;
  onProgress(listener: (fraction: number) => void): void;
  /** A newer version than the one running has been found. */
  onUpdateAvailable(listener: (version: string) => void): void;
  /** Opens the download page in the browser. */
  openDownloadPage(): void;
  /** Opens a web or email address in the browser or mail program; anything else is ignored. */
  openLink(url: string): void;
  /** Stops the notice about this version from coming back. */
  skipVersion(version: string): void;
  /** A command chosen from the menu bar or by its keyboard shortcut. */
  onMenu(listener: (command: MenuCommand) => void): void;
  /** A recording handed to the app from outside while it is running. */
  onOpenFiles(listener: (paths: string[]) => void): void;
  /**
   * What the visuals of a recording move to. Worked out in the background the
   * first time it is asked for, and kept; progress comes through `onListening`.
   */
  features(path: string): Promise<Features>;
  onListening(listener: (path: string, fraction: number) => void): void;
  /** Tells the main process the window has drawn this recording; it is the one to reopen next time. */
  painted(path: string): void;
  /** The recordings opened lately, newest first, without those that are not there right now. */
  recent(): Promise<RecentRecording[]>;
  /** That list has changed. */
  onRecentChanged(listener: () => void): void;
  /** Asks for a picture file, for a template's image field. */
  pickImage(): Promise<string | null>;
  /** The bytes of a picture file chosen before. */
  readImage(path: string): Promise<Uint8Array>;
  /** Asks for a .cube file, for a template's LUT layer or field. */
  pickLut(): Promise<string | null>;
  /** The text of a .cube file chosen before. */
  readLut(path: string): Promise<string>;
  /** The .cube files in the LUT folder (File > Show LUT Folder), named by where each is in it, without the extension. */
  folderLuts(): Promise<FolderLut[]>;
  /** The text of a LUT in the LUT folder, by its name there ("Film/Warm"). */
  readFolderLut(name: string): Promise<string>;
  /** Another folder was chosen for LUTs. */
  onLutsChanged(listener: () => void): void;
  /** Asks for a video file, for a template's video layer or field. */
  pickVideo(): Promise<string | null>;
  /** The files the Video view plays a video from, one after another, each with its length in seconds. */
  previewParts(path: string): Promise<PreviewPart[]>;
  /**
   * A copy of the part of a clip from `inPoint` to `outPoint` (0 for its end)
   * followed by itself reversed, made the first time it is asked for: a
   * ping-pong played forwards. Up to PING_PONG_MOST_SECONDS long.
   */
  pingPongClip(path: string, inPoint: number, outPoint: number): Promise<string>;
  /** A video's picture and length. */
  videoInfo(path: string): Promise<{ duration: number; video: VideoInfo }>;
  /**
   * Makes a video one a template can keep: a small one is copied into the
   * app's media folder, a large one stays where it is.
   */
  addMedia(path: string): Promise<MediaFile>;
  /**
   * Looks for a template's videos that are not where it says: in the media
   * folders, and in `near`, a folder where another was found. Each comes
   * back where it is now, or null.
   */
  findMedia(files: MediaFile[], near?: string): Promise<(MediaFile | null)[]>;
  /** The templates of the user's own, as stored: each with its id, not yet checked. */
  templates(): Promise<{ id: string; template: unknown }[]>;
  saveTemplate(id: string, template: unknown): Promise<void>;
  /** Moves a template of the user's own to the Trash. */
  deleteTemplate(id: string): Promise<void>;
  /** What is in a template file, by its path, not yet checked: one dropped on the window or opened from Finder. */
  readTemplateFile(path: string): Promise<unknown>;
  /** Asks for a template file and gives what is in it, not yet checked; null if none was chosen. */
  importTemplate(): Promise<unknown | null>;
  /** Asks where to save a template to share, and saves it there; gives the path, or null if cancelled. */
  exportTemplate(template: unknown, name: string): Promise<string | null>;
  /** Asks for a track list (a playlist or a table from DJ software, or text) and gives its text, or null if none was chosen. */
  openTracklist(): Promise<string | null>;
  /** The text on the clipboard, and putting text there. */
  readClipboard(): Promise<string>;
  writeClipboard(text: string): void;
  /** In the hidden page that draws a video export: the picture to make. */
  onVideoJob(listener: (job: VideoRequest) => void): void;
  /** From that page: the next stretch of the encoded picture. Resolves once it is written. */
  videoChunk(bytes: Uint8Array): Promise<void>;
  videoProgress(fraction: number): void;
  /** From that page: the picture is finished, or failed with this message. */
  videoDone(failure: string | null): void;
  /** Tells the main process the recording has been closed, so it is not reopened next time. */
  closed(): void;
}

export type Job =
  | { kind: 'measure'; input: string }
  | { kind: 'listen'; input: string }
  | ({ kind: 'render' } & RenderRequest);

export type JobMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; result: unknown }
  | { type: 'error'; message: string };

/** A LUT in the LUT folder: "Film/Warm" for Film/Warm.cube, and where it is. */
export interface FolderLut {
  name: string;
  path: string;
}
