// Runs the Record view's input and its recordings. The input is opened as soon
// as a device is chosen, so that its level can be set before anything is
// written: that is monitoring. Recording sends the same sound to an ffmpeg
// process that writes the parts (see recording.ts). A lock file says a
// recording is being made, so that the next start of the app finds it.
//
// An input is captured in one of two ways. The capture helper
// (native/capture/capture.c) takes any two of a device's channels, and while
// recording its output goes straight into the writing ffmpeg, both detached,
// so that the recording carries on if the app goes down; only its level comes
// here. Where there is no helper, or it cannot open a device, Chromium
// captures it in a hidden page (capture.ts) and sends the samples here, to be
// handed on to ffmpeg: two channels at most, and ended with the app.

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpeg, probe } from '../audio-io.ts';
import {
  bytesPerSecond, isPartOf, measureStereo, packArgs, PART_SECONDS, repairWav, stereoOf, wavFinished, writerArgs,
  type Levels, type RecordDevice, type RecordInput, type RecordPlan,
} from './recording.ts';

export interface RecordStatus {
  /**
   * Nothing open; an input open for its level only; recording it; stopping,
   * while the last part is finished and packed; or a recording stopped by a
   * crash, whose parts are waiting to be opened.
   */
  state: 'idle' | 'monitoring' | 'recording' | 'stopping' | 'interrupted';
  /** The input open, and what it gives. */
  device?: string;
  input?: RecordInput;
  plan?: RecordPlan;
  /** How long it has been recording. */
  seconds: number;
  /** What has been written, and in how many parts. */
  bytes: number;
  parts: number;
  /** Room left on the drive, and how long that lasts at this rate; null where it cannot be told. */
  freeBytes: number | null;
  secondsLeft: number | null;
  /** Whether the level comes in: not for a recording picked up after the app was closed, which sends it to no one. */
  live: boolean;
  /** Whether the parts are being packed into FLAC, after the recording has stopped. */
  packing?: boolean;
  /** Something to know about: no sound coming in, or why the recording stopped. */
  problem?: string;
  /** The parts of an interrupted recording. */
  files?: string[];
}

/** Chromium's capture, in the hidden page: the fallback. */
export interface Capture {
  list(): Promise<RecordDevice[]>;
  start(device: string): Promise<RecordInput>;
  stop(): Promise<void>;
}

/** What a recording's lock file says. */
interface Lock {
  /** The ffmpeg writing the parts, and the helper capturing for it, if it is one. */
  pid: number;
  helperPid?: number;
  plan: RecordPlan;
  input: RecordInput;
  started: number;
}

/** The meters are sent this often, in milliseconds. */
const LEVELS_EVERY_MS = 100;
/** The status, with the files' sizes and the drive's room, this often. */
const STATUS_EVERY_MS = 1000;
/** An input that sends no sound for this long has stopped working. */
const SILENT_INPUT_MS = 3000;
/** How long the helper has to open a device before it is given up on. */
const OPEN_TIMEOUT_MS = 10_000;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const ended = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((done) => child.once('exit', () => done()));

/** Runs ffmpeg to its end. */
function run(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((done) => {
    const child = spawn(ffmpeg(), args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      done();
    });
    child.on('error', () => done());
  });
}

/** A device the helper can open: its id for it, and how many channels it has. */
interface HelperDevice {
  id: string;
  channels: number;
}

/** A helper at work: monitoring, or recording into the writing ffmpeg. */
interface Helper {
  child: ChildProcess;
  input: RecordInput;
  /** What it said last went wrong, for when it ends. */
  said?: string;
}

const IDLE: RecordStatus = { state: 'idle', seconds: 0, bytes: 0, parts: 0, freeBytes: null, secondsLeft: null, live: false };

export class Recorder {
  readonly #lockFile: string;
  readonly #logFile: string;
  readonly #partSeconds: number;
  readonly #capture: Capture;
  /** The capture helper's program, or null where there is none. */
  readonly #helperPath: string | null;
  /** In check mode: the helper's test interface only, so that no real input is opened. */
  readonly #testing: boolean;
  readonly #send: (channel: 'record-status' | 'record-levels', value: unknown) => void;
  readonly #awake: { start(): number; stop(id: number): void };

  #status: RecordStatus = IDLE;
  /** The devices the helper listed, by name. */
  #helperDevices = new Map<string, HelperDevice>();
  /** The input open, how, and which two of its channels are left and right. */
  #device: string | null = null;
  #input: RecordInput | null = null;
  #via: 'helper' | 'chromium' | null = null;
  #channels: [number, number] = [0, 1];
  #monitor: Helper | null = null;
  #recordHelper: Helper | null = null;
  #lock: Lock | null = null;
  #writer: ChildProcess | null = null;
  /** For a recording picked up after a restart: nothing of it is ours but its process ids. */
  #adopted = false;
  #frames = 0;
  #gathered: Levels = { peak: [0, 0], meanSquare: [0, 0], frames: 0 };
  #lastSound = 0;
  #timers: ReturnType<typeof setInterval>[] = [];
  #awakeId: number | null = null;
  /** Parts being packed into FLAC, one after another, and those handed over to be. */
  #packing: Promise<void> = Promise.resolve();
  #queued = new Set<string>();

  constructor(options: {
    folder: string;
    partSeconds?: number;
    capture: Capture;
    helper: string | null;
    testing: boolean;
    send: (channel: 'record-status' | 'record-levels', value: unknown) => void;
    awake: { start(): number; stop(id: number): void };
  }) {
    this.#lockFile = join(options.folder, 'recording.json');
    this.#logFile = join(options.folder, 'recording.log');
    this.#partSeconds = options.partSeconds ?? PART_SECONDS;
    this.#capture = options.capture;
    this.#helperPath = options.helper;
    this.#testing = options.testing;
    this.#send = options.send;
    this.#awake = options.awake;
  }

  get status(): RecordStatus {
    return this.#status;
  }

  get recording(): boolean {
    return this.#status.state === 'recording' || this.#status.state === 'stopping';
  }

  /**
   * The devices to record from: the helper's, with all their channels, or
   * Chromium's where there is no helper or it cannot list them. In check mode,
   * the test signals of both.
   */
  async devices(): Promise<RecordDevice[]> {
    const listed = await this.#helperList();
    this.#helperDevices = new Map(listed.map((device) => [device.name, device]));
    const chromium = listed.length === 0 || this.#testing ? await this.#capture.list() : [];
    return [...listed.map(({ name, channels }) => ({ name, channels })), ...chromium.filter((device) => !this.#helperDevices.has(device.name))];
  }

  async #helperList(): Promise<(HelperDevice & { name: string })[]> {
    if (!this.#helperPath) return [];
    const printed = await new Promise<string>((done) => {
      const child = spawn(this.#helperPath!, ['list', ...(this.#testing ? ['--test'] : [])], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('close', () => done(out));
      child.on('error', () => done(''));
    });
    try {
      const devices = JSON.parse(printed) as { id: string; name: string; channels: number }[];
      // In check mode nothing real is opened, unless asked for by DJMASTER_REAL_INPUTS (main.ts).
      return devices.filter((device) => !this.#testing || device.id === 'test' || process.env.DJMASTER_REAL_INPUTS);
    } catch {
      return [];
    }
  }

  /** Opens an input for its level, closing the one open before; null closes it. Not while recording. */
  async monitor(device: string | null): Promise<RecordStatus> {
    if (this.recording) throw new Error('A recording is running.');
    if (device === this.#device && this.#input) return this.#status;
    await this.#closeInput();
    const keep = this.#status.state === 'interrupted' ? this.#status : null;
    if (!device) return this.#set(keep ? { ...keep, device: undefined, input: undefined } : { ...IDLE });
    try {
      const helper = this.#helperDevices.get(device);
      if (helper && this.#helperPath) {
        try {
          this.#monitor = await this.#openHelper(helper, this.#channels, false);
          this.#input = this.#monitor.input;
          this.#via = 'helper';
        } catch (error) {
          // A device the helper cannot open may still be one Chromium can, as far as its first two channels.
          const chromium = (await this.#capture.list().catch(() => [])).find((d) => d.name.startsWith(device));
          if (!chromium) throw error;
          this.#input = await this.#capture.start(chromium.name);
          this.#via = 'chromium';
        }
      } else {
        this.#input = await this.#capture.start(device);
        this.#via = 'chromium';
      }
    } catch (error) {
      this.#set(keep ?? { ...IDLE });
      throw error;
    }
    this.#device = device;
    this.#lastSound = Date.now();
    this.#startTimers();
    // A recording a crash cut short is still offered while the input is listened to.
    if (keep) return this.#set({ ...keep, device, input: this.#input });
    return this.#set({ ...IDLE, state: 'monitoring', device, input: this.#input });
  }

  /** Which two of the input's channels are heard, and recorded, as left and right. */
  async setChannels(channels: [number, number]) {
    if (this.recording || (channels[0] === this.#channels[0] && channels[1] === this.#channels[1])) return;
    this.#channels = channels;
    // The helper is told its channels as it starts: it is started again with these.
    const helper = this.#device ? this.#helperDevices.get(this.#device) : undefined;
    if (this.#via === 'helper' && helper) {
      // Let go of first, so that its ending is not taken for the device going away.
      const old = this.#monitor;
      this.#monitor = null;
      await this.#stopHelper(old);
      this.#monitor = await this.#openHelper(helper, channels, false).catch(() => null);
      if (!this.#monitor) void this.inputEnded(`“${this.#device}” could not be opened again.`);
    }
  }

  /** What the capture page sends: the input's samples, its channels interleaved. */
  samples(samples: Float32Array) {
    if (!this.#input || this.#via !== 'chromium') return;
    const stereo = stereoOf(samples, this.#input.channels, this.#channels);
    const levels = measureStereo(stereo);
    this.#addLevels(levels);
    if (this.#writer && this.#status.state === 'recording') {
      this.#writer.stdin!.write(Buffer.from(stereo.buffer, stereo.byteOffset, stereo.byteLength));
    }
  }

  /** The input went away: unplugged, or taken by the system. A recording ends there, with what it has. */
  async inputEnded(reason: string) {
    const lock = this.#lock;
    const wasRecording = this.recording;
    if (wasRecording) await this.#endRecording();
    const files = wasRecording && lock ? await this.#finish(lock) : [];
    await this.#closeInput();
    if (wasRecording) {
      this.#set({ ...IDLE, state: files.length ? 'interrupted' : 'idle', files, plan: lock?.plan, problem: `${reason} The recording stopped there; what was recorded until then is kept.` });
    } else {
      this.#set({ ...IDLE, problem: reason });
    }
  }

  async start(plan: RecordPlan): Promise<RecordStatus> {
    if (this.recording) throw new Error('A recording is running already.');
    await this.setChannels(plan.channels);
    await this.monitor(plan.device);
    const taken = (await readdir(plan.folder).catch(() => [] as string[])).some((file) => isPartOf(file, plan));
    if (taken) throw new Error(`There is a recording called “${plan.name}” in that folder already.`);
    let input = this.#input!;
    const log = openSync(this.#logFile, 'w');
    try {
      if (this.#via === 'helper') {
        // A helper of its own, whose sound goes to ffmpeg without passing through here, and outlives the app.
        const monitor = this.#monitor;
        this.#monitor = null;
        await this.#stopHelper(monitor);
        const helper = await this.#openHelper(this.#helperDevices.get(plan.device)!, plan.channels, true);
        input = helper.input;
        this.#recordHelper = helper;
        this.#writer = spawn(ffmpeg(), writerArgs(plan, input.sampleRate, this.#partSeconds), { detached: true, stdio: [helper.child.stdout!, 'ignore', log] });
        // Ours is not needed: were it kept open, the helper would not notice ffmpeg had gone.
        helper.child.stdout!.destroy();
      } else {
        this.#writer = spawn(ffmpeg(), writerArgs(plan, input.sampleRate, this.#partSeconds), { stdio: ['pipe', 'ignore', log] });
        this.#writer.stdin!.on('error', () => {});
      }
    } finally {
      closeSync(log);
    }
    const writer = this.#writer;
    this.#frames = 0;
    this.#adopted = false;
    this.#lock = { pid: writer.pid!, ...(this.#recordHelper ? { helperPid: this.#recordHelper.child.pid } : {}), plan, input, started: Date.now() };
    await writeFile(this.#lockFile, JSON.stringify(this.#lock));
    this.#awakeId = this.#awake.start();
    writer.on('exit', () => {
      if (this.#writer === writer) this.#writer = null;
      // Ended without being asked to: the drive is full, the input went away, or ffmpeg failed.
      if (this.#status.state === 'recording' && this.#lock) void this.#writerFailed(this.#lock);
    });
    this.#set({ ...this.#status, state: 'recording', plan, input, live: true, problem: undefined });
    void this.#update();
    return this.#status;
  }

  /** Stops the recording, and gives its parts in order, each put right to be read. The input stays open. */
  async stop(): Promise<string[]> {
    const lock = this.#lock;
    if (!lock || this.#status.state !== 'recording') return [];
    this.#set({ ...this.#status, state: 'stopping' });
    await this.#endRecording();
    const files = await this.#finish(lock);
    this.#adopted = false;
    // The helper's own input, closed with the recording, is opened again for its level.
    const device = this.#device;
    if (device && this.#via === 'helper' && !this.#monitor) {
      this.#input = null;
      this.#device = null;
      await this.monitor(device).catch(() => this.#set({ ...IDLE }));
    } else {
      this.#set(this.#monitoring());
    }
    return files;
  }

  /** Closes the input, unless a recording needs it. */
  async close() {
    if (!this.recording) await this.monitor(null);
  }

  /**
   * At the start of the app: a recording the last run left. One the helper
   * makes is still going, and is followed as far as it can be: its level
   * went to the app that is gone. One whose ffmpeg has ended is put right
   * and offered to be opened.
   */
  async adopt(): Promise<RecordStatus> {
    const lock = await readFile(this.#lockFile, 'utf8').then((text) => JSON.parse(text) as Lock, () => null);
    if (!lock || typeof lock.pid !== 'number' || !lock.plan) return this.#status;
    if (lock.helperPid && alive(lock.helperPid) && alive(lock.pid)) {
      this.#lock = lock;
      this.#adopted = true;
      this.#device = lock.plan.device;
      this.#awakeId = this.#awake.start();
      this.#startTimers();
      return this.#set({ ...IDLE, state: 'recording', plan: lock.plan, input: lock.input, live: false });
    }
    for (const pid of [lock.helperPid, lock.pid]) {
      if (pid && alive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Gone by now.
        }
      }
    }
    const files = await this.#finish(lock);
    return this.#set({ ...IDLE, state: files.length ? 'interrupted' : 'idle', files, plan: lock.plan, problem: 'The app was closed while recording, and the recording stopped with it.' });
  }

  /** Forgets an interrupted recording, once it has been opened or put aside. */
  dismiss() {
    if (this.#status.state === 'interrupted') this.#set(this.#monitoring());
  }

  /** The status of the input open for its level, or of nothing open. */
  #monitoring(): RecordStatus {
    return this.#input && this.#device ? { ...IDLE, state: 'monitoring', device: this.#device, input: this.#input, live: true } : { ...IDLE };
  }

  #set(status: RecordStatus): RecordStatus {
    this.#status = status;
    this.#send('record-status', status);
    return status;
  }

  /**
   * Starts the helper on a device: for its level only, or with its sound on
   * stdout for the writing ffmpeg, detached so that it outlives the app. Waits
   * until it says the device is open.
   */
  #openHelper(device: HelperDevice, channels: [number, number], output: boolean): Promise<Helper> {
    const child = spawn(this.#helperPath!, ['record', '--device', device.id, '--channels', `${channels[0] + 1},${channels[1] + 1}`, ...(output ? [] : ['--no-output'])], {
      detached: output,
      stdio: ['pipe', output ? 'pipe' : 'ignore', 'pipe'],
    });
    child.stdin!.on('error', () => {});
    return new Promise((done, fail) => {
      const helper: Helper = { child, input: { channels: device.channels, sampleRate: 0 } };
      let opened = false;
      let rest = '';
      const timer = setTimeout(() => {
        if (opened) return;
        child.kill();
        fail(new Error('The input did not open.'));
      }, OPEN_TIMEOUT_MS);
      child.stderr!.on('data', (chunk) => {
        rest += chunk;
        const lines = rest.split('\n');
        rest = lines.pop()!;
        for (const line of lines) {
          let said: { started?: { rate: number }; levels?: Levels; lost?: number; error?: string };
          try {
            said = JSON.parse(line);
          } catch {
            continue;
          }
          if (said.started && !opened) {
            opened = true;
            clearTimeout(timer);
            helper.input = { channels: device.channels, sampleRate: said.started.rate };
            done(helper);
          } else if (said.levels) {
            this.#addLevels(said.levels);
            if (this.#recordHelper === helper) this.#frames += said.levels.frames;
          } else if (said.lost) {
            this.#set({ ...this.#status, problem: `${said.lost} frames could not be kept: the drive could not keep up. The recording goes on.` });
          } else if (said.error) {
            helper.said = said.error;
            if (!opened) {
              clearTimeout(timer);
              fail(new Error(said.error));
            }
          }
        }
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        if (!opened) fail(error);
      });
      child.on('exit', () => {
        clearTimeout(timer);
        if (!opened) fail(new Error(helper.said ?? 'The input could not be opened.'));
        // A monitor that ends by itself has lost its device. A recording's helper ending ends its ffmpeg, seen to there.
        else if (this.#monitor === helper) {
          this.#monitor = null;
          void this.inputEnded(helper.said ? `${helper.said}` : `“${this.#device}” went away.`);
        }
      });
    });
  }

  /** Asks a helper to stop, and waits for it; one that will not is ended. */
  async #stopHelper(helper: Helper | null) {
    if (!helper) return;
    const done = ended(helper.child);
    helper.child.stdin!.write('q');
    const timer = setTimeout(() => helper.child.kill('SIGKILL'), 5000);
    await done;
    clearTimeout(timer);
  }

  async #closeInput() {
    const monitor = this.#monitor;
    this.#monitor = null;
    await this.#stopHelper(monitor);
    if (this.#via === 'chromium') await this.#capture.stop();
    this.#device = null;
    this.#input = null;
    this.#via = null;
    this.#stopTimers();
  }

  /** Ends the writing: the helper asked to stop, or ffmpeg's stdin closed; either way ffmpeg finishes its part. */
  async #endRecording() {
    const lock = this.#lock;
    const writer = this.#writer;
    const helper = this.#recordHelper;
    this.#recordHelper = null;
    if (helper) {
      await this.#stopHelper(helper);
    } else if (this.#adopted && lock?.helperPid) {
      // Picked up after a restart: its stdin is gone with the app before, so it is ended, and ffmpeg sees its input end.
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        try {
          process.kill(lock.helperPid, signal);
        } catch {
          break;
        }
        const until = Date.now() + 3000;
        while (alive(lock.helperPid) && Date.now() < until) await new Promise((done) => setTimeout(done, 50));
        if (!alive(lock.helperPid)) break;
      }
    } else if (writer) {
      writer.stdin?.end();
    }
    if (writer) {
      const timer = setTimeout(() => writer.kill('SIGKILL'), 15_000);
      await ended(writer);
      clearTimeout(timer);
    } else if (lock && alive(lock.pid)) {
      const until = Date.now() + 15_000;
      while (alive(lock.pid) && Date.now() < until) await new Promise((done) => setTimeout(done, 50));
      if (alive(lock.pid)) process.kill(lock.pid, 'SIGKILL');
    }
    this.#writer = null;
  }

  async #writerFailed(lock: Lock) {
    const said = this.#recordHelper?.said ?? (await readFile(this.#logFile, 'utf8').catch(() => '')).split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
    await this.#stopHelper(this.#recordHelper);
    this.#recordHelper = null;
    const files = await this.#finish(lock);
    const device = this.#device;
    // The input of a helper's recording went with it; it is listened to again if it is still there.
    if (this.#via === 'helper' && device) {
      this.#input = null;
      this.#device = null;
      await this.monitor(device).catch(() => {});
    }
    this.#set({
      ...this.#monitoring(), ...(files.length ? { state: 'interrupted' as const, files, plan: lock.plan } : {}),
      problem: `The recording stopped by itself${said ? `: ${said}` : ''}. What was recorded until then is kept.`,
    });
  }

  #addLevels(levels: Levels) {
    const g = this.#gathered;
    const total = g.frames + levels.frames;
    if (total === 0) return;
    for (const c of [0, 1]) {
      g.peak[c] = Math.max(g.peak[c], levels.peak[c]);
      g.meanSquare[c] = (g.meanSquare[c] * g.frames + levels.meanSquare[c] * levels.frames) / total;
    }
    g.frames = total;
    this.#lastSound = Date.now();
    if (this.#via === 'chromium' && this.#status.state === 'recording') this.#frames += levels.frames;
  }

  #startTimers() {
    this.#stopTimers();
    this.#timers.push(setInterval(() => this.#sendLevels(), LEVELS_EVERY_MS));
    this.#timers.push(setInterval(() => void this.#update(), STATUS_EVERY_MS));
  }

  #sendLevels() {
    const g = this.#gathered;
    if (g.frames === 0) return;
    this.#send('record-levels', { peak: g.peak, meanSquare: g.meanSquare, frames: g.frames } satisfies Levels);
    this.#gathered = { peak: [0, 0], meanSquare: [0, 0], frames: 0 };
  }

  async #update() {
    const state = this.#status.state;
    if (state !== 'monitoring' && state !== 'recording') return;
    const quiet = !this.#adopted && Date.now() - this.#lastSound > SILENT_INPUT_MS;
    const problem = quiet ? `No sound has come from “${this.#device}” for ${Math.round((Date.now() - this.#lastSound) / 1000)} seconds. Is it still connected?` : undefined;
    const lock = this.#lock;
    if (state === 'monitoring' || !lock) {
      if (problem !== this.#status.problem) this.#set({ ...this.#status, problem });
      return;
    }
    const { plan, input } = lock;
    const files = await this.#parts(plan);
    // Every part but the one being written is finished, and packed into FLAC if that is what was asked for.
    if (plan.format === 'flac') {
      for (const file of files.filter((f) => f.endsWith('.wav')).slice(0, -1)) if (wavFinished(file)) this.#pack(file);
    }
    const sizes = await Promise.all(files.map((file) => stat(file).then((s) => s.size, () => 0)));
    const bytes = sizes.reduce((sum, size) => sum + size, 0);
    const room = await statfs(plan.folder).then((s) => s.bavail * s.bsize, () => null);
    if (this.#status.state !== 'recording') return;
    // A recording picked up after a restart has no level coming in to count: its time is the clock's.
    const seconds = this.#adopted ? (Date.now() - lock.started) / 1000 : this.#frames / input.sampleRate;
    this.#set({
      ...this.#status, seconds, bytes, parts: files.length, freeBytes: room,
      secondsLeft: room === null ? null : room / bytesPerSecond(input.sampleRate, plan.format),
      problem: problem ?? (this.#status.problem?.includes('could not be kept') ? this.#status.problem : undefined),
    });
  }

  async #parts(plan: RecordPlan): Promise<string[]> {
    const names = await readdir(plan.folder).catch(() => [] as string[]);
    return names.filter((name) => isPartOf(name, plan)).sort().map((name) => join(plan.folder, name));
  }

  /**
   * Packs a finished part into FLAC, after those before it. The WAV goes only
   * once the FLAC holds as much sound; one that does not is left as WAV, and
   * a crash on the way leaves the WAV and a half-written file that is ignored.
   */
  #pack(wav: string) {
    if (this.#queued.has(wav)) return;
    this.#queued.add(wav);
    this.#packing = this.#packing.then(async () => {
      const flac = wav.replace(/\.wav$/, '.flac');
      const packing = wav.replace(/\.wav$/, '.packing');
      await run(packArgs(wav, packing), 10 * 60_000);
      const [was, now] = await Promise.all([probe(wav).catch(() => null), probe(packing).catch(() => null)]);
      if (was && now && Math.abs(was.duration - now.duration) < 0.05) {
        await rename(packing, flac);
        await rm(wav, { force: true });
      } else {
        // Tried again next time round, and once more as the recording ends.
        await rm(packing, { force: true });
        this.#queued.delete(wav);
      }
    });
  }

  /**
   * After a recording: its parts, each with its header put right and packed
   * into FLAC if that was asked for, and the lock let go. Packing takes a few
   * seconds a part, so there may be a wait for those not done yet.
   */
  async #finish(lock: Lock): Promise<string[]> {
    const { plan } = lock;
    const names = await readdir(plan.folder).catch(() => [] as string[]);
    for (const name of names) {
      // Left by a crash while packing: the part is still there as WAV.
      if (name.startsWith(`${plan.name} part `) && name.endsWith('.packing')) await rm(join(plan.folder, name), { force: true });
    }
    let files = await this.#parts(plan);
    for (const file of files) if (file.endsWith('.wav')) repairWav(file);
    let problem: string | undefined;
    if (plan.format === 'flac') {
      this.#set({ ...this.#status, state: 'stopping', packing: true });
      // Twice over: a part that would not pack while recording, as it was not finished yet, is done after.
      for (let round = 0; round < 2; round++) {
        await this.#packing;
        files = await this.#parts(plan);
        for (const file of files) {
          // Packed already, but the WAV not yet taken away: the FLAC was checked before it was named so.
          if (file.endsWith('.wav') && files.includes(file.replace(/\.wav$/, '.flac'))) await rm(file, { force: true });
          else if (file.endsWith('.wav')) this.#pack(file);
        }
      }
      await this.#packing;
      files = await this.#parts(plan);
      // A part that could not be packed would keep the recording from opening as one: say so.
      const unpacked = files.filter((file) => file.endsWith('.wav')).length;
      if (unpacked) problem = `${unpacked === 1 ? 'One part' : `${unpacked} parts`} could not be packed into FLAC and ${unpacked === 1 ? 'is' : 'are'} kept as WAV.`;
    }
    this.#queued.clear();
    await rm(this.#lockFile, { force: true });
    if (this.#awakeId !== null) this.#awake.stop(this.#awakeId);
    this.#awakeId = null;
    this.#lock = null;
    if (problem) this.#set({ ...this.#status, problem });
    return files;
  }

  #stopTimers() {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
  }
}
