import type { EncodeOptions } from '../audio-io.ts';
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

export type MenuCommand = 'open' | 'close' | 'undo' | 'redo' | 'help';

/** What the window may ask the main process to do. */
export interface Api {
  pickFile(): Promise<string | null>;
  /** The recording to start with: one handed to the app, or else the one worked on last time. */
  initialFile(): Promise<string | null>;
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
  /** Stops the notice about this version from coming back. */
  skipVersion(version: string): void;
  /** A command chosen from the menu bar or by its keyboard shortcut. */
  onMenu(listener: (command: MenuCommand) => void): void;
  /** A recording handed to the app from outside while it is running. */
  onOpenFile(listener: (path: string) => void): void;
  /** Tells the main process the window has drawn this recording; it is the one to reopen next time. */
  painted(path: string): void;
  /** The recordings opened lately, newest first, without those that are not there right now. */
  recent(): Promise<RecentRecording[]>;
  /** That list has changed. */
  onRecentChanged(listener: () => void): void;
  /** Tells the main process the recording has been closed, so it is not reopened next time. */
  closed(): void;
}

export type Job = { kind: 'measure'; input: string } | ({ kind: 'render' } & RenderRequest);

export type JobMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; result: unknown }
  | { type: 'error'; message: string };
