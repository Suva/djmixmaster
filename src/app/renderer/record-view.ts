// The Record view: an audio input recorded to files, by the main process
// (recorder.ts), with its level, how long it has run and how much room is
// left. It takes the place of the recording's views while shown; a recording
// goes on while other views are, and the bar at the bottom says so.

import type { Api, Levels, RecordFormat, RecordSettings, RecordStatus } from '../api.ts';
import { clock } from './draw.ts';
import { colours, onThemeChange } from './theme.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** The meter's scale, in dBFS. */
const METER_FLOOR_DB = -60;
/** How long the highest level stays marked, and a clip lit, in milliseconds. */
const PEAK_HOLD_MS = 1500;
const CLIP_HOLD_MS = 4000;
/** A sample this near full scale counts as a clip. */
const CLIP_LEVEL = 0.999;
/** How long Stop waits for its second press before it goes back to how it was. */
const CONFIRM_MS = 3000;

/** A size in bytes as a person would say it. */
function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

/** A long time, roughly: how long the drive lasts. */
function roughly(seconds: number): string {
  const hours = seconds / 3600;
  if (hours >= 2) return `about ${Math.floor(hours)} hours`;
  return `about ${Math.max(1, Math.round(seconds / 60))} minutes`;
}

const today = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Recording ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
};

export class RecordView {
  readonly #api: Api;
  readonly #say: (text: string) => void;
  /** Called when the view should be left for the recording just made, opened in Mastering. */
  readonly #done: () => void;
  /** Called when the view should be shown: for a recording found running or cut short as the app starts. */
  readonly #reveal: () => void;
  #settings: RecordSettings = { device: null, channels: [0, 1], format: 'wav', folder: '' };
  #status: RecordStatus | null = null;
  #visible = false;
  #confirming: ReturnType<typeof setTimeout> | null = null;
  /** The meter: what came in last, the highest lately, and when each channel last clipped. */
  #levels: Levels | null = null;
  #held: { db: number; at: number }[] = [{ db: -Infinity, at: 0 }, { db: -Infinity, at: 0 }];
  #clipped = [-Infinity, -Infinity];
  /** Whether a stop was asked for here, so that the view gives way to the recording once it is open. */
  #stopping = false;

  constructor(api: Api, options: { say: (text: string) => void; done: () => void; reveal: () => void }) {
    this.#api = api;
    this.#say = options.say;
    this.#done = options.done;
    this.#reveal = options.reveal;
    api.onRecordStatus((status) => this.#show(status));
    api.onRecordLevels((levels) => {
      this.#levels = levels;
      const now = performance.now();
      levels.peak.forEach((peak, c) => {
        const db = 20 * Math.log10(Math.max(peak, 1e-6));
        if (db >= this.#held[c].db || now - this.#held[c].at > PEAK_HOLD_MS) this.#held[c] = { db, at: now };
        if (peak >= CLIP_LEVEL) this.#clipped[c] = now;
      });
      if (this.#visible) this.#drawMeter();
    });
    onThemeChange(() => this.#drawMeter());

    $<HTMLSelectElement>('record-device').addEventListener('change', (event) => {
      // A device of its own: its first two channels, left and right, until another pair is chosen.
      this.#settings = { ...this.#settings, device: (event.target as HTMLSelectElement).value, channels: [0, 1] };
      void this.#monitor();
    });
    $<HTMLSelectElement>('record-channels').addEventListener('change', (event) => {
      const [a, b] = (event.target as HTMLSelectElement).value.split(',').map(Number);
      this.#settings = { ...this.#settings, channels: [a, b] };
      api.recordChannels([a, b]);
    });
    $('record-folder-change').addEventListener('click', async () => {
      const folder = await api.recordChooseFolder();
      if (folder) this.#settings = { ...this.#settings, folder };
      this.#showSettings();
    });
    for (const button of document.querySelectorAll<HTMLButtonElement>('#record-format button')) {
      button.addEventListener('click', () => {
        this.#settings = { ...this.#settings, format: button.dataset.format as RecordFormat };
        this.#showSettings();
      });
    }
    $('record-go').addEventListener('click', () => void this.#go());
    $('record-open-interrupted').addEventListener('click', () => {
      this.#stopping = true;
      void api.recordOpenInterrupted();
    });
    $('record-dismiss').addEventListener('click', () => api.recordDismiss());
    $('record-indicator').addEventListener('click', () => this.#reveal());
  }

  get visible(): boolean {
    return this.#visible;
  }

  get recording(): boolean {
    return this.#status?.state === 'recording' || this.#status?.state === 'stopping';
  }

  /**
   * Shows or hides the view. Shown, it lists the devices and opens the one
   * chosen, so that its level shows before anything is recorded; left, the
   * input is closed again, unless it is being recorded.
   */
  async show(on: boolean) {
    this.#visible = on;
    $('record-view').hidden = !on;
    if (!on) {
      if (!this.recording) await this.#api.recordClose();
      return;
    }
    const setup = await this.#api.recordSetup();
    const { status } = setup;
    const recording = status.state === 'recording' || status.state === 'stopping';
    // While recording, the choices are the recording's own; otherwise those last used.
    if (recording && status.plan) this.#settings = { ...this.#settings, ...status.plan };
    else this.#settings = setup.settings;
    const devices = $<HTMLSelectElement>('record-device');
    devices.replaceChildren(...setup.devices.map((device) => new Option(device.name, device.name)));
    if (setup.devices.length === 0) devices.append(new Option(setup.problem ? 'Nothing to record from' : 'No inputs found', ''));
    const wanted = recording ? status.plan?.device : status.device ?? this.#settings.device;
    const chosen = setup.devices.find((device) => device.name === wanted) ?? setup.devices[0];
    // The channels last used go with the device they were used on; another one starts at its first two.
    if (chosen && chosen.name !== this.#settings.device) this.#settings = { ...this.#settings, channels: [0, 1] };
    this.#settings = { ...this.#settings, device: chosen?.name ?? null };
    if (chosen) devices.value = chosen.name;
    $('record-device-note').textContent = setup.problem ?? '';
    const name = $<HTMLInputElement>('record-name');
    if (recording && status.plan) name.value = status.plan.name;
    else if (!name.value) name.value = today();
    this.#show(status);
    this.#showSettings();
    if (chosen && !recording) await this.#monitor();
    this.#drawMeter();
  }

  /** Opens the device chosen, for its level: nothing is written until Start recording. */
  async #monitor() {
    const device = this.#settings.device;
    if (!device || this.recording) return;
    $('record-device-note').textContent = 'Opening the device…';
    try {
      this.#api.recordChannels(this.#settings.channels);
      const status = await this.#api.recordMonitor(device);
      this.#show(status);
      const input = status.input;
      $('record-device-note').textContent = input ? `${input.channels === 1 ? '1 channel' : `${input.channels} channels`}, ${input.sampleRate / 1000} kHz.` : '';
    } catch (error) {
      $('record-device-note').textContent = message(error);
    }
    this.#showSettings();
  }

  #showSettings() {
    const busy = this.recording;
    const input = this.#status?.input ?? null;
    const channels = $<HTMLSelectElement>('record-channels');
    const count = input?.channels ?? 2;
    const pairs: [number, number][] = count === 1 ? [[0, 0]] : Array.from({ length: Math.floor(count / 2) }, (_, i) => [i * 2, i * 2 + 1]);
    const singles: [number, number][] = count > 1 ? Array.from({ length: count }, (_, i) => [i, i]) : [];
    channels.replaceChildren(
      ...pairs.map(([a, b]) => new Option(a === b ? '1, on both sides' : `${a + 1} and ${b + 1}`, `${a},${b}`)),
      ...singles.map(([a]) => new Option(`${a + 1} alone, on both sides`, `${a},${a}`)),
    );
    const wanted = this.#settings.channels.join(',');
    channels.value = [...channels.options].some((o) => o.value === wanted) ? wanted : channels.options[0]?.value ?? '';
    const [a, b] = channels.value.split(',').map(Number);
    if (channels.value) this.#settings = { ...this.#settings, channels: [a, b] };
    const folder = $('record-folder');
    folder.textContent = `‎${this.#settings.folder}‎`;
    folder.title = this.#settings.folder;
    for (const button of document.querySelectorAll<HTMLButtonElement>('#record-format button')) {
      button.classList.toggle('on', button.dataset.format === this.#settings.format);
      button.disabled = busy;
    }
    for (const id of ['record-device', 'record-channels', 'record-name', 'record-folder-change']) $<HTMLInputElement>(id).disabled = busy;
    $<HTMLButtonElement>('record-go').disabled = !busy && (!input || !this.#settings.device);
  }

  async #go() {
    if (this.#status?.state === 'stopping') return;
    const button = $<HTMLButtonElement>('record-go');
    if (this.recording) {
      // Stopping is asked for twice, as a press by mistake would end the night's recording.
      if (!this.#confirming) {
        button.textContent = 'Press again to stop';
        button.classList.add('confirming');
        this.#confirming = setTimeout(() => this.#unconfirm(), CONFIRM_MS);
        return;
      }
      this.#unconfirm();
      this.#stopping = true;
      await this.#api.recordStop();
      return;
    }
    const { device, channels, format, folder } = this.#settings;
    if (!device) return;
    const name = $<HTMLInputElement>('record-name').value.trim();
    try {
      button.disabled = true;
      this.#show(await this.#api.recordStart({ device, channels, format, folder, name }));
      this.#say(`Recording “${name}”.`);
    } catch (error) {
      this.#say('');
      this.#problem(message(error));
      button.disabled = false;
    }
  }

  #unconfirm() {
    if (this.#confirming) clearTimeout(this.#confirming);
    this.#confirming = null;
    $('record-go').classList.remove('confirming');
    this.#showGo();
  }

  #problem(text: string | undefined) {
    $('record-problem').hidden = !text;
    $('record-problem').textContent = text ?? '';
  }

  #showGo() {
    const state = this.#status?.state ?? 'idle';
    if (this.#confirming) return;
    $('record-go').textContent = state === 'recording' ? 'Stop recording' : state === 'stopping' ? 'Stopping…' : 'Start recording';
  }

  #show(status: RecordStatus) {
    const was = this.#status?.state;
    this.#status = status;
    const recording = this.recording;
    document.body.classList.toggle('recording', recording);
    $('record-state').textContent =
      status.state === 'recording' ? `Recording “${status.plan?.name}”`
      : status.state === 'stopping' ? (status.packing ? 'Packing the parts into FLAC…' : 'Stopping…')
      : status.state === 'monitoring' ? 'Ready: set the level, then start recording'
      : 'Not recording';
    $('record-time').textContent = clock(status.seconds);
    $('record-written').textContent = recording ? `${size(status.bytes)}${status.parts > 1 ? ` in ${status.parts} parts` : ''}` : '–';
    $('record-room').textContent =
      recording && status.freeBytes !== null && status.secondsLeft !== null ? `${size(status.freeBytes)}, ${roughly(status.secondsLeft)} more` : '–';
    $('record-as').textContent = status.input && status.plan && recording
      ? `${status.input.sampleRate / 1000} kHz, 24-bit ${status.plan.format === 'flac' ? 'FLAC' : 'WAV'}, in ${status.plan.folder}`
      : '–';
    const lowOnRoom = recording && status.secondsLeft !== null && status.secondsLeft < 3600;
    this.#problem(status.problem ?? (lowOnRoom ? `Less than an hour of room is left on the drive: ${roughly(status.secondsLeft!)}.` : undefined));
    if (recording && !status.live) {
      this.#problem('This recording was started before the app was last closed, and has gone on since. Its level cannot be shown; Stop ends it as usual.');
    }
    $('record-interrupted').hidden = status.state !== 'interrupted';
    if (status.state === 'interrupted') {
      const parts = status.files?.length ?? 0;
      $('record-interrupted-text').textContent = `“${status.plan?.name}” stopped before it was ended: ${status.problem ?? ''} ${parts === 1 ? 'Its file is' : `Its ${parts} parts are`} in ${status.plan?.folder}.`;
      this.#problem(undefined);
    }
    const indicator = $('record-indicator');
    indicator.hidden = !recording || this.#visible;
    indicator.textContent = `● Recording ${clock(status.seconds)}`;
    if (status.state !== 'recording' && status.state !== 'monitoring' && status.state !== 'stopping') this.#levels = null;
    this.#showGo();
    this.#showSettings();
    if (this.#visible) this.#drawMeter();
    // Found as the app starts: one still going after the app was closed, or one a crash cut short, is shown straight away.
    if (!this.#visible && (status.state === 'interrupted' || (was === undefined && recording && !status.live))) this.#reveal();
    // Stopped from here: once the recording has been handed over to be opened, Mastering shows it.
    if (this.#stopping && (was === 'stopping' || was === 'interrupted') && (status.state === 'idle' || status.state === 'monitoring')) {
      this.#stopping = false;
      $<HTMLInputElement>('record-name').value = '';
      this.#done();
    }
  }

  /** Two bars, left over right: the level now, the highest of the last moment as a line, and a light that stays lit after a clip. */
  #drawMeter() {
    const canvas = $<HTMLCanvasElement>('record-meter');
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width) return;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // What the bars show, in dBFS, for scripted checks.
    canvas.dataset.level = this.#levels ? this.#levels.peak.map((peak) => (20 * Math.log10(Math.max(peak, 1e-6))).toFixed(1)).join(',') : '';
    canvas.dataset.clipped = this.#clipped.map((at) => performance.now() - at < CLIP_HOLD_MS).join(',');
    const labelWidth = 18;
    const clipWidth = 34;
    const left = labelWidth;
    const right = width - clipWidth - 6;
    const xOf = (db: number) => left + ((Math.max(METER_FLOOR_DB, Math.min(0, db)) - METER_FLOOR_DB) / -METER_FLOOR_DB) * (right - left);
    const bar = 26;
    const now = performance.now();
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (const c of [0, 1]) {
      const top = 6 + c * (bar + 8);
      ctx.fillStyle = colours.off;
      ctx.fillRect(left, top, right - left, bar);
      ctx.fillStyle = colours.text;
      ctx.textAlign = 'left';
      ctx.fillText(c === 0 ? 'L' : 'R', 2, top + bar / 2);
      const levels = this.#levels;
      if (levels) {
        const rms = 10 * Math.log10(Math.max(levels.meanSquare[c], 1e-12));
        const peak = 20 * Math.log10(Math.max(levels.peak[c], 1e-6));
        // Green to the loud part, amber above -12 dBFS, red above -3.
        const stops: [number, number, string][] = [[METER_FLOOR_DB, -12, colours.after], [-12, -3, colours.gain], [-3, 0, colours.warn]];
        for (const [from, to, colour] of stops) {
          if (peak <= from) continue;
          ctx.globalAlpha = 0.45;
          ctx.fillStyle = colour;
          ctx.fillRect(xOf(from), top, xOf(Math.min(peak, to)) - xOf(from), bar);
          ctx.globalAlpha = 1;
          if (rms > from) ctx.fillRect(xOf(from), top + bar * 0.3, xOf(Math.min(rms, to)) - xOf(from), bar * 0.4);
        }
        const held = this.#held[c];
        if (now - held.at < PEAK_HOLD_MS && held.db > METER_FLOOR_DB) {
          ctx.fillStyle = held.db > -3 ? colours.warn : colours.label;
          ctx.fillRect(xOf(held.db) - 1, top, 2, bar);
        }
      }
      const clipped = now - this.#clipped[c] < CLIP_HOLD_MS;
      ctx.fillStyle = clipped ? colours.warn : colours.off;
      ctx.fillRect(right + 6, top, clipWidth, bar);
      ctx.fillStyle = clipped ? colours.ink : colours.text;
      ctx.textAlign = 'center';
      ctx.fillText('clip', right + 6 + clipWidth / 2, top + bar / 2);
    }
    // The scale under the bars.
    ctx.fillStyle = colours.text;
    ctx.textAlign = 'center';
    for (const db of [-60, -48, -36, -24, -12, -6, -3, 0]) ctx.fillText(String(db), xOf(db), height - 8);
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error));
