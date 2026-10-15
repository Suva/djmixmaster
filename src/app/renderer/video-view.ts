// The Video view of the main window: the selected mix's video as it will
// look, with its template and fields in the settings panel. It shares the
// recording timeline and the transport with the Mastering view; switching
// between the two (the bar at the bottom, or Tab) swaps the curves for the
// picture and the levelling settings for the template's fields.

import type { Api, VisualsChoice } from '../api.ts';
import type { Features } from '../../features.ts';
import { FrameDrawer } from '../../visuals/draw.ts';
import { MUSIC_NAMES, MusicReader } from '../../visuals/music.ts';
import { loadFonts } from '../../visuals/fonts.ts';
import { fontsOf, prepare, type Field, type PreparedLayer, type Template } from '../../visuals/template.ts';
import { fontPicker } from './font-picker.ts';
import { DEFAULT_TEMPLATE, drawVideoFrame, TEMPLATES as templates, templateOf, type VideoMix } from './video-frame.ts';

export type { VideoMix } from './video-frame.ts';

export interface VideoViewOptions {
  api: Api;
  /** The selected mix, or null when nothing is open. */
  mix(): VideoMix | null;
  /** The playhead, in seconds into the recording. */
  playhead(): number;
  /** Moves the playhead to this many seconds into the recording. */
  seek(seconds: number): void;
  /** How loud the selected mix is along its length, in this many steps, 0 to 1, from the analysis. */
  levels(points: number): Float32Array;
  /** The mix's template or a field changed here; the main window keeps it with the mix. */
  choose(choice: VisualsChoice): void;
  /** A line about what is going on, such as the music values being worked out. */
  say(text: string): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class VideoView {
  readonly #options: VideoViewOptions;
  readonly #canvas = $<HTMLCanvasElement>('picture');
  readonly #drawer = new FrameDrawer(this.#canvas);
  readonly #images = new Map<string, ImageBitmap>();
  #visible = false;
  #frame = 0;
  #lastFrame = performance.now();
  #lastPlayhead = 0;

  #featuresFor: string | null = null;
  #features: Features | null = null;
  #reader: MusicReader | null = null;
  #readerFor = '';

  /** What the fields on screen were made for, so they are rebuilt only when that changes. */
  #shownFor = '';
  #choice: VisualsChoice = { template: DEFAULT_TEMPLATE, fields: {} };
  #layers: PreparedLayer[] = [];

  constructor(options: VideoViewOptions) {
    this.#options = options;
    const select = $<HTMLSelectElement>('template');
    for (const [id, template] of templates) select.add(new Option(template.name, id));
    select.addEventListener('change', () => {
      // Fields of the same name carry over to the new template: the artist's name, the colour.
      this.#choice = { template: select.value, fields: this.#choice.fields };
      this.#prepare();
      this.#showFields();
      options.choose(this.#choice);
    });
    // Clicking or dragging on the strip under the picture moves the playhead within the mix.
    const strip = $<HTMLCanvasElement>('mix-strip');
    let dragging = false;
    const seekTo = (event: MouseEvent) => {
      const mix = options.mix();
      if (!mix) return;
      const box = strip.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
      options.seek(mix.start + fraction * (mix.end - mix.start));
    };
    strip.addEventListener('mousedown', (event) => {
      dragging = true;
      seekTo(event);
    });
    window.addEventListener('mousemove', (event) => dragging && seekTo(event));
    window.addEventListener('mouseup', () => (dragging = false));
    // Once started, the listening goes on, and is counted, in the Mastering view too.
    options.api.onListening((path, fraction) => {
      if (path === this.#featuresFor && !this.#features) this.#listening(fraction);
    });
  }

  get visible(): boolean {
    return this.#visible;
  }

  show(visible: boolean) {
    this.#visible = visible;
    cancelAnimationFrame(this.#frame);
    if (!visible) return;
    this.refresh();
    this.#lastFrame = performance.now();
    this.#frame = requestAnimationFrame(() => this.#draw());
  }

  /**
   * Catches up with the main window: another recording or mix selected, or
   * the mix's choice changed there (an undo). Fields are rebuilt only then,
   * never while they are being typed in.
   */
  refresh() {
    const mix = this.#options.mix();
    const choice = mix?.visuals ?? { template: DEFAULT_TEMPLATE, fields: {} };
    const key = `${mix?.path}|${mix?.number}|${JSON.stringify(choice)}`;
    if (mix?.path !== this.#featuresFor && this.#featuresFor !== null && !this.#features) {
      // Another recording, opened while this one was still being listened to: its count no longer means anything here.
      this.#featuresFor = null;
      this.#listening(1, true);
    }
    if (mix && mix.path !== this.#featuresFor && this.#visible) this.#loadFeatures(mix.path);
    if (key === this.#shownFor) return;
    this.#choice = choice;
    this.#prepare();
    this.#showFields();
  }

  async #loadFeatures(path: string) {
    this.#featuresFor = path;
    this.#features = null;
    this.#reader = null;
    this.#readerFor = '';
    this.#listening(null);
    try {
      const features = await this.#options.api.features(path);
      if (this.#featuresFor !== path) return;
      this.#features = features;
      this.#listening(1, true);
    } catch (error) {
      if (this.#featuresFor !== path) return;
      this.#listening(1, true);
      this.#options.say(`Could not listen to the recording: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Says how far the listening has got, in the status line and over the
   * picture, which stands still until it is done; `null` before the first
   * count. Done, the two are cleared.
   */
  #listening(fraction: number | null, done = false) {
    const notice = $('picture-notice');
    notice.hidden = done;
    if (done) return this.#options.say('');
    const count = fraction === null ? '' : ` ${Math.floor(fraction * 100)}%`;
    this.#options.say(`Listening to the recording for the video…${count}`);
    const line = document.createElement('small');
    line.textContent = 'The picture moves to the music once this is done.';
    notice.replaceChildren(`Listening to the recording for the video…${count}`, line);
  }

  #template(): Template {
    return templateOf(this.#choice);
  }

  #prepare() {
    this.#layers = prepare(this.#template(), this.#choice.fields, MUSIC_NAMES);
    // Until a font is in, its text is drawn in a plain face; the next frame after, in the font.
    loadFonts(fontsOf(this.#template(), this.#choice.fields));
    this.#drawer.reset();
    for (const field of this.#template().fields) {
      const value = this.#choice.fields[field.key];
      if (field.kind === 'image' && typeof value === 'string' && value) this.#loadImage(value);
    }
  }

  #setField(key: string, value: string | number) {
    this.#choice = { ...this.#choice, fields: { ...this.#choice.fields, [key]: value } };
    this.#prepare();
    // Kept with the mix at once; the main window saves it, and makes it an undo step, once typing pauses.
    const mix = this.#options.mix();
    this.#shownFor = `${mix?.path}|${mix?.number}|${JSON.stringify(this.#choice)}`;
    this.#options.choose(this.#choice);
  }

  async #loadImage(path: string) {
    if (this.#images.has(path)) return;
    try {
      const bytes = await this.#options.api.readImage(path);
      this.#images.set(path, await createImageBitmap(new Blob([bytes as BlobPart])));
    } catch (error) {
      this.#options.say(`Could not load the picture: ${error instanceof Error ? error.message : error}`);
    }
  }

  #showFields() {
    const mix = this.#options.mix();
    this.#shownFor = `${mix?.path}|${mix?.number}|${JSON.stringify(this.#choice)}`;
    const template = this.#template();
    $<HTMLSelectElement>('template').value = templates.has(this.#choice.template) ? this.#choice.template : DEFAULT_TEMPLATE;
    $('video-fields').replaceChildren(...template.fields.map((field) => this.#control(field)));
  }

  #control(field: Field): HTMLElement {
    const control = document.createElement('div');
    control.className = 'control';
    const head = document.createElement('div');
    head.className = 'control-head';
    const label = document.createElement('label');
    label.textContent = field.label;
    head.append(label);
    control.append(head);
    const value = this.#choice.fields[field.key] ?? field.default;
    const id = `field-${field.key}`;
    label.htmlFor = id;

    if (field.kind === 'colour') {
      const input = document.createElement('input');
      input.type = 'color';
      input.id = id;
      input.value = String(value).slice(0, 7);
      const shown = document.createElement('output');
      shown.textContent = input.value;
      input.addEventListener('input', () => {
        shown.textContent = input.value;
        this.#setField(field.key, input.value);
      });
      head.append(shown);
      control.append(input);
    } else if (field.kind === 'number') {
      const input = document.createElement('input');
      input.type = 'range';
      input.id = id;
      input.min = String(field.min ?? 0);
      input.max = String(field.max ?? 1);
      input.step = String(((field.max ?? 1) - (field.min ?? 0)) / 100);
      input.value = String(value);
      const shown = document.createElement('output');
      shown.textContent = Number(value).toFixed(2);
      input.addEventListener('input', () => {
        shown.textContent = Number(input.value).toFixed(2);
        this.#setField(field.key, Number(input.value));
      });
      head.append(shown);
      control.append(input);
    } else if (field.kind === 'image') {
      const row = document.createElement('div');
      row.className = 'image-field';
      const name = document.createElement('span');
      name.className = 'file';
      name.textContent = value ? String(value).split(/[\\/]/).pop()! : 'None';
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.id = id;
      choose.textContent = 'Choose…';
      choose.addEventListener('click', async () => {
        const path = await this.#options.api.pickImage();
        if (!path) return;
        name.textContent = path.split(/[\\/]/).pop()!;
        await this.#loadImage(path);
        this.#setField(field.key, path);
      });
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = 'Remove';
      clear.addEventListener('click', () => {
        name.textContent = 'None';
        this.#setField(field.key, '');
      });
      row.append(choose, clear, name);
      control.append(row);
    } else if (field.kind === 'font') {
      // The sample is what the font will set: the artist, or failing that the mix's name.
      const sample = () => {
        const mix = this.#options.mix();
        return mix?.artist || mix?.name || 'DJ Mix Master';
      };
      control.append(fontPicker(id, String(value), sample, (family) => this.#setField(field.key, family)));
    } else if (field.kind === 'choice') {
      const select = document.createElement('select');
      select.id = id;
      for (const option of field.choices ?? []) select.add(new Option(option, option));
      select.value = String(value);
      select.addEventListener('change', () => this.#setField(field.key, select.value));
      control.append(select);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = id;
      input.className = 'field-text';
      input.value = String(value);
      input.spellcheck = false;
      input.addEventListener('input', () => this.#setField(field.key, input.value));
      control.append(input);
    }
    return control;
  }

  #draw() {
    if (!this.#visible) return;
    this.#frame = requestAnimationFrame(() => this.#draw());
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.#lastFrame) / 1000);
    this.#lastFrame = now;
    const mix = this.#options.mix();
    const canvas = this.#canvas;
    if (!mix) return;

    // As large as fits the area at 16:9, drawn at the size it is shown (up to
    // that of the video) so it stays sharp and quick.
    const area = canvas.parentElement!;
    const shownWidth = Math.floor(Math.min(area.clientWidth, (area.clientHeight * 16) / 9));
    const shownHeight = Math.floor((shownWidth * 9) / 16);
    if (shownWidth <= 0) return;
    if (canvas.style.width !== `${shownWidth}px`) {
      canvas.style.width = `${shownWidth}px`;
      canvas.style.height = `${shownHeight}px`;
    }
    const ratio = window.devicePixelRatio || 1;
    const width = Math.min(1920, Math.round(shownWidth * ratio));
    const height = Math.round((width * 9) / 16);
    if (canvas.width !== width || canvas.height !== height) [canvas.width, canvas.height] = [width, height];

    const key = `${mix.path}|${mix.start}|${mix.end}`;
    if (this.#features && this.#readerFor !== key) {
      this.#reader = new MusicReader(this.#features, mix.start, mix.end);
      this.#readerFor = key;
    }
    const reader = this.#reader;
    const length = mix.end - mix.start;
    const playhead = this.#options.playhead();
    // A jump of the playhead: what layers remember belongs to the old place.
    if (Math.abs(playhead - this.#lastPlayhead) > 0.5) {
      this.#drawer.reset();
      for (const layer of this.#layers) layer.reset();
    }
    this.#lastPlayhead = playhead;
    const seconds = Math.max(0, Math.min(length, playhead - mix.start));
    drawVideoFrame(this.#drawer, this.#layers, reader, mix, seconds, dt, this.#images);
    // For scripted checks: whether the picture is drawn from the music yet.
    canvas.dataset.music = String(!!reader);
    this.#drawStrip(mix, seconds);
  }

  /** The level along the mix, worked out once per mix and width. */
  #stripLevels: Float32Array | null = null;
  #stripFor = '';

  #drawStrip(mix: VideoMix, seconds: number) {
    const strip = $<HTMLCanvasElement>('mix-strip');
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(strip.clientWidth * ratio);
    const height = Math.round(strip.clientHeight * ratio);
    if (width === 0 || height === 0) return;
    if (strip.width !== width || strip.height !== height) [strip.width, strip.height] = [width, height];
    const columns = Math.max(1, Math.floor(width / (2 * ratio)));
    const key = `${mix.path}|${mix.start}|${mix.end}|${columns}`;
    if (this.#stripFor !== key) {
      this.#stripLevels = this.#options.levels(columns);
      this.#stripFor = key;
    }
    const ctx = strip.getContext('2d')!;
    ctx.clearRect(0, 0, width, height);
    const played = (seconds / Math.max(1e-9, mix.end - mix.start)) * width;
    const column = width / columns;
    for (let i = 0; i < columns; i++) {
      const x = i * column;
      const h = Math.max(1, this.#stripLevels![i] * (height - 8 * ratio));
      ctx.fillStyle = x < played ? '#3ddc97' : '#4a505c';
      ctx.fillRect(x, (height - h) / 2, Math.max(1, column - ratio), h);
    }
    // Where each track starts.
    ctx.fillStyle = 'rgba(230, 232, 236, 0.55)';
    for (const track of mix.tracks) ctx.fillRect(Math.round((track.at / Math.max(1e-9, mix.end - mix.start)) * width), 0, Math.max(1, ratio), 6 * ratio);
    ctx.fillStyle = '#e6e8ec';
    ctx.fillRect(Math.round(played), 0, Math.max(1, ratio * 1.5), height);
    // For scripted checks.
    strip.dataset.seconds = seconds.toFixed(1);
  }
}
