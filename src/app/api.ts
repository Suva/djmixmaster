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

/** What the window may ask the main process to do. */
export interface Api {
  pickFile(): Promise<string | null>;
  /** File passed on the command line, if any. */
  initialFile(): Promise<string | null>;
  pathForFile(file: File): string;
  measure(path: string): Promise<Measurement>;
  /** Address the window can play this recording from. */
  mediaUrl(path: string): Promise<string>;
  pickOutput(suggested: string): Promise<string | null>;
  render(request: RenderRequest): Promise<RenderResult>;
  reveal(path: string): void;
  onProgress(listener: (fraction: number) => void): void;
  /** Tells the main process the window has drawn a loaded file. */
  painted(): void;
}

export type Job = { kind: 'measure'; input: string } | ({ kind: 'render' } & RenderRequest);

export type JobMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; result: unknown }
  | { type: 'error'; message: string };
