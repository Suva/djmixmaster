// The Video view of the main window: the selected mix's video as it will
// look, with its template and fields in the settings panel. It shares the
// recording timeline and the transport with the Mastering view; switching
// between the two (the bar at the bottom, or Tab) swaps the curves for the
// picture and the levelling settings for the template's fields.

import type { Api, FolderLut, VisualsChoice } from '../api.ts';
import { SHAPES, type Shape } from '../../visuals/shape.ts';
import type { Features } from '../../features.ts';
import { FrameDrawer } from '../../visuals/draw.ts';
import { MUSIC_NAMES, MusicReader } from '../../visuals/music.ts';
import { loadFonts } from '../../visuals/fonts.ts';
import {
  ASSET_PREFIX, checkSetting, COMMON_PARAMS, settingsOf, fontsOf, imagesOf, FOLDER_LUT_PREFIX, folderLutsOf, keepFolderLuts, LAYER_TYPES, LUT_PREFIX, lutsOf, MEDIA_PREFIX, prepare, RECORDING_VIDEO, TEXT_VARIABLES,
  type Field, type MediaFile, type PreparedLayer, type Template,
} from '../../visuals/template.ts';
import { fontPicker } from './font-picker.ts';
import { TemplateEditor } from './template-editor.ts';
import { PictureHandles } from './picture-handles.ts';
import { PreviewVideos } from './video-sources.ts';
import { lutPicker } from './lut-picker.ts';
import { lutChoices } from './layer-settings.ts';
import { packLut, parseCube, unpackLut, type Lut, type PackedLut } from '../../visuals/lut.ts';
import {
  checked, DEFAULT_TEMPLATE, drawVideoFrame, lutOf, pictureOf, TEMPLATES as templates, templateOf, USER_TEMPLATE, USER_TEMPLATES, type VideoMix,
} from './video-frame.ts';

export type { VideoMix } from './video-frame.ts';

export interface VideoViewOptions {
  api: Api;
  /** The selected mix, or null when nothing is open. */
  mix(): VideoMix | null;
  /** The playhead, in seconds into the recording. */
  playhead(): number;
  /** Whether the music is playing; paused, the picture is drawn only when something changes. */
  playing(): boolean;
  /** How fast it plays: 1 at its own speed. */
  rate(): number;
  /** Moves the playhead to this many seconds into the recording. */
  seek(seconds: number): void;
  /** How loud the selected mix is along its length, in this many steps, 0 to 1, from the analysis. */
  levels(points: number): Float32Array;
  /** The mix's template or a field changed here; the main window keeps it with the mix. */
  choose(choice: VisualsChoice): void;
  /** A line about what is going on, such as the music values being worked out. */
  say(text: string): void;
  /** What can be undone has changed: while a template is edited, undo works on the template. */
  history(): void;
  /** The template editor was opened or closed: the view to come back to has changed. */
  editingChanged(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class VideoView {
  readonly #options: VideoViewOptions;
  readonly #canvas = $<HTMLCanvasElement>('picture');
  readonly #drawer = new FrameDrawer(this.#canvas);
  readonly #images = new Map<string, ImageBitmap>();
  /** LUTs of LUT layers, by `lut:name` or path, as the template names them. */
  readonly #luts = new Map<string, Lut>();
  /** The LUTs in the LUT folder, as last looked at: when the window was last brought forward, or another folder chosen. */
  #folderLuts: FolderLut[] = [];
  /** LUTs kept in templates, unpacked, by what is kept: as with pictures, an edit makes a new copy of the template but not of its LUTs. */
  readonly #unpacked = new Map<string, Lut>();
  /** The videos of video layers, playing along; a frame that comes in while paused is drawn. */
  readonly #videos: PreviewVideos;
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

  readonly #editor: TemplateEditor;
  readonly #handles: PictureHandles;
  /** The user's templates as saved: with settings that were left half typed, which checking replaces. */
  readonly #typed = new Map<string, unknown>();
  /** The template being edited, by its name in a mix's choice, or null. */
  #editing: string | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: VideoViewOptions) {
    this.#options = options;
    this.#videos = new PreviewVideos(options.api, () => (this.#stale = true));
    // Files put in the LUT folder are offered once the app is come back to.
    this.#lookInLutFolder();
    window.addEventListener('focus', () => this.#lookInLutFolder());
    options.api.onLutsChanged(() => this.#lookInLutFolder());
    this.#editor = new TemplateEditor({
      change: (template) => this.#edited(template),
      history: () => options.history(),
      live: (index) => this.#layers[index]?.last ?? null,
      renamedField: (from, to) => {
        if (!(from in this.#choice.fields)) return;
        const { [from]: value, ...rest } = this.#choice.fields;
        this.#choice = { ...this.#choice, fields: { ...rest, [to]: value } };
        this.#prepare();
        this.#options.choose(this.#choice);
      },
      pickPicture: async () => {
        const path = await options.api.pickImage();
        if (!path) return null;
        const bytes = await options.api.readImage(path);
        const file = path.split(/[\\/]/).pop()!;
        const type = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif' }[file.split('.').pop()!.toLowerCase()] ?? 'png';
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { name: file.replace(/\.[^.]+$/, ''), data: `data:image/${type};base64,${btoa(binary)}` };
      },
      pickLut: async () => {
        const path = await options.api.pickLut();
        if (!path) return null;
        try {
          const packed: PackedLut = packLut(parseCube(await options.api.readLut(path)));
          return { name: path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ''), lut: packed };
        } catch (error) {
          options.say(`Could not use that LUT: ${error instanceof Error ? error.message : error}`);
          return null;
        }
      },
      folderLuts: () => this.#folderLuts,
      pickVideo: async () => {
        const path = await options.api.pickVideo();
        if (!path) return null;
        try {
          options.say('Adding the video…');
          const file = await options.api.addMedia(path);
          options.say('');
          return { name: path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ''), file };
        } catch (error) {
          options.say(`Could not add the video: ${error instanceof Error ? error.message : error}`);
          return null;
        }
      },
    });
    this.#handles = new PictureHandles($('picture-overlay'), {
      canvas: this.#canvas,
      boxes: () => this.#drawer.boxes,
      layer: (index) => this.#editor.layer(index),
      selected: () => this.#editor.selected,
      select: (index) => this.#editor.select(index),
      set: (index, key, value, kind) => this.#editor.set(index, key, value, kind),
      done: () => this.#editor.refresh(),
      say: (text) => options.say(text),
    });
    const select = $<HTMLSelectElement>('template');
    this.#fillTemplates();
    // The user's own templates come in from disk a moment after the window is up.
    this.#templatesLoaded = options.api.templates().then((stored) => {
      for (const { id, template } of stored) {
        USER_TEMPLATES.set(USER_TEMPLATE + id, checked(template).template);
        this.#typed.set(USER_TEMPLATE + id, template);
      }
      this.#fillTemplates();
      this.#shownFor = '';
      this.refresh();
    });
    this.#templateActions();
    select.addEventListener('change', () => {
      // Fields of the same name carry over to the new template: the artist's name, the colour.
      this.#choice = { ...this.#choice, template: select.value };
      this.#prepare();
      this.#showFields();
      options.choose(this.#choice);
    });
    // The shape of the picture, kept with the template choice; the same template is drawn in any.
    for (const button of $('video-shape').querySelectorAll<HTMLButtonElement>('button')) {
      button.addEventListener('click', () => {
        this.#choice = { ...this.#choice, shape: button.dataset.shape as Shape };
        this.#showShape(this.#choice.shape!);
        this.#drawer.reset();
        this.#stale = true;
        const mix = options.mix();
        this.#shownFor = `${mix?.path}|${mix?.number}|${JSON.stringify(this.#choice)}`;
        options.choose(this.#choice);
      });
    }
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
    if (!visible) {
      // The editor belongs to the Video view; it closes with it.
      this.#stopEditing();
      this.#videos.clear();
      return;
    }
    this.refresh();
    this.#stale = true;
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
    // Another mix selected, or its template changed by an undo: the one being edited is no longer on show.
    if (this.#editing && choice.template !== this.#editing) this.#stopEditing();
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
      this.#stale = true;
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

  /**
   * Pictures packed into templates, decoded, by their data: an edit makes a
   * new copy of the template, but its pictures are the same, and decoding
   * them again on every change would leave frames without them meanwhile.
   */
  readonly #packed = new Map<string, ImageBitmap>();

  /**
   * Gets the picture ready to draw with: layers, fonts, pictures. `fresh`
   * when what is shown is another template or mix, rather than an edit to
   * the same one: then what layers remember from frame to frame starts over.
   */
  #prepare(fresh = true) {
    const template = this.#template();
    this.#layers = prepare(template, this.#choice.fields, MUSIC_NAMES);
    // Until a font is in, its text is drawn in a plain face; the next frame after, in the font.
    loadFonts(fontsOf(template, this.#choice.fields)).then(() => (this.#stale = true));
    this.#stale = true;
    if (fresh) this.#drawer.reset();
    for (const name of imagesOf(template, this.#choice.fields)) this.#loadImage(name, template);
    for (const name of lutsOf(template, this.#choice.fields)) this.#loadLut(name, template);
    this.#checkMedia();
  }

  /** What the videos were last looked for for: the template, and where its videos were. */
  #mediaChecked = '';

  /**
   * Looks for the template's videos, and finds those that have moved where
   * that can be done without asking: into the media folder, by their
   * fingerprints. Those still missing are listed above the fields, to be
   * located by hand.
   */
  async #checkMedia() {
    const id = this.#choice.template;
    const media = this.#template().media ?? {};
    const key = `${id}|${JSON.stringify(media)}`;
    if (key === this.#mediaChecked) return;
    this.#mediaChecked = key;
    const names = Object.keys(media);
    const found = names.length ? await this.#options.api.findMedia(names.map((name) => media[name])) : [];
    if (this.#choice.template !== id) return;
    const moved: Record<string, MediaFile> = {};
    names.forEach((name, i) => {
      if (found[i] && found[i]!.path !== media[name].path) moved[name] = found[i]!;
    });
    if (Object.keys(moved).length) this.#relink(id, moved);
    this.#showMissing(names.filter((_, i) => !found[i]));
  }

  /** Says which videos of the template are not where it says, each with a button to find it. */
  #showMissing(missing: string[]) {
    const box = $('media-missing');
    box.hidden = missing.length === 0;
    const id = this.#choice.template;
    const own = USER_TEMPLATES.has(id);
    const text = document.createElement('p');
    text.textContent = missing.length === 1
      ? `The video ${missing[0]} is not where this template says it is.`
      : `${missing.length} videos of this template are not where it says they are: ${missing.join(', ')}.`;
    box.replaceChildren(text);
    if (!own) return;
    for (const name of missing) {
      const locate = document.createElement('button');
      locate.type = 'button';
      locate.textContent = missing.length === 1 ? 'Locate…' : `Locate ${name}…`;
      locate.title = 'Show where the video is now. Others missing from the same folder are found with it.';
      locate.addEventListener('click', async () => {
        const path = await this.#options.api.pickVideo();
        if (!path) return;
        try {
          const media = this.#template().media ?? {};
          const updates: Record<string, MediaFile> = { [name]: await this.#options.api.addMedia(path) };
          // Others that were in one folder together most likely moved together.
          const rest = missing.filter((other) => other !== name && media[other]);
          const found = await this.#options.api.findMedia(rest.map((other) => media[other]), path.replace(/[\\/][^\\/]*$/, ''));
          rest.forEach((other, i) => {
            if (found[i]) updates[other] = found[i]!;
          });
          this.#relink(id, updates);
        } catch (error) {
          this.#options.say(`Could not use that video: ${error instanceof Error ? error.message : error}`);
        }
      });
      box.append(locate);
    }
  }

  /** Puts where the template's videos are now into it, and saves it: through the editor, as a change, while it is open. */
  #relink(id: string, updates: Record<string, MediaFile>) {
    if (this.#editing === id) return this.#editor.relink(updates);
    const template = USER_TEMPLATES.get(id);
    if (!template) return;
    template.media = { ...template.media, ...updates };
    const typed = (this.#typed.get(id) ?? structuredClone(template)) as Template;
    typed.media = { ...typed.media, ...updates };
    this.#typed.set(id, typed);
    this.#options.api.saveTemplate(id.slice(USER_TEMPLATE.length), typed);
    if (this.#choice.template === id) this.#prepare(false);
  }

  #setField(key: string, value: string | number) {
    this.#choice = { ...this.#choice, fields: { ...this.#choice.fields, [key]: value } };
    this.#prepare();
    // Kept with the mix at once; the main window saves it, and makes it an undo step, once typing pauses.
    const mix = this.#options.mix();
    this.#shownFor = `${mix?.path}|${mix?.number}|${JSON.stringify(this.#choice)}`;
    this.#options.choose(this.#choice);
  }

  async #loadImage(path: string, template = this.#template()) {
    try {
      if (path.startsWith(ASSET_PREFIX)) {
        // The same name can be another picture in another template, or after a change: known by its data.
        const data = template.assets?.[path.slice(ASSET_PREFIX.length)];
        if (!data) return;
        const known = this.#packed.get(data);
        if (known) {
          this.#images.set(path, known);
          this.#stale = true;
          return;
        }
        // Until it is decoded, the picture there was keeps showing.
        const picture = await pictureOf(path, template, this.#options.api);
        this.#packed.set(data, picture);
        // Unless the picture of that name was changed again while this one was decoded.
        if (this.#template().assets?.[path.slice(ASSET_PREFIX.length)] === data) this.#images.set(path, picture);
        this.#stale = true;
        return;
      }
      if (this.#images.has(path)) return;
      this.#images.set(path, await pictureOf(path, template, this.#options.api));
      this.#stale = true;
    } catch (error) {
      this.#options.say(`Could not load the picture: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Lists the LUT folder's LUTs again, and offers them anew where they are offered if they have changed. */
  async #lookInLutFolder() {
    const found = await this.#options.api.folderLuts().catch(() => [] as FolderLut[]);
    if (JSON.stringify(found) === JSON.stringify(this.#folderLuts)) return;
    this.#folderLuts = found;
    // A file of the folder may have been changed, or put back: read again what is used of it.
    for (const name of [...this.#luts.keys()]) if (name.startsWith(FOLDER_LUT_PREFIX)) this.#luts.delete(name);
    this.#prepare(false);
    if (!this.#template().fields.some((field) => field.kind === 'lut') && !this.#editing) return;
    this.#showFields();
    this.#editor.offersChanged();
  }

  async #loadLut(name: string, template = this.#template()) {
    try {
      if (name.startsWith(LUT_PREFIX)) {
        // Unpacked at once, so that the picture never shows without it after an edit.
        const packed = template.luts?.[name.slice(LUT_PREFIX.length)];
        if (!packed) return;
        let lut = this.#unpacked.get(packed.data);
        if (!lut) this.#unpacked.set(packed.data, (lut = unpackLut(packed)));
        if (this.#luts.get(name) !== lut) this.#stale = true;
        this.#luts.set(name, lut);
        return;
      }
      if (this.#luts.has(name)) return;
      this.#luts.set(name, await lutOf(name, template, this.#options.api));
      this.#stale = true;
    } catch (error) {
      this.#options.say(`Could not use the LUT: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Marks the shape in use among the buttons that choose it. */
  #showShape(shape: Shape) {
    for (const button of $('video-shape').querySelectorAll<HTMLButtonElement>('button')) {
      button.classList.toggle('on', button.dataset.shape === shape);
      button.setAttribute('aria-pressed', String(button.dataset.shape === shape));
    }
  }

  #showFields() {
    const mix = this.#options.mix();
    this.#shownFor = `${mix?.path}|${mix?.number}|${JSON.stringify(this.#choice)}`;
    this.#showShape(mix?.shape ?? 'landscape');
    const template = this.#template();
    const known = templates.has(this.#choice.template) || USER_TEMPLATES.has(this.#choice.template);
    $<HTMLSelectElement>('template').value = known ? this.#choice.template : DEFAULT_TEMPLATE;
    const own = USER_TEMPLATES.has(this.#choice.template);
    // Renaming is for the editor, as all of a template's making is.
    $('template-name-row').hidden = !this.#editing;
    const name = $<HTMLInputElement>('template-name');
    if (document.activeElement !== name) name.value = template.name;
    $<HTMLButtonElement>('template-delete').disabled = !own;
    const edit = $<HTMLButtonElement>('template-edit');
    edit.title = own
      ? 'Edit this template: its layers and their settings'
      : 'Edit a copy: the templates that come with the app stay as they are, so this makes one of yours to change';
    edit.setAttribute('aria-label', own ? 'Edit the template' : 'Edit a copy of the template');
    $('video-fields').replaceChildren(...template.fields.map((field) => this.#control(field)));
    this.#showAbout(template);
  }

  /** Who made the template and what it is, under the list: the description, the author, a website and email to click. */
  #showAbout(template: Template) {
    const about = template.about ?? {};
    const box = $('template-about');
    const name = document.createElement('p');
    name.className = 'about-name';
    name.textContent = template.name;
    box.replaceChildren(name);
    if (about.description) {
      const text = document.createElement('p');
      text.className = 'about-description';
      text.textContent = about.description;
      box.append(text);
    }
    const by = document.createElement('p');
    by.className = 'about-by';
    if (about.author) by.append(`By ${about.author}`);
    const link = (text: string, url: string, title: string) => {
      const a = document.createElement('a');
      a.textContent = text;
      a.href = url;
      a.title = title;
      a.addEventListener('click', (event) => {
        // Opened by the browser or the mail program, never in the app.
        event.preventDefault();
        this.#options.api.openLink(url);
      });
      return a;
    };
    for (const [part, url, title] of [
      [about.website?.replace(/^https?:\/\//, '').replace(/\/$/, ''), about.website, 'Opens in your browser'],
      [about.email, about.email && `mailto:${about.email}`, 'Writes an email to the author'],
    ] as const) {
      if (!part || !url) continue;
      if (by.childNodes.length) by.append(' · ');
      by.append(link(part, url, title));
    }
    if (by.childNodes.length) name.after(by);
  }

  // ---------------------------------------------------------------------------
  // The templates: the list, and making, naming, deleting and sharing the user's own.

  #fillTemplates() {
    const select = $<HTMLSelectElement>('template');
    const group = (label: string, entries: [string, Template][]) => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = label;
      for (const [id, template] of entries) optgroup.append(new Option(template.name, id));
      return optgroup;
    };
    const own = [...USER_TEMPLATES].sort(([, a], [, b]) => a.name.localeCompare(b.name));
    select.replaceChildren(group('Comes with the app', [...templates]), ...(own.length ? [group('Yours', own)] : []));
    select.value = templates.has(this.#choice.template) || USER_TEMPLATES.has(this.#choice.template) ? this.#choice.template : DEFAULT_TEMPLATE;
  }

  /** A name no template has yet: the one given, or it with a number. */
  #freeName(wanted: string): string {
    const taken = new Set([...templates.values(), ...USER_TEMPLATES.values()].map((template) => template.name));
    if (!taken.has(wanted)) return wanted;
    let n = 2;
    while (taken.has(`${wanted} ${n}`)) n++;
    return `${wanted} ${n}`;
  }

  /** Keeps a template of the user's own, and makes it the mix's. */
  async #adopt(template: Template) {
    const id = crypto.randomUUID();
    await this.#options.api.saveTemplate(id, template);
    USER_TEMPLATES.set(USER_TEMPLATE + id, template);
    this.#fillTemplates();
    this.#choice = { ...this.#choice, template: USER_TEMPLATE + id };
    this.#prepare();
    this.#showFields();
    this.#options.choose(this.#choice);
  }

  #renameTimer: ReturnType<typeof setTimeout> | undefined;

  // ---------------------------------------------------------------------------
  // Editing a template of the user's own

  get editing(): boolean {
    return this.#editing !== null;
  }

  get canUndoTemplate(): boolean {
    return this.#editor.canUndo;
  }

  get canRedoTemplate(): boolean {
    return this.#editor.canRedo;
  }

  /** Removes the layer selected in the editor. */
  deleteLayer() {
    this.#editor.deleteSelected();
  }

  /** The editor's shortcuts: Shift+⌘N adds a layer, ⌘J duplicates the selected layer, ⌘G groups it, Shift+⌘G ungroups. */
  layerCommand(command: 'add' | 'duplicate' | 'group' | 'ungroup') {
    if (command === 'add') this.#editor.openAddMenu();
    else if (command === 'duplicate') this.#editor.duplicateSelected();
    else if (command === 'group') this.#editor.groupSelected();
    else this.#editor.ungroupSelected();
  }

  stepTemplate(direction: 'undo' | 'redo') {
    this.#editor.step(direction);
  }

  /** The user's own templates, read from disk; until then a mix's own template is not known. */
  #templatesLoaded: Promise<void>;

  /**
   * Opens the editor again at the start, as it was left: only on a template
   * of the user's own, as opening it on a built-in one would make a copy.
   */
  async reopenEditor() {
    await this.#templatesLoaded;
    this.refresh();
    if (this.#visible && !this.#editing && USER_TEMPLATES.has(this.#choice.template)) await this.#startEditing();
  }

  async #startEditing() {
    if (!USER_TEMPLATES.has(this.#choice.template)) {
      const copy: Template = structuredClone(this.#template());
      copy.name = this.#freeName(`${copy.name} copy`);
      await this.#adopt(copy);
    }
    this.#editing = this.#choice.template;
    document.body.classList.add('editing');
    $('template-editor').hidden = false;
    $('editor-done').hidden = false;
    $('editor-export').hidden = false;
    $('video-heading').textContent = 'Editing the template';
    $('template-name-row').hidden = false;
    this.#handles.show(true);
    this.#editor.start(this.#asTyped(this.#template(), this.#typed.get(this.#editing)));
    this.#options.editingChanged();
  }

  /**
   * A checked template with its settings as they were typed, where they were
   * left half done: so that the editor shows them again, problems and all.
   */
  #asTyped(template: Template, typed: unknown): Template {
    const result = structuredClone(template);
    const layers = (typed as { layers?: unknown } | undefined)?.layers;
    if (!Array.isArray(layers)) return result;
    result.layers.forEach((layer, index) => {
      const saved = layers[index] as { type?: unknown; params?: Record<string, unknown> } | undefined;
      if (saved?.type !== layer.type || typeof saved.params !== 'object' || saved.params === null) return;
      for (const key of Object.keys(layer.params)) {
        const value = saved.params[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') layer.params[key] = value;
      }
    });
    return result;
  }

  #stopEditing() {
    if (!this.#editing) return;
    this.#editing = null;
    document.body.classList.remove('editing');
    this.#handles.show(false);
    $('template-editor').hidden = true;
    $('editor-done').hidden = true;
    $('editor-export').hidden = true;
    $('video-heading').textContent = 'Video';
    this.#editor.stop();
    this.#fillTemplates();
    this.#showFields();
    this.#options.editingChanged();
  }

  /** A change made in the editor: shown in the picture at once, and saved once changes pause. */
  #edited(template: Template) {
    const id = this.#editing;
    if (!id) return;
    // What is saved is what was typed, so that nothing is lost; the picture
    // shows a setting half typed at its last good value meanwhile.
    const before = USER_TEMPLATES.get(id);
    USER_TEMPLATES.set(id, this.#lastGood(template, before));
    this.#typed.set(id, template);
    // What a layer remembers is kept by its place: with layers added, removed or moved, it starts over.
    const kinds = (t: Template | undefined) => t?.layers.map((layer) => layer.type).join() ?? '';
    this.#prepare(kinds(before) !== kinds(template));
    const name = $<HTMLInputElement>('template-name');
    if (document.activeElement !== name) name.value = template.name;
    const option = [...$<HTMLSelectElement>('template').options].find((o) => o.value === id);
    if (option) option.text = template.name;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#options.api.saveTemplate(id.slice(USER_TEMPLATE.length), template), 400);
  }

  /**
   * The template as typed, with every setting that does not work (yet) given
   * the value it had in the template shown before, or else its default.
   */
  #lastGood(template: Template, before: Template | undefined): Template {
    const usable = structuredClone(template);
    usable.layers.forEach((layer, index) => {
      const spec = LAYER_TYPES[layer.type];
      if (!spec) return;
      const all = settingsOf(spec);
      const old = before?.layers[index]?.type === layer.type ? before.layers[index] : undefined;
      for (const [key, value] of Object.entries(layer.params)) {
        const param = all[key];
        if (param && checkSetting(usable, value, param, MUSIC_NAMES, TEXT_VARIABLES)) layer.params[key] = old?.params[key] ?? param.default;
      }
    });
    return checked(usable).template;
  }

  /** Adds a template from a file: chosen in the dialog, dropped on the window, or opened from Finder. */
  async #import(read: () => Promise<unknown>) {
    try {
      const raw = await read();
      if (raw === null) return;
      const { template, problems } = checked(raw);
      template.name = this.#freeName(template.name);
      await this.#adopt(template);
      this.#options.say(problems.length
        ? `Added ${template.name}. Some of it could not be used and was left at its default: ${problems[0].where}, ${problems[0].message.toLowerCase()}${problems.length > 1 ? `, and ${problems.length - 1} more` : ''}.`
        : `Added ${template.name}.`);
    } catch (error) {
      this.#options.say(`Could not add that template: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Adds the template in this file, and makes it the selected mix's: one dropped on the window or opened from Finder. */
  importFile(path: string): Promise<void> {
    return this.#import(() => this.#options.api.readTemplateFile(path));
  }

  /** Saves the template on show as a file to share, from the ⋯ menu or the editor. */
  async #export() {
    let template = this.#template();
    // The LUTs it names in the LUT folder go inside the file: whoever it is shared with has not got that folder.
    const names = folderLutsOf(template);
    if (names.length) {
      const packed: Record<string, PackedLut> = {};
      for (const name of names) {
        try {
          packed[name] = packLut(parseCube(await this.#options.api.readFolderLut(name)));
        } catch (error) {
          return this.#options.say(`Could not export ${template.name}: the LUT ${name} could not be packed. ${error instanceof Error ? error.message : error}`);
        }
      }
      template = keepFolderLuts(template, packed);
    }
    const saved = await this.#options.api.exportTemplate(template, template.name);
    if (saved) this.#options.say(`Saved ${template.name} as ${saved.split(/[\\/]/).pop()}, with its pictures, to share.`);
  }

  #templateActions() {
    const api = this.#options.api;
    // The ⋯ menu: opened by its button, closed by a choice, a click elsewhere or Escape.
    const menu = $('template-menu');
    const more = $('template-more');
    const close = () => {
      menu.hidden = true;
      more.classList.remove('on');
    };
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
      more.classList.toggle('on', !menu.hidden);
      if (!menu.hidden) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
    menu.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button')) close();
    });
    menu.addEventListener('keydown', (event) => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        close();
        more.focus();
      } else if (event.key === 'ArrowDown') items[Math.min(items.length - 1, at + 1)]?.focus();
      else if (event.key === 'ArrowUp') items[Math.max(0, at - 1)]?.focus();
      else return;
      event.preventDefault();
      event.stopPropagation();
    });
    document.addEventListener('mousedown', (event) => {
      if (!menu.hidden && !menu.contains(event.target as Node) && !more.contains(event.target as Node)) close();
    });
    $('template-edit').addEventListener('click', () => this.#startEditing());
    $('editor-done').addEventListener('click', () => this.#stopEditing());
    $('template-duplicate').addEventListener('click', async () => {
      const copy: Template = structuredClone(this.#template());
      copy.name = this.#freeName(`${copy.name} copy`);
      await this.#adopt(copy);
      this.#options.say(`${copy.name} is yours to change.`);
    });
    $('template-delete').addEventListener('click', async () => {
      const id = this.#choice.template;
      const template = USER_TEMPLATES.get(id);
      if (!template) return;
      await api.deleteTemplate(id.slice(USER_TEMPLATE.length));
      USER_TEMPLATES.delete(id);
      this.#fillTemplates();
      this.#choice = { ...this.#choice, template: DEFAULT_TEMPLATE };
      this.#prepare();
      this.#showFields();
      this.#options.choose(this.#choice);
      this.#options.say(`${template.name} is in the Trash. Mixes that used it now use ${templates.get(DEFAULT_TEMPLATE)!.name}.`);
    });
    $('template-import').addEventListener('click', () => this.#import(() => api.importTemplate()));
    $('template-export').addEventListener('click', () => this.#export());
    $('editor-export').addEventListener('click', () => this.#export());
    const name = $<HTMLInputElement>('template-name');
    name.addEventListener('input', () => {
      // While editing, a new name is a change like any other, and can be undone.
      if (this.#editing) return this.#editor.rename(name.value.trim() || 'Untitled');
      const id = this.#choice.template;
      const template = USER_TEMPLATES.get(id);
      if (!template) return;
      template.name = name.value.trim() || 'Untitled';
      const option = [...$<HTMLSelectElement>('template').options].find((o) => o.value === id);
      if (option) option.text = template.name;
      clearTimeout(this.#renameTimer);
      this.#renameTimer = setTimeout(() => api.saveTemplate(id.slice(USER_TEMPLATE.length), template), 400);
    });
    name.addEventListener('change', () => this.#fillTemplates());
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
    } else if (field.kind === 'video') {
      const row = document.createElement('div');
      row.className = 'image-field';
      const name = document.createElement('span');
      name.className = 'file';
      const shownName = (path: string) => (path === RECORDING_VIDEO ? 'The recording' : path.startsWith(MEDIA_PREFIX) ? path.slice(MEDIA_PREFIX.length) : path.split(/[\\/]/).pop()!);
      name.textContent = value ? shownName(String(value)) : 'None';
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.id = id;
      choose.textContent = 'Choose…';
      choose.addEventListener('click', async () => {
        const path = await this.#options.api.pickVideo();
        if (!path) return;
        name.textContent = shownName(path);
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
    } else if (field.kind === 'lut') {
      // For this mix: one the template keeps, one of the LUT folder's, or any file, read where it is.
      control.append(lutPicker({
        id,
        current: String(value),
        choices: () => [{ value: '', label: 'None' }, ...lutChoices(this.#template(), this.#folderLuts)],
        choose: (chosen) => this.#setField(field.key, chosen),
        add: {
          label: 'Choose a file…',
          run: async () => {
            const path = await this.#options.api.pickLut();
            if (!path) return;
            try {
              // Read before it is taken, so that a file that is no LUT is said at once rather than left blank.
              this.#luts.set(path, parseCube(await this.#options.api.readLut(path)));
            } catch (error) {
              return this.#options.say(`Could not use that LUT: ${error instanceof Error ? error.message : error}`);
            }
            this.#setField(field.key, path);
            this.#showFields();
          },
        },
      }));
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

  /** Something that needs the picture drawn anew even while paused: an edit, a picture or a font that came in. */
  #stale = true;
  /** What the frame last drawn showed: the playhead, the picture's size, the mix. */
  #lastShown = '';

  #draw() {
    if (!this.#visible) return;
    this.#frame = requestAnimationFrame(() => this.#draw());
    const now = performance.now();
    const elapsed = Math.min(0.25, (now - this.#lastFrame) / 1000);
    this.#lastFrame = now;
    const mix = this.#options.mix();
    const canvas = this.#canvas;
    if (!mix) return;

    // As large as fits the area in the video's shape, drawn at the size it is
    // shown (up to that of the video) so it stays sharp and quick.
    const shape = SHAPES[mix.shape];
    const aspect = shape.width / shape.height;
    const area = canvas.parentElement!;
    const shownWidth = Math.floor(Math.min(area.clientWidth, area.clientHeight * aspect));
    const shownHeight = Math.floor(shownWidth / aspect);
    if (shownWidth <= 0) return;
    if (canvas.style.width !== `${shownWidth}px` || canvas.style.height !== `${shownHeight}px`) {
      canvas.style.width = `${shownWidth}px`;
      canvas.style.height = `${shownHeight}px`;
    }
    const ratio = window.devicePixelRatio || 1;
    const width = Math.min(shape.width, Math.round(shownWidth * ratio));
    const height = Math.round(width / aspect);
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
    // Paused, the picture stands still, and is drawn again only when something it shows has changed:
    // it costs nothing to leave a template heavy with effects on screen.
    const playing = this.#options.playing();
    const { template, ...details } = mix;
    const shown = `${playhead}|${width}x${height}|${JSON.stringify(details)}`;
    if (!playing && !this.#stale && shown === this.#lastShown) return;
    this.#stale = false;
    this.#lastShown = shown;
    // Time moves on only while playing: drawn again paused, glitter and fades stay where they were.
    const dt = playing ? elapsed : 0;
    this.#videos.begin(playing, this.#options.rate());
    drawVideoFrame(this.#drawer, this.#layers, reader, mix, seconds, dt, this.#images, this.#videos, elapsed, this.#luts);
    this.#videos.end();
    // A change of text plays out even while paused, which takes the frames after this one.
    if (this.#drawer.changing) this.#stale = true;
    // For scripted checks: how many frames have been drawn.
    canvas.dataset.frames = String(Number(canvas.dataset.frames ?? 0) + 1);
    if (this.#editing) {
      this.#editor.tick();
      this.#handles.update();
    }
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
