import type { Measurement, RenderResult } from '../master.ts';

export interface RenderRequest {
  input: string;
  output: string;
  /** Region in seconds from the start of the file. */
  start: number;
  end: number;
  gainDb: Float32Array;
  bassDb: Float32Array;
  ceilingDb: number | null;
}

/** What is remembered between sessions. The window decides what goes in; the main process only stores it. */
export interface Remembered {
  /** The mixes last marked in this recording, if it has been opened before. */
  session: unknown;
  /** The settings last in use, for recordings opened for the first time. */
  defaults: unknown;
}

export type MenuCommand = 'open' | 'undo' | 'redo';

/** What the window may ask the main process to do. */
export interface Api {
  pickFile(): Promise<string | null>;
  /** File passed on the command line, if any. */
  initialFile(): Promise<string | null>;
  pathForFile(file: File): string;
  measure(path: string): Promise<Measurement>;
  recall(path: string): Promise<Remembered>;
  remember(path: string, remembered: Remembered): void;
  /** Address the window can play this recording from. */
  mediaUrl(path: string): Promise<string>;
  pickOutput(suggested: string): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  /** Which of these files already exist. */
  existing(paths: string[]): Promise<string[]>;
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  render(request: RenderRequest): Promise<RenderResult>;
  reveal(path: string): void;
  onProgress(listener: (fraction: number) => void): void;
  /** A command chosen from the menu bar or by its keyboard shortcut. */
  onMenu(listener: (command: MenuCommand) => void): void;
  /** A recording handed to the app from outside while it is running. */
  onOpenFile(listener: (path: string) => void): void;
  /** Tells the main process the window has drawn a loaded file. */
  painted(): void;
}

export type Job = { kind: 'measure'; input: string } | ({ kind: 'render' } & RenderRequest);

export type JobMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; result: unknown }
  | { type: 'error'; message: string };
