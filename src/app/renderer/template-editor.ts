// The template editor, in the Video view's panel while a template of the
// user's own is being changed. It works on a copy of the template and hands
// every change back (`change`), which shows it in the picture at once and
// saves it; it keeps its own undo history, as a template is not part of any
// one mix.
//
// The layers are listed front-most first, as in image editors, though a
// template keeps them in drawing order, back first.

import {
  ABOUT_LIMITS, aboutProblem, COMMON_PARAMS, LAYER_TYPES, MEDIA_PREFIX, settingsOf,
  type Layer, type MediaFile, type TemplateAbout, type ParamValue, type ResolvedParams, type Template,
} from '../../visuals/template.ts';
import { layerSettings, SHOWN_AS } from './layer-settings.ts';
import { flatten, isGroup, locate, treeOf, within, type LayerNode } from '../../visuals/layer-tree.ts';
import { scrubbable } from './scrub.ts';
import { FIELD_KINDS, fieldsEditor, freeFieldName, newField } from './fields-editor.ts';

export interface TemplateEditorOptions {
  /** A change made here: the template as it now is. */
  change(template: Template): void;
  /** What can be undone or redone has changed. */
  history(): void;
  /** What a layer's settings came to in the frame last drawn, by its place in the template. */
  live(index: number): ResolvedParams | null;
  /** Asks for a picture file and gives its name and contents as a data URL, or null. */
  pickPicture(): Promise<{ name: string; data: string } | null>;
  /** Asks for a video file and makes it one a template can keep: its name, and where it is; or null. */
  pickVideo(): Promise<{ name: string; file: MediaFile } | null>;
  /** A field was renamed: what the mix filled in goes under the new name. */
  renamedField(from: string, to: string): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Movement under this many pixels is a click, not a drag. */
const DRAG_START_PX = 4;
/** Changes closer together than this, of the same kind, undo as one: typing a name, say. */
const MERGE_MS = 1000;

/** A new layer of a kind, with every setting at its default. */
function newLayer(type: string): Layer {
  const spec = LAYER_TYPES[type];
  const params: Record<string, ParamValue> = {};
  for (const [key, param] of Object.entries(settingsOf(spec))) params[key] = param.default;
  return { type, params };
}

export class TemplateEditor {
  readonly #options: TemplateEditorOptions;
  #template: Template | null = null;
  /** The selected layer, by its place in the template (0 is the back), or -1: the last clicked, whose settings show. */
  #selected = -1;
  /** All the layers selected, it among them: ⌘-click adds one, Shift-click a run of them. */
  #picked = new Set<Layer>();
  #past: string[] = [];
  #future: string[] = [];
  #lastChange = { kind: '', at: 0 };
  /** The settings of the selected layer, as shown: below the list, and its blend and opacity above it. */
  #settings: { element: HTMLElement; tick(): void } | null = null;
  #top: { element: HTMLElement; tick(): void } | null = null;
  #settingsFor: Layer | null = null;

  constructor(options: TemplateEditorOptions) {
    this.#options = options;
    // The + button's menu: a search, then what draws, what changes the picture beneath, and groups.
    const menu = $('editor-add-menu');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'add-menu-search';
    search.placeholder = 'Search';
    search.spellcheck = false;
    search.setAttribute('aria-label', 'Search the kinds of layer');
    const items = document.createElement('div');
    items.className = 'add-menu-items';
    menu.append(search, items);
    const sections: [string, string[]][] = [
      ['Draws', Object.keys(LAYER_TYPES).filter((type) => !LAYER_TYPES[type].effect && type !== 'group')],
      ['Changes what is beneath', Object.keys(LAYER_TYPES).filter((type) => LAYER_TYPES[type].effect)],
      ['Holds layers', ['group']],
    ];
    const close = () => {
      menu.hidden = true;
      $('editor-add').classList.remove('on');
    };
    const choose = (type: string) => {
      close();
      this.#addLayer(type);
    };
    /** The kinds whose names hold what is typed, under their headings; a heading with none left out. */
    const fill = () => {
      const wanted = search.value.trim().toLowerCase();
      items.replaceChildren();
      for (const [title, types] of sections) {
        const matching = types.filter((type) => !wanted || LAYER_TYPES[type].label.toLowerCase().includes(wanted) || type.includes(wanted));
        if (!matching.length) continue;
        const heading = document.createElement('p');
        heading.className = 'add-menu-heading';
        heading.textContent = title;
        items.append(heading);
        for (const type of matching) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = LAYER_TYPES[type].label;
          b.dataset.type = type;
          b.addEventListener('click', () => choose(type));
          items.append(b);
        }
      }
      if (!items.children.length) {
        const none = document.createElement('p');
        none.className = 'add-menu-none';
        none.textContent = 'Nothing by that name';
        items.append(none);
      }
    };
    /** Opens beside the button where there is the more room, and never past the window; what does not fit scrolls. */
    const place = () => {
      const button = $('editor-add').getBoundingClientRect();
      const margin = 8;
      const above = button.top - margin;
      const below = window.innerHeight - button.bottom - margin;
      const up = above > below;
      menu.style.maxHeight = `${Math.max(120, (up ? above : below) - 4)}px`;
      menu.style.left = `${Math.max(margin, Math.min(button.left, window.innerWidth - menu.offsetWidth - margin))}px`;
      menu.style.top = up ? '' : `${button.bottom + 4}px`;
      menu.style.bottom = up ? `${window.innerHeight - button.top + 4}px` : '';
    };
    $('editor-add').addEventListener('click', (event) => {
      event.stopPropagation();
      if (!menu.hidden) return close();
      search.value = '';
      fill();
      menu.hidden = false;
      $('editor-add').classList.add('on');
      place();
      search.focus();
    });
    search.addEventListener('input', fill);
    menu.addEventListener('keydown', (event) => {
      const buttons = [...items.querySelectorAll<HTMLButtonElement>('button')];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        close();
        $('editor-add').focus();
      } else if (event.key === 'Enter' && document.activeElement === search) {
        // The first that matches.
        if (buttons[0]) choose(buttons[0].dataset.type!);
      } else if (event.key === 'ArrowDown') {
        buttons[Math.min(buttons.length - 1, at + 1)]?.focus();
      } else if (event.key === 'ArrowUp') {
        if (at <= 0) search.focus();
        else buttons[at - 1].focus();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    });
    document.addEventListener('mousedown', (event) => {
      if (!menu.hidden && !menu.contains(event.target as Node) && !$('editor-add').contains(event.target as Node)) close();
    });
    window.addEventListener('resize', () => !menu.hidden && place());
    // The shortcuts in the tooltips, as this system writes them.
    const command = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl+';
    $('editor-group').title = `Group (${command}G): put the selected layer in a group of its own`;
    $('editor-ungroup').title = `Ungroup (Shift+${command}G): take the layers out of this group, and the group away`;
    $('editor-duplicate').title = `Duplicate (${command}J): a copy of the selected layer, in front of it`;
    $('editor-group').addEventListener('click', () => this.groupSelected());
    $('editor-ungroup').addEventListener('click', () => this.ungroupSelected());
    $('editor-duplicate').addEventListener('click', () => this.duplicateSelected());
    $('editor-delete').addEventListener('click', () => this.#deleteLayer());

    const addField = $<HTMLSelectElement>('editor-add-field');
    for (const [kind, label] of FIELD_KINDS) addField.add(new Option(label, kind));
    addField.addEventListener('change', () => {
      const kind = addField.value as (typeof FIELD_KINDS)[number][0];
      addField.value = '';
      if (!kind || !this.#template) return;
      const field = newField(kind, freeFieldName(this.#template, kind));
      this.#change('', (template) => template.fields.push(field));
      this.#showFields();
      // The new field's label, ready to be typed over.
      const label = $('editor-fields').lastElementChild?.querySelector<HTMLInputElement>('.field-label');
      label?.focus();
      label?.select();
    });
    $('editor-tab-layers').addEventListener('click', () => this.#showTab('layers'));
    $('editor-tab-fields').addEventListener('click', () => this.#showTab('fields'));
    $('editor-tab-about').addEventListener('click', () => this.#showTab('about'));
  }

  #showTab(tab: 'layers' | 'fields' | 'about') {
    for (const name of ['layers', 'fields', 'about']) {
      $(`editor-tab-${name}`).classList.toggle('on', tab === name);
      $(`editor-${name}-pane`).hidden = tab !== name;
    }
    // The settings of a layer list the fields there are; they are made anew on the way back.
    if (tab === 'fields') this.#showFields();
    else if (tab === 'about') this.#showAbout();
    else this.#showSettings();
  }

  /** The About tab: who made the template and what it is, each checked as it is typed. */
  #showAbout() {
    const template = this.#template;
    if (!template) return $('editor-about').replaceChildren();
    const parts: [keyof TemplateAbout, string, string][] = [
      ['author', 'Author', 'Who made it'],
      ['email', 'Email', 'name@example.com'],
      ['website', 'Website', 'https://'],
      ['description', 'Description', 'What it looks like, and what it is for'],
    ];
    $('editor-about').replaceChildren(...parts.map(([key, label, hint]) => {
      const box = document.createElement('label');
      box.className = 'about-line';
      const title = document.createElement('span');
      title.textContent = label;
      const input = key === 'description' ? document.createElement('textarea') : document.createElement('input');
      if (input instanceof HTMLInputElement) input.type = key === 'email' ? 'email' : key === 'website' ? 'url' : 'text';
      else input.rows = 5;
      input.className = 'about-input';
      input.dataset.key = key;
      input.placeholder = hint;
      input.spellcheck = key === 'description';
      input.maxLength = ABOUT_LIMITS[key];
      input.value = template.about?.[key] ?? '';
      const problem = document.createElement('p');
      problem.className = 'setting-problem';
      input.addEventListener('input', () => {
        const value = input.value.trim();
        problem.textContent = aboutProblem(key, value) ?? '';
        this.#change(`about:${key}`, (t) => {
          const about = { ...t.about, [key]: value };
          if (!value) delete about[key];
          if (Object.keys(about).length) t.about = about;
          else delete t.about;
        });
      });
      // Keys typed here are for the text, not for the window.
      input.addEventListener('keydown', (event) => event.stopPropagation());
      box.append(title, input, problem);
      return box;
    }));
  }

  #showFields() {
    if (!this.#template) return $('editor-fields').replaceChildren();
    $('editor-fields').replaceChildren(fieldsEditor({
      template: () => this.#template!,
      change: (kind, apply, rebuild) => {
        this.#change(kind, apply);
        if (rebuild) this.#showFields();
      },
      renamed: (from, to) => this.#options.renamedField(from, to),
      pickPicture: () => this.#options.pickPicture(),
      pickVideo: () => this.#options.pickVideo(),
    }));
  }

  get open(): boolean {
    return this.#template !== null;
  }

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  /** Starts editing this template, a copy of which is changed from now on. */
  start(template: Template) {
    this.#template = structuredClone(template);
    this.#selected = this.#template.layers.length - 1;
    this.#picked.clear();
    this.#past = [];
    this.#future = [];
    this.#lastChange = { kind: '', at: 0 };
    this.#showTab('layers');
    this.#showLayers();
    this.#options.history();
  }

  stop() {
    this.#template = null;
    this.#showSettings();
    this.#past = [];
    this.#future = [];
    this.#options.history();
  }

  /** The selected layer, by its place in the template, or -1. */
  get selected(): number {
    return this.#template ? this.#selected : -1;
  }

  /** Selects a layer, as a click on it in the list does. */
  select(index: number) {
    if (!this.#template || index < 0 || index >= this.#template.layers.length) return;
    this.#selected = index;
    this.#picked.clear();
    this.#showLayers();
  }

  /** A layer as being edited: settings half typed, expressions as text. */
  layer(index: number): Layer | null {
    return this.#template?.layers[index] ?? null;
  }

  /**
   * Sets a layer's setting from elsewhere, such as a drag on the picture.
   * Quick changes of the same `kind` undo as one: a drag sets two settings by
   * turns, and is one step.
   */
  set(index: number, key: string, value: ParamValue, kind = `param:${index}:${key}`) {
    const layer = this.#template?.layers[index];
    if (!layer) return;
    this.#change(kind, () => (layer.params[key] = value));
  }

  /** Makes the settings shown anew, after a change made elsewhere. */
  refresh() {
    this.#showSettings();
  }

  /** Brings the live values of the selected layer's expressions up to date: once a frame. */
  tick() {
    this.#settings?.tick();
    this.#top?.tick();
  }

  /** Videos of the template found somewhere else: where they are now, by name. */
  relink(media: Record<string, MediaFile>) {
    this.#change('', (template) => (template.media = { ...template.media, ...media }));
  }

  /** The template's name was changed outside the list of layers; one undo step per bout of typing. */
  rename(name: string) {
    this.#change('name', (template) => (template.name = name));
  }

  step(direction: 'undo' | 'redo') {
    if (!this.#template) return;
    const [from, to] = direction === 'undo' ? [this.#past, this.#future] : [this.#future, this.#past];
    const state = from.pop();
    if (state === undefined) return;
    to.push(JSON.stringify(this.#template));
    this.#template = JSON.parse(state);
    this.#selected = Math.min(this.#selected, this.#template!.layers.length - 1);
    this.#picked.clear();
    this.#lastChange = { kind: '', at: 0 };
    this.#showLayers();
    this.#showSettings();
    if (!$('editor-fields-pane').hidden) this.#showFields();
    if (!$('editor-about-pane').hidden) this.#showAbout();
    this.#options.change(structuredClone(this.#template!));
    this.#options.history();
  }

  /**
   * Makes a change as one undo step, or as part of the last one when it is
   * of the same kind and follows closely.
   */
  #change(kind: string, apply: (template: Template) => void) {
    const template = this.#template;
    if (!template) return;
    const now = performance.now();
    const merge = kind !== '' && kind === this.#lastChange.kind && now - this.#lastChange.at < MERGE_MS;
    if (!merge) this.#past.push(JSON.stringify(template));
    this.#future = [];
    this.#lastChange = { kind, at: now };
    apply(template);
    this.#showLayers();
    this.#options.change(structuredClone(template));
    this.#options.history();
  }

  /**
   * The line above the list, as an image editor has it: the blend, and the
   * opacity as a value in a box. The full opacity control, slider, ƒ and
   * "moves with…" and all, opens under the box on a click, or while the
   * pointer rests on it.
   */
  #topBar(layer: Layer, context: Parameters<typeof layerSettings>[1]): { element: HTMLElement; tick(): void } {
    const bar = document.createElement('div');
    bar.className = 'layer-top-settings';

    const blend = document.createElement('select');
    blend.className = 'layer-blend';
    blend.title = 'How this layer mixes with what is beneath it';
    blend.setAttribute('aria-label', 'Blend');
    for (const option of COMMON_PARAMS.blend.choices ?? []) blend.add(new Option(SHOWN_AS[option] ?? option, option));
    for (const field of this.#template!.fields.filter((f) => f.kind === 'choice')) blend.add(new Option(`Field: ${field.label}`, `%${field.key}%`));
    blend.value = String(layer.params.blend ?? 'normal');
    blend.addEventListener('change', () => context.set('blend', blend.value));

    const holder = document.createElement('div');
    holder.className = 'opacity-holder';
    const label = document.createElement('span');
    label.textContent = 'Opacity';
    const value = document.createElement('button');
    value.type = 'button';
    value.className = 'opacity-value';
    // No tooltip: resting the pointer here opens the full control, which a tooltip would cover.
    value.setAttribute('aria-label', 'Opacity');
    const popover = document.createElement('div');
    popover.className = 'opacity-popover';
    popover.hidden = true;
    const full = layerSettings(layer, context, ['opacity']);
    popover.append(full.element);
    holder.append(label, value, popover);
    bar.append(blend, holder);

    // Opened by a click, it stays until a click elsewhere or Escape; opened by resting the pointer, until it leaves.
    let pinned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = (pin: boolean) => {
      pinned ||= pin;
      popover.hidden = false;
      value.classList.add('on');
    };
    const close = () => {
      pinned = false;
      popover.hidden = true;
      value.classList.remove('on');
    };
    value.addEventListener('click', () => (pinned ? close() : open(true)));
    // Dragged sideways, the opacity changes, half a percent a pixel; one that follows an expression is not dragged.
    scrubbable(value, {
      value: () => (typeof (layer.params.opacity ?? 100) === 'number' ? Number(layer.params.opacity ?? 100) : null),
      set: (opacity) => context.set('opacity', opacity),
      perPixel: 0.5,
      min: 0,
      max: 100,
    });
    holder.addEventListener('mouseenter', () => {
      clearTimeout(timer);
      timer = setTimeout(() => open(false), 250);
    });
    holder.addEventListener('mouseleave', () => {
      clearTimeout(timer);
      // A moment's grace, and not while typing in it.
      timer = setTimeout(() => {
        if (!pinned && !popover.contains(document.activeElement)) close();
      }, 350);
    });
    const outside = (event: MouseEvent) => {
      if (!holder.isConnected) return document.removeEventListener('mousedown', outside);
      if (!popover.hidden && !holder.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', outside);
    holder.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        close();
        value.focus();
      }
    });

    const show = () => {
      const given = layer.params.opacity ?? 100;
      if (typeof given === 'number') value.textContent = `${Math.round(given)}%`;
      else {
        // As drawn: an expression can come to more than 100, or less than nothing, but the picture cannot.
        const now = context.live()?.opacity;
        value.textContent = typeof now === 'number' ? `ƒ ${Math.round(Math.max(0, Math.min(100, now)))}%` : 'ƒ';
      }
      value.classList.toggle('expression', typeof given !== 'number');
    };
    show();
    return {
      element: bar,
      tick() {
        full.tick();
        show();
      },
    };
  }

  /** The blend and opacity above the list, greyed, while no layer is selected. */
  #emptyTop(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'layer-top-settings empty';
    const blend = document.createElement('select');
    blend.className = 'layer-blend';
    blend.add(new Option('normal'));
    blend.disabled = true;
    const holder = document.createElement('div');
    holder.className = 'opacity-holder';
    const label = document.createElement('span');
    label.textContent = 'Opacity';
    const value = document.createElement('button');
    value.className = 'opacity-value';
    value.textContent = '100%';
    value.disabled = true;
    holder.append(label, value);
    box.append(blend, holder);
    return box;
  }

  /**
   * Changes which layers are where (adding, moving, grouping, removing) as
   * one step: on the layers as a tree, made back into the list after. The
   * layer to select after is given as itself, as its place in the list moves.
   */
  #restructure(apply: (tree: LayerNode[]) => void, select: () => Layer | Layer[] | null) {
    if (!this.#template) return;
    let chosen: Layer[] = [];
    this.#change('', (template) => {
      const tree = treeOf(template.layers);
      apply(tree);
      template.layers = flatten(tree);
      const given = select();
      chosen = given === null ? [] : Array.isArray(given) ? given : [given];
    });
    // The last given is the one whose settings show.
    this.#picked = new Set(chosen);
    this.#selected = chosen.length ? this.#template.layers.indexOf(chosen.at(-1)!) : -1;
    this.#showLayers();
  }

  /**
   * The layers selected, in drawing order, the back first; a layer in a
   * selected group is left out, as it goes wherever its group goes.
   */
  #chosen(): Layer[] {
    const template = this.#template;
    if (!template) return [];
    const picked = new Set(this.#picked);
    if (this.#selectedLayer) picked.add(this.#selectedLayer);
    const tree = treeOf(template.layers);
    const out: Layer[] = [];
    const walk = (nodes: LayerNode[]) => {
      for (const node of nodes) {
        if (picked.has(node.layer)) out.push(node.layer);
        else if (node.children) walk(node.children);
      }
    };
    walk(tree);
    return out.sort((a, b) => template.layers.indexOf(a) - template.layers.indexOf(b));
  }

  get #selectedLayer(): Layer | null {
    return this.#template?.layers[this.#selected] ?? null;
  }

  #addLayer(type: string) {
    // In front of the selected layer, beside it in its group; or in front of everything.
    const selected = this.#selectedLayer;
    const node: LayerNode = type === 'group' ? { layer: { ...newLayer(type), name: this.#groupName() }, children: [] } : { layer: newLayer(type) };
    this.#restructure((tree) => {
      const at = selected ? locate(tree, selected) : null;
      if (at) at.siblings.splice(at.index + 1, 0, node);
      else tree.push(node);
    }, () => node.layer);
  }

  /** A name for a new group: Group 1, Group 2… */
  #groupName(): string {
    const taken = new Set(this.#template!.layers.map((layer) => layer.name));
    let n = 1;
    while (taken.has(`Group ${n}`)) n++;
    return `Group ${n}`;
  }

  /** A copy of each selected layer, a group with all in it, in front of it (⌘J, as in an image editor); the copies are selected after. */
  duplicateSelected() {
    const chosen = this.#chosen();
    if (!chosen.length) return;
    const copy = (node: LayerNode): LayerNode => ({ layer: structuredClone({ ...node.layer }), ...(node.children ? { children: node.children.map(copy) } : {}) });
    const made: Layer[] = [];
    this.#restructure((tree) => {
      for (const layer of chosen) {
        const at = locate(tree, layer)!;
        const twin = copy(at.siblings[at.index]);
        made.push(twin.layer);
        at.siblings.splice(at.index + 1, 0, twin);
      }
    }, () => made);
  }

  /** Puts the selected layers in one new group, where the front-most of them was, in their order (⌘G). */
  groupSelected() {
    const chosen = this.#chosen();
    if (!chosen.length) return;
    const group: Layer = { ...newLayer('group'), name: this.#groupName() };
    this.#restructure((tree) => {
      const front = locate(tree, chosen.at(-1)!)!;
      const node: LayerNode = { layer: group, children: [] };
      front.siblings.splice(front.index, 0, node);
      for (const layer of chosen) {
        const at = locate(tree, layer)!;
        node.children!.push(...at.siblings.splice(at.index, 1));
      }
    }, () => group);
  }

  /** Takes the layers of each selected group out of it, in its place, and the group away (Shift+⌘G). */
  ungroupSelected() {
    const groups = this.#chosen().filter(isGroup);
    if (!groups.length) return;
    const freed: Layer[] = [];
    this.#restructure((tree) => {
      for (const group of groups) {
        const at = locate(tree, group)!;
        const children = at.siblings[at.index].children ?? [];
        freed.push(...children.map((child) => child.layer));
        at.siblings.splice(at.index, 1, ...children);
      }
    }, () => freed);
  }

  /** Removes the selected layer, as Delete or Backspace does while the editor is open, wherever the layer was selected. */
  deleteSelected() {
    this.#deleteLayer();
  }

  #deleteLayer() {
    const chosen = this.#chosen();
    if (!chosen.length) return;
    // Groups go with all in them. The one selected after is the nearest left beside the front-most of them,
    // in front of it if there is one, else behind; or else their group.
    let next: Layer | null = null;
    this.#restructure((tree) => {
      const gone = new Set(chosen);
      const front = locate(tree, chosen.at(-1)!)!;
      const left = (node: LayerNode | undefined) => node && !gone.has(node.layer);
      next = front.siblings.slice(front.index + 1).find(left)?.layer
        ?? front.siblings.slice(0, front.index).reverse().find(left)?.layer
        ?? (front.parent && !gone.has(front.parent.layer) ? front.parent.layer : null);
      for (const layer of chosen) {
        const at = locate(tree, layer)!;
        at.siblings.splice(at.index, 1);
      }
    }, () => next);
    // The layer selected now has the keys, so that pressing Delete again removes it in turn.
    $('editor-layers').querySelector<HTMLElement>(`[data-index="${this.#selected}"]`)?.focus();
  }

  /** One place towards the front (`by` 1) or the back (-1), among the layers beside it. */
  #nudge(by: number) {
    const selected = this.#selectedLayer;
    if (!selected) return;
    this.#restructure((tree) => {
      const at = locate(tree, selected)!;
      const to = Math.max(0, Math.min(at.siblings.length - 1, at.index + by));
      const [node] = at.siblings.splice(at.index, 1);
      at.siblings.splice(to, 0, node);
    }, () => selected);
  }

  /** Groups folded in the list, by the group: kept while the editor is open, not in the template. */
  readonly #folded = new WeakSet<Layer>();

  #showLayers() {
    const template = this.#template;
    const list = $('editor-layers');
    if (!template) {
      list.replaceChildren();
      return;
    }
    // Selected: those still there, and always the one whose settings show.
    for (const layer of this.#picked) if (!template.layers.includes(layer)) this.#picked.delete(layer);
    if (this.#selectedLayer) this.#picked.add(this.#selectedLayer);
    else this.#picked.clear();
    // Front first, each group's layers under it, indented; a folded group's left out.
    const place = new Map(template.layers.map((layer, index) => [layer, index]));
    const rows: HTMLElement[] = [];
    const emit = (nodes: LayerNode[], depth: number) => {
      for (const node of [...nodes].reverse()) {
        rows.push(this.#row(node.layer, place.get(node.layer)!, depth, node.children !== undefined));
        if (node.children && !this.#folded.has(node.layer)) emit(node.children, depth + 1);
      }
    };
    emit(treeOf(template.layers), 0);
    list.replaceChildren(...rows);
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'editor-empty';
      empty.textContent = 'No layers. Add one below.';
      list.append(empty);
    }
    this.#showSelection();
  }

  /**
   * Shows which layers are selected, and what goes with that: the buttons,
   * and the settings of the one clicked last. The rows stay as they are: made
   * anew, the row a double-click began on would be gone before it ended.
   */
  #showSelection() {
    const template = this.#template;
    if (!template) return;
    for (const layer of this.#picked) if (!template.layers.includes(layer)) this.#picked.delete(layer);
    if (this.#selectedLayer) this.#picked.add(this.#selectedLayer);
    else this.#picked.clear();
    for (const row of $('editor-layers').querySelectorAll<HTMLElement>('.layer-row')) {
      row.classList.toggle('on', this.#picked.has(template.layers[Number(row.dataset.index)]));
    }
    const selected = this.#selectedLayer;
    $<HTMLButtonElement>('editor-duplicate').disabled = !selected;
    $<HTMLButtonElement>('editor-delete').disabled = !selected;
    $<HTMLButtonElement>('editor-group').disabled = !selected;
    $('editor-ungroup').hidden = !this.#chosen().some(isGroup);
    if (selected !== this.#settingsFor) this.#showSettings();
    // With several selected, the settings below are the one clicked last's; the heading says so.
    const title = document.getElementById('editor-layer-title');
    if (title && selected) {
      const more = this.#picked.size - 1;
      title.textContent = `${selected.name || LAYER_TYPES[selected.type].label}${more ? ` and ${more} more selected` : ''}`;
    }
  }

  /** The settings of the selected layer, made anew only when another layer is selected or the template is replaced. */
  #showSettings() {
    const layer = this.#template?.layers[this.#selected] ?? null;
    this.#settingsFor = layer;
    const panel = $('editor-layer');
    const top = $('editor-layer-top');
    if (!layer || !this.#template) {
      this.#settings = null;
      this.#top = null;
      panel.replaceChildren();
      // As in an image editor: there, but with nothing to act on.
      top.replaceChildren(this.#emptyTop());
      return;
    }
    const kindOf = (key: string) => `param:${this.#template!.layers.indexOf(layer)}:${key}`;
    const context: Parameters<typeof layerSettings>[1] = {
      template: () => this.#template!,
      set: (key, value) => this.#change(kindOf(key), () => (layer.params[key] = value)),
      pack: (key, name, data) => this.#change('', (template) => {
        template.assets = { ...template.assets, [name]: data };
        layer.params[key] = `asset:${name}`;
      }),
      live: () => this.#options.live(this.#template!.layers.indexOf(layer)),
      pickPicture: () => this.#options.pickPicture(),
      pickVideo: () => this.#options.pickVideo(),
      keepVideo: (key, name, file) => this.#change('', (template) => {
        template.media = { ...template.media, [name]: file };
        layer.params[key] = MEDIA_PREFIX + name;
      }),
    };
    this.#settings = layerSettings(layer, context);
    this.#top = this.#topBar(layer, context);
    top.replaceChildren(this.#top.element);
    const title = document.createElement('h3');
    title.className = 'editor-section';
    title.id = 'editor-layer-title';
    title.textContent = layer.name || LAYER_TYPES[layer.type].label;
    panel.replaceChildren(title, this.#settings.element);
  }

  #row(layer: Layer, index: number, depth: number, group: boolean): HTMLElement {
    const spec = LAYER_TYPES[layer.type];
    const row = document.createElement('div');
    row.className = this.#picked.has(layer) ? 'layer-row on' : 'layer-row';
    if (group) row.classList.add('group');
    row.tabIndex = 0;
    row.dataset.index = String(index);
    row.style.paddingLeft = `${3 + depth * 16}px`;
    const hidden = layer.params.visible === false;
    if (hidden) row.classList.add('hidden');

    const eye = document.createElement('button');
    eye.className = 'icon layer-eye';
    eye.title = hidden ? 'Hidden: click to show this layer' : 'Shown: click to hide this layer';
    eye.setAttribute('aria-label', hidden ? 'Show this layer' : 'Hide this layer');
    eye.innerHTML = hidden
      ? '<svg class="line" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM3 13 13 3"/></svg>'
      : '<svg class="line" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="1.8"/></svg>';
    eye.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#change('', (template) => (template.layers[index].params.visible = hidden));
    });
    row.append(eye);

    if (group) {
      // Folding a group hides its layers in the list, not in the picture.
      const fold = document.createElement('button');
      fold.className = 'icon layer-fold';
      const folded = this.#folded.has(layer);
      fold.title = folded ? 'Show what is in this group' : 'Fold this group';
      fold.setAttribute('aria-label', fold.title);
      fold.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${folded ? 'M6 4l5 4-5 4z' : 'M4 6h8l-4 5z'}"/></svg>`;
      fold.addEventListener('click', (event) => {
        event.stopPropagation();
        if (folded) this.#folded.delete(layer);
        else this.#folded.add(layer);
        this.#showLayers();
      });
      row.append(fold);
    }

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.name || spec.label;
    name.title = 'Double-click to rename';
    const kind = document.createElement('span');
    kind.className = 'layer-kind';
    kind.textContent = layer.name ? spec.label : '';
    row.append(name, kind);

    row.addEventListener('dblclick', () => this.#renameLayer(row, name, index));
    row.addEventListener('keydown', (event) => {
      // Keys on a layer belong to the list: they must not reach the window, where Backspace deletes a mix.
      if (event.target !== row) return;
      if (event.key === 'Backspace' || event.key === 'Delete') this.#deleteLayer();
      else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (event.altKey) this.#nudge(event.key === 'ArrowUp' ? 1 : -1);
        else {
          // The row above or below in the list, as it is shown.
          const rows = [...$('editor-layers').querySelectorAll<HTMLElement>('.layer-row')];
          const at = rows.indexOf(row) + (event.key === 'ArrowUp' ? -1 : 1);
          if (rows[at]) this.#selected = Number(rows[at].dataset.index);
          this.#picked.clear();
          this.#showLayers();
        }
        $('editor-layers').querySelector<HTMLElement>(`[data-index="${this.#selected}"]`)?.focus();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    });
    row.addEventListener('mousedown', (event) => {
      if ((event.target as HTMLElement).closest('button, input')) return;
      if (event.metaKey || event.ctrlKey) {
        // ⌘-click: one more selected, or one less.
        if (this.#picked.has(layer) && this.#picked.size > 1) {
          this.#picked.delete(layer);
          if (this.#selectedLayer === layer) this.#selected = this.#template!.layers.indexOf([...this.#picked].at(-1)!);
        } else {
          this.#picked.add(layer);
          this.#selected = index;
        }
        return this.#showSelection();
      }
      if (event.shiftKey && this.#selectedLayer) {
        // Shift-click: every row from the one clicked last to this one, as the list shows them.
        const rows = [...$('editor-layers').querySelectorAll<HTMLElement>('.layer-row')];
        const from = rows.findIndex((r) => Number(r.dataset.index) === this.#selected);
        const to = rows.indexOf(row);
        const [low, high] = from < to ? [from, to] : [to, from];
        this.#picked = new Set(rows.slice(low, high + 1).map((r) => this.#template!.layers[Number(r.dataset.index)]));
        this.#selected = index;
        return this.#showSelection();
      }
      // A plain click on one of several selected keeps them, to drag together; let go without a drag, just it.
      const together = this.#picked.has(layer) && this.#picked.size > 1;
      this.#selected = index;
      if (!together) this.#picked = new Set([layer]);
      this.#showSelection();
      this.#dragRow(event, row, together ? this.#chosen() : [layer], () => {
        if (!together) return;
        this.#picked = new Set([layer]);
        this.#showSelection();
      });
    });
    return row;
  }

  /**
   * Dragging a layer to another place in the list: above a row puts it in
   * front of that layer, below, behind it, beside it in its group; onto a
   * group, into the group, in front of what is in it.
   */
  #dragRow(down: MouseEvent, row: HTMLElement, moving: Layer[], clicked: () => void) {
    const list = $('editor-layers');
    // The one clicked stays the one whose settings show.
    const primary = this.#selectedLayer;
    let drop: { target: Layer | null; where: 'above' | 'below' | 'into' } | null = null;
    let dragging = false;
    const marks = ['drop-above', 'drop-below', 'drop-into'];
    const move = (event: MouseEvent) => {
      if (!dragging && Math.abs(event.clientY - down.clientY) < DRAG_START_PX) return;
      dragging = true;
      row.classList.add('dragging');
      const rows = [...list.querySelectorAll<HTMLElement>('.layer-row')];
      for (const r of rows) r.classList.remove(...marks);
      const over = rows.find((r) => event.clientY < r.getBoundingClientRect().bottom) ?? null;
      if (!over) {
        // Below every row: at the very back.
        drop = { target: null, where: 'below' };
        rows.at(-1)?.classList.add('drop-below');
        return;
      }
      const box = over.getBoundingClientRect();
      const share = (event.clientY - box.top) / box.height;
      const target = this.#template!.layers[Number(over.dataset.index)];
      const where = over.classList.contains('group') ? (share < 0.3 ? 'above' : share > 0.7 && this.#folded.has(target) ? 'below' : 'into') : share < 0.5 ? 'above' : 'below';
      // Not onto one of those being dragged, nor into a group inside one.
      const tree = treeOf(this.#template!.layers);
      if (moving.some((layer) => { const at = locate(tree, layer)!; return within(at.siblings[at.index], target); })) {
        drop = null;
        return;
      }
      drop = { target, where };
      over.classList.add(`drop-${where}`);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      for (const r of list.querySelectorAll('.layer-row')) r.classList.remove(...marks, 'dragging');
      if (!dragging) {
        clicked();
        return row.focus();
      }
      if (!drop) return;
      const { target, where } = drop;
      this.#restructure((tree) => {
        // Taken out, then put back together, in their order, where they were dropped.
        const nodes = moving.map((layer) => {
          const from = locate(tree, layer)!;
          return from.siblings.splice(from.index, 1)[0];
        });
        if (!target) return void tree.unshift(...nodes);
        const at = locate(tree, target)!;
        if (where === 'into') {
          const group = at.siblings[at.index];
          (group.children ??= []).push(...nodes);
          this.#folded.delete(group.layer);
        } else at.siblings.splice(where === 'above' ? at.index + 1 : at.index, 0, ...nodes);
      }, () => [...moving.filter((layer) => layer !== primary), ...(primary ? [primary] : [])]);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  #renameLayer(row: HTMLElement, name: HTMLElement, index: number) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'layer-rename';
    input.spellcheck = false;
    input.value = this.#template!.layers[index].name ?? '';
    input.placeholder = LAYER_TYPES[this.#template!.layers[index].type].label;
    name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (keep && value !== (this.#template!.layers[index].name ?? '')) {
        this.#change('', (template) => {
          if (value) template.layers[index].name = value;
          else delete template.layers[index].name;
        });
      } else {
        this.#showLayers();
      }
      row.focus();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
      event.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }
}
