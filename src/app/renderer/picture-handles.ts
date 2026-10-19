// Dragging layers on the picture while a template is edited: an outline round
// the selected layer, to drag to move it, with a handle at each corner to
// resize it. A click on the picture selects the top-most layer there. Where a
// layer was drawn comes from the drawer (`FrameDrawer.boxes`), so the outline
// follows a layer that moves with the music.
//
// A drag sets the same settings as the sliders do: position, and the width
// and height, the size of a text, a ring's radius, or else the scale.

import type { LayerBox } from '../../visuals/draw.ts';
import { LAYER_TYPES, type Layer, type ParamValue } from '../../visuals/template.ts';

export interface PictureHandlesContext {
  canvas: HTMLCanvasElement;
  /** Where each layer was drawn in the last frame. */
  boxes(): (LayerBox | null)[];
  /** The layer being edited at a place in the template, as typed. */
  layer(index: number): Layer | null;
  selected(): number;
  select(index: number): void;
  /** Gives a setting of a layer a new value; changes of the same `kind` in quick succession undo as one. */
  set(index: number, key: string, value: ParamValue, kind: string): void;
  /** A drag is over: the settings shown are brought up to date. */
  done(): void;
  say(text: string): void;
}

/** Movement under this many pixels is a click, not a drag. */
const DRAG_START_PX = 4;
const round = (value: number) => Math.round(value * 10) / 10;

export class PictureHandles {
  readonly #context: PictureHandlesContext;
  readonly #overlay: HTMLElement;
  readonly #outline: HTMLElement;
  readonly #point: HTMLElement;
  #shown = false;

  constructor(overlay: HTMLElement, context: PictureHandlesContext) {
    this.#context = context;
    this.#overlay = overlay;
    this.#outline = document.createElement('div');
    this.#outline.className = 'layer-outline';
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      const handle = document.createElement('div');
      handle.className = `corner ${corner}`;
      handle.dataset.corner = corner;
      handle.title = 'Drag to resize; with Shift, keeping its proportions';
      this.#outline.append(handle);
    }
    this.#outline.title = 'Drag to move';
    this.#point = document.createElement('div');
    this.#point.className = 'layer-point';
    this.#point.title = 'Drag to move';
    overlay.append(this.#outline, this.#point);
    overlay.addEventListener('mousedown', (event) => this.#press(event));
  }

  show(on: boolean) {
    this.#shown = on;
    this.#overlay.hidden = !on;
  }

  /** Puts the outline where the selected layer was just drawn: once a frame. */
  update() {
    if (!this.#shown) return;
    const index = this.#context.selected();
    const box = this.#context.boxes()[index] ?? null;
    const layer = this.#context.layer(index);
    // An effect has no place, except a kaleidoscope, a vignette, trails or a displace, whose position is its centre; nor has a group, nor a solid colour.
    const centred = ['kaleidoscope', 'vignette', 'trails', 'displace'];
    const effect = layer ? (LAYER_TYPES[layer.type]?.effect === true && !centred.includes(layer.type)) || layer.type === 'group' || layer.type === 'solid' : true;
    const { k, offsetX, offsetY } = this.#frame();
    this.#outline.hidden = !box;
    // A layer without a box (a gradient, glitter) has its position only; an effect has none.
    this.#point.hidden = !!box || !layer || effect;
    if (box) {
      const s = box.scale * k;
      Object.assign(this.#outline.style, {
        width: `${Math.abs(box.w * s)}px`,
        height: `${Math.abs(box.h * s)}px`,
        transform: `translate(${offsetX + box.x * k}px, ${offsetY + box.y * k}px) rotate(${box.rotation}deg) translate(${box.left * s}px, ${box.top * s}px)`,
      });
      this.#outline.classList.toggle('circle', box.circle);
    } else if (layer && !effect) {
      const x = typeof layer.params.x === 'number' ? layer.params.x : 50;
      const y = typeof layer.params.y === 'number' ? layer.params.y : 50;
      this.#point.style.transform = `translate(${offsetX + (x / 100) * this.#context.canvas.width * k}px, ${offsetY + (y / 100) * this.#context.canvas.height * k}px)`;
    }
  }

  /** How the canvas's pixels map to the overlay's: the scale, and where the picture starts in it. */
  #frame() {
    const canvas = this.#context.canvas.getBoundingClientRect();
    const overlay = this.#overlay.getBoundingClientRect();
    return { k: canvas.width / this.#context.canvas.width, offsetX: canvas.left - overlay.left, offsetY: canvas.top - overlay.top };
  }

  /** A point of the page in the canvas's pixels. */
  #toCanvas(event: MouseEvent) {
    const rect = this.#context.canvas.getBoundingClientRect();
    const k = rect.width / this.#context.canvas.width;
    return { x: (event.clientX - rect.left) / k, y: (event.clientY - rect.top) / k };
  }

  /** A point in the canvas's pixels, in a layer's own coordinates: from its anchor point, unrotated and unscaled. */
  static #local(box: LayerBox, x: number, y: number) {
    const angle = (-box.rotation * Math.PI) / 180;
    const dx = x - box.x;
    const dy = y - box.y;
    return { x: (dx * Math.cos(angle) - dy * Math.sin(angle)) / box.scale, y: (dx * Math.sin(angle) + dy * Math.cos(angle)) / box.scale };
  }

  #press(event: MouseEvent) {
    if (event.button !== 0) return;
    const at = this.#toCanvas(event);
    const boxes = this.#context.boxes();
    const corner = (event.target as HTMLElement).dataset.corner;
    let index = this.#context.selected();
    const onSelected = corner || event.target === this.#outline || event.target === this.#point;
    if (!onSelected) {
      // The top-most layer drawn under the pointer.
      index = -1;
      for (let i = boxes.length - 1; i >= 0; i--) {
        const box = boxes[i];
        // An effect that has an outline, such as a transform's, covers the whole picture: picked in the list, not here.
        if (!box || LAYER_TYPES[this.#context.layer(i)?.type ?? '']?.effect) continue;
        const local = PictureHandles.#local(box, at.x, at.y);
        if (local.x >= Math.min(box.left, box.left + box.w) && local.x <= Math.max(box.left, box.left + box.w)
          && local.y >= Math.min(box.top, box.top + box.h) && local.y <= Math.max(box.top, box.top + box.h)) {
          index = i;
          break;
        }
      }
      if (index < 0) return;
      this.#context.select(index);
    }
    const layer = this.#context.layer(index);
    if (!layer) return;
    event.preventDefault();
    const box = boxes[index];
    const name = layer.name || LAYER_TYPES[layer.type].label;
    const plain = (key: string) => typeof (layer.params[key] ?? 0) === 'number';
    // What a drag changes, and from what.
    const start = { ...layer.params };
    const canvas = this.#context.canvas;
    // One undo step for the whole drag, whichever settings it changes.
    const drag = `drag:${index}:${performance.now()}`;
    let change: ((event: MouseEvent) => void) | null = null;

    if (corner && box) {
      const grabbed = PictureHandles.#local(box, at.x, at.y);
      // A shape whose height is its width is sized by its width alone, evenly.
      const keys = box.circle ? ['radius'] : layer.type === 'shape' && layer.params.square === true ? ['width']
        : 'width' in LAYER_TYPES[layer.type].params && layer.type !== 'text' ? ['width', 'height'] : layer.type === 'text' ? ['size'] : ['scale'];
      const following = keys.filter((key) => !plain(key));
      if (following.length) return this.#context.say(`${name}: its ${following.join(' and ')} ${following.length > 1 ? 'follow expressions' : 'follows an expression'}, so it is set in its settings, not by dragging.`);
      change = (moved) => {
        const p = this.#toCanvas(moved);
        const now = PictureHandles.#local(box, p.x, p.y);
        const fx = Math.abs(grabbed.x) > 2 ? now.x / grabbed.x : 1;
        const fy = Math.abs(grabbed.y) > 2 ? now.y / grabbed.y : 1;
        const whole = Math.hypot(now.x, now.y) / Math.max(1, Math.hypot(grabbed.x, grabbed.y));
        const grow = (key: string, by: number) => this.#context.set(index, key, Math.max(0.1, round(Number(start[key]) * Math.max(0.01, by))), drag);
        if (keys.length === 2 && keys[0] === 'width' && !moved.shiftKey) {
          grow('width', fx);
          grow('height', fy);
        } else {
          for (const key of keys) grow(key, whole);
        }
      };
    } else {
      if (!plain('x') || !plain('y')) return this.#context.say(`${name}: its position follows an expression, so it is set in its settings, not by dragging.`);
      change = (moved) => {
        const p = this.#toCanvas(moved);
        this.#context.set(index, 'x', round(Number(start.x ?? 50) + ((p.x - at.x) / canvas.width) * 100), drag);
        this.#context.set(index, 'y', round(Number(start.y ?? 50) + ((p.y - at.y) / canvas.height) * 100), drag);
      };
    }

    let dragging = false;
    const move = (moved: MouseEvent) => {
      if (!dragging && Math.hypot(moved.clientX - event.clientX, moved.clientY - event.clientY) < DRAG_START_PX) return;
      dragging = true;
      change!(moved);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (dragging) this.#context.done();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
}
