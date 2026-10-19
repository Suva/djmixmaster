// Runs the real app for a test: starts it in its check mode (see AGENTS.md),
// hands it a function to run inside the window, and gives back what that
// function returned. Each run is one start of the app, as a user would have it.

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT = resolve(import.meta.dirname, '..');

/** Where the Electron program is, or null when it was not installed (as on the machine that runs the unit tests). */
export function electronPath(): string | null {
  try {
    return createRequire(import.meta.url)('electron') as string;
  } catch {
    return null;
  }
}

/** What a test's function gets to drive the window with. Defined inside the window by `PAGE_SOURCE`. */
export interface Page {
  /** Waits this many milliseconds. */
  wait(ms: number): Promise<void>;
  /** Waits until the check holds; fails with `what` if it never does. */
  until(check: () => boolean, what: string, ms?: number): Promise<void>;
  /** Waits out the pause after which a change is saved and becomes an undo step. */
  settle(): Promise<void>;
  element<T extends HTMLElement = HTMLElement>(id: string): T;
  text(id: string): string;
  click(id: string): void;
  /** Presses a key on the window, by its `code` (and `key`, where the app goes by that). */
  key(code: string, options?: { shift?: boolean; alt?: boolean; key?: string }): void;
  /** Moves a slider to a value, as dragging it would. */
  slide(id: string, value: number): void;
  /** Picks an entry of a list by its value. */
  choose(id: string, value: string): void;
  /** Types into a text field and leaves it. */
  type(id: string, value: string): void;
  /** The labels on the mix tabs, in order. */
  tabs(): string[];
  /** The playhead as the transport shows it, in seconds into the selected mix. */
  playhead(): number;
  /** Where the selected mix lies in the recording, and how long it is, as times to the millisecond. */
  region(): { start: string; end: string; length: string };
}

// Kept as text because it runs in the window, not here. It must match `Page`.
const PAGE_SOURCE = `(() => {
  const element = (id) => {
    const found = document.getElementById(id);
    if (!found) throw new Error('No element with id ' + id);
    return found;
  };
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  return {
    wait,
    element,
    async until(check, what, ms = 15000) {
      const start = Date.now();
      while (!check()) {
        if (Date.now() - start > ms) throw new Error('Waited in vain for: ' + what);
        await wait(50);
      }
    },
    settle: () => wait(650),
    text: (id) => element(id).textContent.trim(),
    click: (id) => element(id).click(),
    key(code, options = {}) {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        code, key: options.key ?? code, shiftKey: !!options.shift, altKey: !!options.alt, bubbles: true,
      }));
    },
    slide(id, value) {
      element(id).value = String(value);
      element(id).dispatchEvent(new Event('input', { bubbles: true }));
    },
    choose(id, value) {
      element(id).value = value;
      element(id).dispatchEvent(new Event('change', { bubbles: true }));
    },
    type(id, value) {
      const field = element(id);
      field.focus();
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.blur();
    },
    tabs: () => [...document.querySelectorAll('.mix-tab')].map((tab) => tab.textContent.trim()),
    playhead: () => element('play-time').textContent.split(' / ')[0].split(':').reduce((total, part) => total * 60 + Number(part), 0),
    region: () => ({ ...element('play-time').dataset }),
  };
})()`;

export interface Run<Given> {
  /**
   * The recording to start with; several files are the parts of one. Without
   * one the app starts as it would by itself: with the last one, or empty.
   */
  recording?: string | string[];
  /** The app's data folder for this run. Runs that share one see each other's saved work. */
  data: string;
  /** A menu command to send before the function runs: 'close', 'undo', 'redo' or 'help'. */
  menu?: string;
  /** The folder "Export all" saves into. */
  exportFolder?: string;
  /** What the dialog for a template's picture answers. */
  image?: string;
  /** What the dialog for a track list answers. */
  tracklist?: string;
  /** What the dialog for a template file to import answers. */
  template?: string;
  /** What the dialog for a template's video answers. */
  video?: string;
  /** What the dialog for a .cube LUT answers. */
  lut?: string;
  /** Handed to the function as its second argument; must survive JSON. */
  given?: Given;
  timeoutMs?: number;
  /** More of the app's environment, such as DJMASTER_STORE. */
  env?: Record<string, string>;
}

/**
 * Starts the app, runs `inWindow` in its window once the recording is on
 * screen (or the window has come up empty), and returns its result. The
 * function is sent over as text, so it can use only its two arguments and
 * what a web page has, nothing from the test file around it.
 */
export function runApp<Result, Given = undefined>(
  run: Run<Given>,
  inWindow: (page: Page, given: Given) => Result | Promise<Result>,
): Promise<Result> {
  const electron = electronPath();
  if (!electron) throw new Error('Electron is not installed');
  const script = `(async () => {
    const page = ${PAGE_SOURCE};
    return JSON.stringify({ result: await (${inWindow.toString()})(page, ${JSON.stringify(run.given ?? null)}) });
  })().catch((error) => JSON.stringify({ error: String(error && error.stack || error) }))`;

  return new Promise<Result>((done, fail) => {
    const child = spawn(electron, [PROJECT, ...[run.recording ?? []].flat()], {
      env: {
        ...process.env,
        DJMASTER_SHOT: join(run.data, 'window.png'),
        DJMASTER_SHOT_DATA: run.data,
        DJMASTER_SHOT_SCRIPT: script,
        ...(run.menu ? { DJMASTER_SHOT_MENU: run.menu } : {}),
        ...(run.exportFolder ? { DJMASTER_SHOT_FOLDER: run.exportFolder } : {}),
        ...(run.image ? { DJMASTER_SHOT_IMAGE: run.image } : {}),
        ...(run.tracklist ? { DJMASTER_SHOT_TRACKLIST: run.tracklist } : {}),
        ...(run.template ? { DJMASTER_SHOT_TEMPLATE: run.template } : {}),
        ...(run.video ? { DJMASTER_SHOT_VIDEO: run.video } : {}),
        ...(run.lut ? { DJMASTER_SHOT_LUT: run.lut } : {}),
        ...run.env,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`The app did not finish in time. Its output:\n${output}`));
    }, run.timeoutMs ?? 60_000);
    child.on('error', fail);
    child.on('close', () => {
      clearTimeout(timer);
      const line = output.split('\n').find((text) => text.startsWith('[script] '));
      if (!line) return fail(new Error(`The app gave no result. Its output:\n${output}`));
      const answer = JSON.parse(line.slice('[script] '.length)) as { result: Result } | { error: string };
      if ('error' in answer) fail(new Error(`In the window: ${answer.error}`));
      else done(answer.result);
    });
  });
}

/**
 * A new, empty data folder under `root`. Given `analysesFrom`, it starts with
 * that folder's stored analyses, so the run need not measure the recording again.
 */
export async function dataFolder(root: string, analysesFrom?: string): Promise<string> {
  const folder = await mkdtemp(join(root, 'data-'));
  if (analysesFrom) await cp(join(analysesFrom, 'analyses'), join(folder, 'analyses'), { recursive: true });
  return folder;
}

/** A temporary folder for a test file's recordings, data folders and exports. */
export async function workFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'djmaster-window-'));
  await mkdir(join(folder, 'exports'));
  return folder;
}
