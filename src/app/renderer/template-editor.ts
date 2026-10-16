// The template editor, in the Video view's panel while a template of the
// user's own is being changed. It works on a copy of the template and hands
// every change back (`change`), which shows it in the picture at once and
// saves it; it keeps its own undo history, as a template is not part of any
// one mix.
//
// The layers are listed front-most first, as in image editors, though a
// template keeps them in drawing order, back first.

import { COMMON_PARAMS, LAYER_TYPES, type Layer, type ParamValue, type Template } from '../../visuals/template.ts';

export interface TemplateEditorOptions {
  /** A change made here: the template as it now is. */
  change(template: Template): void;
  /** What can be undone or redone has changed. */
  history(): void;
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
  for (const [key, param] of Object.entries({ ...COMMON_PARAMS, ...spec.params })) params[key] = param.default;
  return { type, params };
}

export class TemplateEditor {
  readonly #options: TemplateEditorOptions;
  #template: Template | null = null;
  /** The selected layer, by its place in the template (0 is the back), or -1. */
  #selected = -1;
  #past: string[] = [];
  #future: string[] = [];
  #lastChange = { kind: '', at: 0 };

  constructor(options: TemplateEditorOptions) {
    this.#options = options;
    const add = $<HTMLSelectElement>('editor-add');
    for (const [type, spec] of Object.entries(LAYER_TYPES)) add.add(new Option(spec.label, type));
    add.addEventListener('change', () => {
      if (!add.value) return;
      this.#addLayer(add.value);
      add.value = '';
    });
    $('editor-duplicate').addEventListener('click', () => this.#duplicateLayer());
    $('editor-delete').addEventListener('click', () => this.#deleteLayer());
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
    this.#past = [];
    this.#future = [];
    this.#lastChange = { kind: '', at: 0 };
    this.#showLayers();
    this.#options.history();
  }

  stop() {
    this.#template = null;
    this.#past = [];
    this.#future = [];
    this.#options.history();
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
    this.#lastChange = { kind: '', at: 0 };
    this.#showLayers();
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

  #addLayer(type: string) {
    // In front of the selected layer, or in front of everything.
    const at = this.#selected >= 0 ? this.#selected + 1 : this.#template!.layers.length;
    this.#change('', (template) => template.layers.splice(at, 0, newLayer(type)));
    this.#selected = at;
    this.#showLayers();
  }

  #duplicateLayer() {
    const index = this.#selected;
    if (!this.#template || index < 0) return;
    this.#change('', (template) => template.layers.splice(index + 1, 0, structuredClone(template.layers[index])));
    this.#selected = index + 1;
    this.#showLayers();
  }

  #deleteLayer() {
    const index = this.#selected;
    if (!this.#template || index < 0) return;
    this.#change('', (template) => template.layers.splice(index, 1));
    this.#selected = Math.min(index, this.#template.layers.length - 1);
    this.#showLayers();
  }

  #moveLayer(from: number, to: number) {
    if (from === to) return;
    this.#change('', (template) => {
      const [layer] = template.layers.splice(from, 1);
      template.layers.splice(to, 0, layer);
    });
    this.#selected = to;
    this.#showLayers();
  }

  #showLayers() {
    const template = this.#template;
    const list = $('editor-layers');
    if (!template) {
      list.replaceChildren();
      return;
    }
    const rows = template.layers.map((layer, index) => this.#row(layer, index)).reverse();
    list.replaceChildren(...rows);
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'editor-empty';
      empty.textContent = 'No layers. Add one below.';
      list.append(empty);
    }
    $<HTMLButtonElement>('editor-duplicate').disabled = this.#selected < 0;
    $<HTMLButtonElement>('editor-delete').disabled = this.#selected < 0;
  }

  #row(layer: Layer, index: number): HTMLElement {
    const spec = LAYER_TYPES[layer.type];
    const row = document.createElement('div');
    row.className = index === this.#selected ? 'layer-row on' : 'layer-row';
    row.tabIndex = 0;
    row.dataset.index = String(index);
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

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.name || spec.label;
    name.title = 'Double-click to rename';
    const kind = document.createElement('span');
    kind.className = 'layer-kind';
    kind.textContent = layer.name ? spec.label : '';
    row.append(eye, name, kind);

    row.addEventListener('dblclick', () => this.#renameLayer(row, name, index));
    row.addEventListener('keydown', (event) => {
      // Keys on a layer belong to the list: they must not reach the window, where Backspace deletes a mix.
      if (event.target !== row) return;
      if (event.key === 'Backspace' || event.key === 'Delete') this.#deleteLayer();
      else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const step = event.key === 'ArrowUp' ? 1 : -1;
        const to = Math.max(0, Math.min(this.#template!.layers.length - 1, index + step));
        if (event.altKey) this.#moveLayer(index, to);
        else this.#selected = to;
        this.#showLayers();
        $('editor-layers').querySelector<HTMLElement>(`[data-index="${this.#selected}"]`)?.focus();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    });
    row.addEventListener('mousedown', (event) => {
      if ((event.target as HTMLElement).closest('button, input')) return;
      this.#selected = index;
      for (const other of $('editor-layers').children) other.classList.toggle('on', other === row);
      $<HTMLButtonElement>('editor-duplicate').disabled = false;
      $<HTMLButtonElement>('editor-delete').disabled = false;
      this.#dragRow(event, row, index);
    });
    return row;
  }

  /** Dragging a layer up or down the list to put it in front of or behind others. */
  #dragRow(down: MouseEvent, row: HTMLElement, index: number) {
    const list = $('editor-layers');
    let target = index;
    let dragging = false;
    const move = (event: MouseEvent) => {
      if (!dragging && Math.abs(event.clientY - down.clientY) < DRAG_START_PX) return;
      dragging = true;
      row.classList.add('dragging');
      // The row the pointer is over, as a place in the template; the list shows it front first.
      const rows = [...list.querySelectorAll<HTMLElement>('.layer-row')];
      let over = rows.findIndex((r) => event.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
      if (over < 0) over = rows.length;
      const shownFrom = Math.min(over > rows.indexOf(row) ? over - 1 : over, rows.length - 1);
      target = rows.length - 1 - shownFrom;
      for (const r of rows) r.classList.remove('drop-above', 'drop-below');
      const mark = rows[Math.min(over, rows.length - 1)];
      if (mark && mark !== row) mark.classList.add(over < rows.length ? 'drop-above' : 'drop-below');
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (dragging) this.#moveLayer(index, target);
      else row.focus();
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
