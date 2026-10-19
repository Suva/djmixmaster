// Draws a frame of a template on a 2D canvas: the same code for the preview in
// the visuals window and for every frame of a video export. Everything a
// frame shows follows from the moment in the mix and what the music gives
// there, so any frame can be drawn on its own, in any order, and comes out
// the same. The exceptions remember a little from the frame before (the rise
// and fall of the spectrum, a text changing); `reset` forgets it after a jump.
//
// Kept free of Node imports; it runs in a window.

import { fromHsl, mixColours, parseHex, turnHue, type Colour } from './colour.ts';
import { BAND_COUNT, HIGHEST_HZ, LOWEST_HZ } from '../features.ts';
import type { Values } from './expression.ts';
import { fontStack } from './fonts.ts';
import { hexOf, LAYER_TYPES, type PreparedLayer, type ResolvedParams, type TextValues } from './template.ts';
import type { ClipTiming, Playback } from './clip.ts';
import { applyLut, type Lut } from './lut.ts';
import { lengthOf, shapeOutline } from './outline.ts';

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** What a frame is drawn from, besides the template. */
export interface Frame {
  /** Seconds into the mix, and since the frame before. */
  seconds: number;
  dt: number;
  /**
   * Seconds on the clock since the frame before, for what plays out whether
   * the music moves or not, such as a change of text typed in while paused.
   * The same as `dt` where it is not given.
   */
  clockDt?: number;
  /** The mix's length in seconds, for "until, before the end". */
  length: number;
  music: Values;
  /** The spectrum, BAND_COUNT bands each 0 to 1. */
  spectrum: Float32Array;
  /** The level over the last `span` seconds, at `points` times, 0 to 1. */
  levelHistory(span: number, points: number): Float32Array;
  text: TextValues;
  /** Pictures for image layers, by the name or path a template gives. */
  images: Map<string, CanvasImageSource & { width: number; height: number }>;
  /** LUTs for LUT layers, by `lut:name` or path as a template gives them. */
  luts?: Map<string, Lut>;
  /** How much of the picture shows, 0 to 1: the mix's fades in and out take it to black. */
  shown?: number;
  /**
   * The picture of a video layer's clip for this frame, given where the clip
   * is (`clipTime` in clip.ts works it out from `timing`), or null while
   * there is none. `layer` is the layer's place in the template, as two
   * layers can play the same clip at different places.
   */
  video?(source: string, layer: number, timing: ClipTiming): VideoPicture | null;
  /**
   * When a clip last started again by a rule of RESTARTS, in seconds into the
   * mix: the last beat or track start at or before `seconds`; -Infinity if none.
   */
  restartedAt?(rule: string, seconds: number): number;
}

/** A frame of a video, as a video element, a VideoFrame or a picture, with its size as shown. */
export interface VideoPicture {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** What decides where a video layer is in its clip, from its settings for this frame. */
export function clipTimingOf(params: ResolvedParams, frame: Pick<Frame, 'seconds' | 'restartedAt'>): ClipTiming {
  const from = num(params, 'from');
  const rule = str(params, 'restart');
  const restarted = rule && rule !== 'never' && frame.restartedAt ? frame.restartedAt(rule, frame.seconds) : -Infinity;
  return {
    seconds: frame.seconds,
    started: Math.max(from, restarted),
    playback: str(params, 'playback') as Playback,
    speed: num(params, 'speed'),
    inPoint: num(params, 'inPoint'),
    outPoint: num(params, 'outPoint'),
    offset: num(params, 'offset'),
  };
}

/**
 * Where a layer was drawn in the last frame, in the canvas's pixels: its
 * anchor point, and its box around that point before scale and rotation.
 * For the editor, which draws an outline over the picture to drag.
 */
export interface LayerBox {
  x: number;
  y: number;
  left: number;
  top: number;
  w: number;
  h: number;
  scale: number;
  /** Degrees. */
  rotation: number;
  /** A ring rather than a box: its size is a radius. */
  circle: boolean;
}

/** What a layer remembers from frame to frame. */
interface Memory {
  bars?: Float32Array;
  peaks?: Float32Array;
  shown?: string;
  previous?: string;
  /** How far the change from `previous` to `shown` has got, 0 to 1. */
  changing?: number;
  /** A trails layer's picture of the frames before, and a canvas to move it on with; both in half floats. */
  trail?: OffscreenCanvas;
  past?: OffscreenCanvas;
}

/** The switches of a layer's styles: any of them on, and the layer is drawn on its own. */
const STYLES = ['dropShadow', 'outerGlow', 'stroke', 'innerShadow', 'innerGlow'];

/** The canvas's own way of blending, for each blend a template can name; linear burn it has not, and is done by hand. */
const BLENDS: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over', add: 'lighter', screen: 'screen', lighten: 'lighten', 'colour dodge': 'color-dodge',
  multiply: 'multiply', darken: 'darken', 'colour burn': 'color-burn',
  overlay: 'overlay', 'soft light': 'soft-light', 'hard light': 'hard-light', difference: 'difference', exclusion: 'exclusion',
  hue: 'hue', saturation: 'saturation', colour: 'color', luminosity: 'luminosity',
};

const num = (params: ResolvedParams, key: string) => (typeof params[key] === 'number' ? (params[key] as number) : 0);
const str = (params: ResolvedParams, key: string) => String(params[key] ?? '');
const col = (params: ResolvedParams, key: string) => (params[key] && typeof params[key] === 'object' ? (params[key] as Colour) : null);

/** The same value in 0..1 for the same whole number: particles are placed by it, the same on every render. */
function hash(n: number): number {
  let x = Math.imul(n | 0, 0x27d4eb2d) ^ 0x165667b1;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function noise(x: number): number {
  const i = Math.floor(x);
  const t = x - i;
  return hash(i) + (hash(i + 1) - hash(i)) * t * t * (3 - 2 * t);
}

/** Where a box of this size sits so that its anchor is at (x, y). */
function anchored(anchor: string, x: number, y: number, w: number, h: number): [number, number] {
  const left = anchor.includes('left') ? x : anchor.includes('right') ? x - w : x - w / 2;
  const top = anchor.includes('top') ? y : anchor.includes('bottom') ? y - h : y - h / 2;
  return [left, top];
}

export class FrameDrawer {
  readonly #canvas: Canvas;
  /** Where layers draw: the picture's own context, a group's, or a layer's canvas while one with a blend done by hand is drawn. */
  #ctx: Context;
  /** The picture so far that an effect changes: the frame, or the canvas of the group being drawn. */
  #surface: Canvas;
  /** Scratch canvases for effects and images, kept between frames. */
  #scratch: OffscreenCanvas | null = null;
  /** More scratch canvases, for effects that take the picture apart by colour. */
  #extra: OffscreenCanvas[] = [];
  #memories: Memory[] = [];
  /** Particle pictures, drawn once per shape, colour and size. */
  readonly #sprites = new Map<string, OffscreenCanvas>();

  constructor(canvas: Canvas) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d') as Context;
    this.#surface = canvas;
  }

  /** The size of the picture being drawn. */
  get size(): { width: number; height: number } {
    return { width: this.#canvas.width, height: this.#canvas.height };
  }

  /**
   * What sizes are measured against: the short side of the picture. In the
   * usual landscape picture that is its height, as it always was; in a
   * vertical one its width, so that a title or a ring still fits across.
   */
  get #unit(): number {
    return Math.min(this.#canvas.width, this.#canvas.height);
  }

  /** Where each layer was drawn in the last frame, by its place in the template; null for a layer not drawn, or without a box. */
  boxes: (LayerBox | null)[] = [];
  #index = 0;
  /**
   * When set, the time each layer takes is added up here, by its place and
   * kind, in milliseconds: for finding what is slow. The canvas hands its
   * work to the graphics card and goes on, so each layer waits for the card
   * to finish before it is counted; that makes drawing slower while it is on.
   * A group's time includes its layers'.
   */
  profile: Map<string, number> | null = null;

  /** Waits for the graphics card to finish what it was given for this canvas: reading a pixel back makes it. */
  #finish() {
    this.#ctx.getImageData(0, 0, 1, 1);
  }

  /** Whether the last frame had a change of text under way: paused, the frames after it are still needed. */
  changing = false;

  /** Notes where the layer being drawn lies, in its own coordinates after `#place`. */
  #record(params: ResolvedParams, left: number, top: number, w: number, h: number, circle = false) {
    const { width, height } = this.#canvas;
    this.boxes[this.#index] = {
      x: (num(params, 'x') / 100) * width,
      y: (num(params, 'y') / 100) * height,
      left, top, w, h,
      scale: num(params, 'scale') / 100,
      rotation: num(params, 'rotation'),
      circle,
    };
  }

  /** Forgets what layers remember, after a jump in time or a change of template. */
  reset() {
    this.#memories = [];
  }

  draw(layers: PreparedLayer[], frame: Frame) {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    this.boxes = layers.map(() => null);
    this.changing = false;
    this.#drawRange(layers, 0, layers.length, frame);
    // The picture follows the sound's fades: black where it is silent, by the same curve.
    const shown = frame.shown ?? 1;
    if (shown < 1) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1 - Math.max(0, shown);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }
  }

  /** Draws layers `start` to `end` of the list, a group's with its layers in it. */
  #drawRange(layers: PreparedLayer[], start: number, end: number, frame: Frame) {
    for (let index = start; index < end;) {
      const inside = layers[index].type === 'group' ? Math.max(0, Math.min(layers[index].size, end - index - 1)) : 0;
      this.#drawLayer(layers, index, inside, frame);
      index += 1 + inside;
    }
  }

  #drawLayer(layers: PreparedLayer[], index: number, inside: number, frame: Frame) {
    if (!this.profile) return this.#drawLayerNow(layers, index, inside, frame);
    this.#finish();
    const start = performance.now();
    this.#drawLayerNow(layers, index, inside, frame);
    this.#finish();
    const layer = layers[index];
    const params = layer.resolve(frame.music, frame.text);
    const styled = STYLES.filter((key) => params[key] === true);
    const name = `${index} ${layer.type}${styled.length ? ` + ${styled.join(', ')}` : ''}`;
    this.profile.set(name, (this.profile.get(name) ?? 0) + performance.now() - start);
  }

  #drawLayerNow(layers: PreparedLayer[], index: number, inside: number, frame: Frame) {
    const layer = layers[index];
    this.#index = index;
    const params = layer.resolve(frame.music, frame.text);
    if (params.visible === false) return;
    const appear = this.#appearance(params, frame);
    const opacity = num(params, 'opacity') * appear;
    if (opacity <= 0) return;
    const memory = (this.#memories[index] ??= {});
    // A group's layers are drawn first, on a canvas of their own, which is then laid on the picture as one layer.
    const group = layer.type === 'group' ? this.#drawGroup(layers, index + 1, index + 1 + inside, frame) : null;
    this.#index = index;
    // Linear burn, which the canvas has not: the layer is drawn on its own, then burnt in.
    const burn = str(params, 'blend') === 'linear burn';
    // A layer with a style (a shadow, a stroke, a glow) is drawn on its own too, the style made from its shape.
    const styled = !LAYER_TYPES[layer.type]?.effect && STYLES.some((key) => params[key] === true);
    const alone = burn || styled;
    const [beneath, onto] = [this.#surface, this.#ctx];
    if (alone) this.#ctx = this.#layerCanvas();
    const into = this.#ctx;
    into.save();
    // A layer drawn on its own is drawn whole, and mixed in at its opacity after.
    into.globalAlpha = alone ? 1 : Math.min(1, opacity);
    into.globalCompositeOperation = alone ? 'source-over' : BLENDS[str(params, 'blend')] ?? 'source-over';
    switch (layer.type) {
      case 'group': into.drawImage(group!, 0, 0); break;
      case 'solid': this.#solid(params); break;
      case 'gradient': this.#gradient(params, frame); break;
      case 'particles': this.#particles(params, frame); break;
      case 'image': this.#image(params, frame); break;
      case 'video': this.#video(params, frame, index); break;
      case 'text': this.#text(params, frame, memory); break;
      case 'spectrum': this.#spectrum(params, frame, memory); break;
      case 'waveform': this.#waveform(params, frame); break;
      case 'shape': this.#shape(params); break;
      case 'glow': this.#glow(params, opacity); break;
      case 'split': this.#split(params); break;
      case 'glitch': this.#glitch(params, frame); break;
      case 'adjust': this.#filtered(`brightness(${Math.max(0, num(params, 'brightness'))}) contrast(${Math.max(0, num(params, 'contrast'))})`); break;
      case 'hue': this.#filtered(`hue-rotate(${num(params, 'hue')}deg) saturate(${Math.max(0, num(params, 'saturation'))}) brightness(${Math.max(0, 1 + num(params, 'lightness'))})`); break;
      case 'kaleidoscope': this.#kaleidoscope(params); break;
      case 'vignette': this.#vignette(params); break;
      case 'transform': this.#transform(params); break;
      case 'trails': this.#trails(params, frame, memory); break;
      case 'blur': this.#blurred((Math.max(0, num(params, 'radius')) / 100) * this.#unit); break;
      case 'lut': this.#lut(params, frame); break;
    }
    into.restore();
    if (!alone) return;
    this.#ctx = onto;
    if (styled) this.#style(params);
    if (burn) return this.#linearBurn(Math.min(1, opacity), beneath, onto);
    onto.save();
    onto.setTransform(1, 0, 0, 1, 0, 0);
    onto.globalAlpha = Math.min(1, opacity);
    onto.globalCompositeOperation = BLENDS[str(params, 'blend')] ?? 'source-over';
    onto.filter = 'none';
    onto.drawImage(this.#extraCanvas(6), 0, 0);
    onto.restore();
  }

  // -------------------------------------------------------------------------
  // Layer styles

  /**
   * Puts a layer's styles round what it drew on its own canvas (the 6th),
   * as an image editor does, all made from its shape: beneath it a drop
   * shadow, then an outer glow, then a stroke round the outside; over it,
   * inside its shape, an inner shadow, then an inner glow. Sizes are in
   * percent of the picture's short side, as everywhere.
   */
  #style(params: ResolvedParams) {
    const { width, height } = this.#canvas;
    const content = this.#extraCanvas(6);
    const out = this.#extraCanvas(9);
    const o = out.getContext('2d')!;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.globalAlpha = 1;
    o.globalCompositeOperation = 'source-over';
    o.filter = 'none';
    o.clearRect(0, 0, width, height);
    const px = (key: string) => (Math.max(0, num(params, key)) / 100) * this.#unit;
    const amount = (key: string) => Math.min(1, Math.max(0, num(params, key)));
    /** Draws a shape onto the result, blurred so that `soft` is about how far it fades out. */
    const lay = (shape: OffscreenCanvas, alpha: number, soft: number, dx = 0, dy = 0) => {
      o.globalAlpha = alpha;
      o.filter = soft > 0 ? `blur(${soft / 2}px)` : 'none';
      o.drawImage(shape, dx, dy);
      o.filter = 'none';
      o.globalAlpha = 1;
    };
    if (params.dropShadow === true) {
      const shape = this.#silhouette(content, col(params, 'dropColour'));
      // The angle is where the light comes from, as in an image editor: the shadow falls the other way.
      const angle = (num(params, 'dropAngle') * Math.PI) / 180;
      const distance = px('dropDistance');
      if (shape) lay(shape, amount('dropOpacity'), px('dropSize'), -Math.cos(angle) * distance, Math.sin(angle) * distance);
    }
    if (params.outerGlow === true) {
      const shape = this.#silhouette(content, col(params, 'glowColour'));
      // Spread makes that much of the glow's size solid before it fades.
      const size = px('glowSize');
      const spread = amount('glowSpread');
      if (shape) lay(this.#dilate(shape, size * spread), amount('glowOpacity'), size * (1 - spread));
    }
    if (params.stroke === true) {
      const shape = this.#silhouette(content, col(params, 'strokeColour'));
      if (shape) lay(this.#dilate(shape, px('strokeWidth')), amount('strokeOpacity'), 0);
    }
    o.drawImage(content, 0, 0);
    if (params.innerShadow === true) {
      const angle = (num(params, 'innerShadowAngle') * Math.PI) / 180;
      const distance = px('innerShadowDistance');
      this.#inner(o, content, col(params, 'innerShadowColour'), amount('innerShadowOpacity'), px('innerShadowSize'), 0, -Math.cos(angle) * distance, Math.sin(angle) * distance);
    }
    if (params.innerGlow === true) {
      // Choke makes that much of the glow's size solid before it fades, as spread does outside.
      const size = px('innerGlowSize');
      const choke = amount('innerGlowChoke');
      this.#inner(o, content, col(params, 'innerGlowColour'), amount('innerGlowOpacity'), size * (1 - choke), size * choke, 0, 0);
    }
    // Back where the layer is taken from, to be mixed in as it would have been without a style.
    const c = content.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'copy';
    c.filter = 'none';
    c.drawImage(out, 0, 0);
    c.globalCompositeOperation = 'source-over';
  }

  /**
   * A style inside the shape on `content`, laid over it on `onto`: what is
   * outside the shape, in one colour, grown inwards by `grow`, moved, blurred
   * by `soft`, and cut to the shape. An inner shadow is moved; an inner glow
   * is not, and comes in from every edge.
   */
  #inner(onto: OffscreenCanvasRenderingContext2D, content: OffscreenCanvas, colour: Colour | null, alpha: number, soft: number, grow: number, dx: number, dy: number) {
    if (!colour || alpha <= 0) return;
    const { width, height } = this.#canvas;
    const outside = this.#extraCanvas(10);
    const s = outside.getContext('2d')!;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalAlpha = 1;
    s.filter = 'none';
    s.globalCompositeOperation = 'copy';
    s.fillStyle = hexOf(colour);
    s.fillRect(0, 0, width, height);
    s.globalCompositeOperation = 'destination-out';
    s.drawImage(content, 0, 0);
    s.globalCompositeOperation = 'source-over';
    const grown = this.#dilate(outside, grow);
    const cut = this.#extraCanvas(13);
    const c = cut.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.filter = 'none';
    // Past the picture's edges is not outside the shape: a shape running off the picture has no inner edge there.
    c.clearRect(0, 0, width, height);
    c.globalCompositeOperation = 'source-over';
    c.filter = soft > 0 ? `blur(${soft / 2}px)` : 'none';
    c.drawImage(grown, dx, dy);
    c.filter = 'none';
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(content, 0, 0);
    c.globalCompositeOperation = 'source-over';
    onto.globalAlpha = alpha;
    onto.drawImage(cut, 0, 0);
    onto.globalAlpha = 1;
  }

  /** The shape of what is on `source`, in one colour, on the 10th canvas; null for no colour. */
  #silhouette(source: OffscreenCanvas, colour: Colour | null): OffscreenCanvas | null {
    if (!colour) return null;
    const shape = this.#extraCanvas(10);
    const s = shape.getContext('2d')!;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalAlpha = 1;
    s.filter = 'none';
    s.globalCompositeOperation = 'copy';
    s.drawImage(source, 0, 0);
    s.globalCompositeOperation = 'source-in';
    s.fillStyle = hexOf(colour);
    s.fillRect(0, 0, s.canvas.width, s.canvas.height);
    s.globalCompositeOperation = 'source-over';
    return shape;
  }

  /**
   * A shape grown by `radius` pixels all round. A canvas cannot do it in one
   * go, so the shape is moved along four directions, across and down, then
   * the two diagonals, and laid over itself each time; that grows it into an
   * octagon, near enough to a circle. Each direction takes doublings (1, 2,
   * 4… pixels), so a thick stroke costs a few draws more than a thin one.
   */
  #dilate(source: OffscreenCanvas, radius: number): OffscreenCanvas {
    if (radius < 0.5) return source;
    // A square of half side a and a diamond reaching b, with a + b = radius along the sides and along the diagonals.
    const a = radius * (Math.SQRT2 - 1);
    const half = (radius - a) / 2;
    const buffers = [this.#extraCanvas(11), this.#extraCanvas(12)];
    let current = source;
    let n = 0;
    const onto = (from: OffscreenCanvas, dx: number, dy: number, first: boolean) => {
      const target = buffers[n++ % 2];
      const t = target.getContext('2d')!;
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.globalAlpha = 1;
      t.filter = 'none';
      t.globalCompositeOperation = 'copy';
      t.drawImage(from, first ? dx : 0, first ? dy : 0);
      if (!first) {
        t.globalCompositeOperation = 'source-over';
        t.drawImage(from, dx, dy);
      }
      return target;
    };
    for (const [ux, uy, reach] of [[1, 0, a], [0, 1, a], [1, 1, half], [1, -1, half]]) {
      if (reach < 0.25) continue;
      // Every move from -reach to reach along (ux, uy): moved back to the start, then covered forwards in doublings.
      current = onto(current, -reach * ux, -reach * uy, true);
      for (let covered = 0; covered < reach * 2;) {
        const step = Math.min(covered + 1, reach * 2 - covered);
        current = onto(current, step * ux, step * uy, false);
        covered += step;
      }
    }
    return current;
  }

  /** How deep in groups the drawing is; each depth has its own canvas. */
  #depth = 0;
  #groupCanvases: OffscreenCanvas[] = [];

  /**
   * Draws a group's layers on a clear canvas of their own and gives it. While
   * they are drawn, that canvas is the picture: effects in the group change
   * the group's layers beneath them, and nothing outside it.
   */
  #drawGroup(layers: PreparedLayer[], start: number, end: number, frame: Frame): OffscreenCanvas {
    const { width, height } = this.#canvas;
    const depth = this.#depth++;
    let canvas = this.#groupCanvases[depth];
    if (!canvas || canvas.width !== width || canvas.height !== height) canvas = this.#groupCanvases[depth] = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, width, height);
    const [surface, before] = [this.#surface, this.#ctx];
    this.#surface = canvas;
    this.#ctx = ctx;
    this.#drawRange(layers, start, end, frame);
    this.#surface = surface;
    this.#ctx = before;
    this.#depth--;
    return canvas;
  }

  /** How far a layer is shown at this moment: its time on screen, and its fades in and out. */
  #appearance(params: ResolvedParams, frame: Frame): number {
    const from = num(params, 'from');
    const until = frame.length - num(params, 'until');
    if (frame.seconds < from || frame.seconds > until) return 0;
    const fadeIn = num(params, 'fadeIn');
    const fadeOut = num(params, 'fadeOut');
    let amount = 1;
    if (fadeIn > 0) amount = Math.min(amount, (frame.seconds - from) / fadeIn);
    if (fadeOut > 0) amount = Math.min(amount, (until - frame.seconds) / fadeOut);
    return Math.max(0, Math.min(1, amount));
  }

  /** Moves the drawing to the layer's position, rotation and scale, around its anchor point. */
  #place(params: ResolvedParams) {
    const { width, height } = this.#canvas;
    const x = (num(params, 'x') / 100) * width;
    const y = (num(params, 'y') / 100) * height;
    this.#ctx.translate(x, y);
    this.#ctx.rotate((num(params, 'rotation') * Math.PI) / 180);
    const scale = num(params, 'scale') / 100;
    this.#ctx.scale(scale, scale);
  }

  /** The nth extra scratch canvas: the size of the picture, unless another is asked for. */
  #extraCanvas(n: number, width = this.#canvas.width, height = this.#canvas.height): OffscreenCanvas {
    const canvas = this.#extra[n];
    if (!canvas || canvas.width !== width || canvas.height !== height) this.#extra[n] = new OffscreenCanvas(width, height);
    return this.#extra[n];
  }

  /** A copy of the picture so far, on a scratch canvas, to draw back changed. */
  #copyOfPicture(): OffscreenCanvas {
    const copy = this.#scratchCanvas();
    const s = copy.getContext('2d')!;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'copy';
    s.globalAlpha = 1;
    s.filter = 'none';
    s.drawImage(this.#surface, 0, 0);
    return copy;
  }

  #scratchCanvas(): OffscreenCanvas {
    const { width, height } = this.#canvas;
    if (!this.#scratch || this.#scratch.width !== width || this.#scratch.height !== height) this.#scratch = new OffscreenCanvas(width, height);
    return this.#scratch;
  }

  // -------------------------------------------------------------------------
  // Layers

  #solid(params: ResolvedParams) {
    const c = col(params, 'colour');
    if (!c) return;
    const { width, height } = this.#canvas;
    this.#ctx.fillStyle = hexOf(c);
    this.#ctx.fillRect(0, 0, width, height);
  }

  /**
   * Edges darkened towards a colour, round the layer's position: clear out to
   * `size` of the way to the corners, then reaching the colour over `softness`
   * of the rest. Fitting the picture, it is an oval of the picture's shape;
   * round, a circle whatever the shape.
   */
  #vignette(params: ResolvedParams) {
    const c = col(params, 'colour');
    if (!c) return;
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    const cx = (num(params, 'x') / 100) * width;
    const cy = (num(params, 'y') / 100) * height;
    // Reaching the corners from the middle: half the sides times √2 for an oval, half the diagonal for a circle.
    const round = str(params, 'form') === 'round';
    const rx = round ? Math.hypot(width, height) / 2 : (width / 2) * Math.SQRT2;
    const ry = round ? rx : (height / 2) * Math.SQRT2;
    const inner = Math.min(1, Math.max(0, num(params, 'size') / 100));
    const outer = inner + (1 - inner) * Math.min(1, Math.max(0, num(params, 'softness')));
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    // Eased rather than straight, so that the clear middle gives way without a visible edge.
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const at = outer > inner ? inner + (outer - inner) * t : inner;
      gradient.addColorStop(Math.min(1, at), hexOf({ ...c, a: c.a * t * t * (3 - 2 * t) }));
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(rx, ry);
    ctx.fillStyle = gradient;
    ctx.fillRect(-cx / rx, -cy / ry, width / rx, height / ry);
    ctx.restore();
  }

  #gradient(params: ResolvedParams, frame: Frame) {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    const shift = num(params, 'hueShift') * frame.seconds;
    const colours = ['colour1', 'colour2', 'colour3'].map((key) => col(params, key)).filter((c): c is Colour => c !== null)
      .map((c) => (shift ? turnHue(c, shift) : c));
    if (colours.length === 0) return;
    const angle = ((num(params, 'angle') + num(params, 'drift') * frame.seconds) * Math.PI) / 180;
    const cx = (num(params, 'x') / 100) * width;
    const cy = (num(params, 'y') / 100) * height;
    const reach = (Math.hypot(width, height) / 2) * (num(params, 'scale') / 100);
    let gradient: CanvasGradient;
    const kind = str(params, 'kind');
    if (kind === 'radial') gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
    else if (kind === 'conic') gradient = ctx.createConicGradient(angle, cx, cy);
    else gradient = ctx.createLinearGradient(cx - Math.cos(angle) * reach, cy - Math.sin(angle) * reach, cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach);
    const stops = kind === 'conic' ? [...colours, colours[0]] : colours;
    stops.forEach((c, i) => gradient.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), hexOf(c)));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }

  /** A particle's picture: a shape in a colour, drawn once and then stamped. */
  #sprite(shape: string, colour: Colour): OffscreenCanvas {
    const key = `${shape}|${hexOf(colour)}`;
    let sprite = this.#sprites.get(key);
    if (sprite) return sprite;
    const size = 64;
    sprite = new OffscreenCanvas(size, size);
    const c = sprite.getContext('2d')!;
    const hex = hexOf({ ...colour, a: 1 });
    const middle = size / 2;
    if (shape === 'soft dot') {
      const glow = c.createRadialGradient(middle, middle, 0, middle, middle, middle);
      glow.addColorStop(0, hex);
      glow.addColorStop(0.35, hexOf({ ...colour, a: 0.6 }));
      glow.addColorStop(1, hexOf({ ...colour, a: 0 }));
      c.fillStyle = glow;
      c.fillRect(0, 0, size, size);
    } else if (shape === 'star' || shape === 'sparkle') {
      c.fillStyle = hex;
      c.strokeStyle = hex;
      c.beginPath();
      const points = shape === 'star' ? 5 : 4;
      for (let i = 0; i < points * 2; i++) {
        const r = i % 2 === 0 ? middle : middle * (shape === 'star' ? 0.42 : 0.12);
        const a = (i * Math.PI) / points - Math.PI / 2;
        c.lineTo(middle + Math.cos(a) * r, middle + Math.sin(a) * r);
      }
      c.closePath();
      c.fill();
    } else {
      c.fillStyle = hex;
      c.beginPath();
      c.arc(middle, middle, middle, 0, Math.PI * 2);
      c.fill();
    }
    this.#sprites.set(key, sprite);
    return sprite;
  }

  #particles(params: ResolvedParams, frame: Frame) {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    const colours = ['colour1', 'colour2', 'colour3'].map((key) => col(params, key)).filter((c): c is Colour => c !== null);
    if (colours.length === 0) return;
    const shape = str(params, 'shape');
    const count = Math.max(0, Math.min(5000, Math.round(num(params, 'count'))));
    const burst = Math.max(0, Math.min(1000, Math.round(num(params, 'burst'))));
    const lifetime = Math.max(0.1, num(params, 'lifetime'));
    const speed = (num(params, 'speed') / 100) * this.#unit;
    const direction = (num(params, 'direction') * Math.PI) / 180;
    const spread = (num(params, 'spread') * Math.PI) / 180;
    const turbulence = (num(params, 'turbulence') / 100) * this.#unit * 0.2;
    const twinkle = num(params, 'twinkle');
    const depth = num(params, 'twinkleDepth');
    const sizeLow = (num(params, 'sizeLow') / 100) * this.#unit;
    const sizeHigh = (num(params, 'sizeHigh') / 100) * this.#unit;
    const area = str(params, 'area');
    const opacity = ctx.globalAlpha;
    const t = frame.seconds;

    const stamp = (seed: number, age: number, life: number, alpha: number) => {
      const r = (k: number) => hash(seed * 16 + k);
      let x: number;
      let y: number;
      switch (area) {
        case 'bottom': x = r(1) * width; y = height * (1 + r(2) * 0.05); break;
        case 'top': x = r(1) * width; y = -height * r(2) * 0.05; break;
        case 'left': x = -width * r(1) * 0.05; y = r(2) * height; break;
        case 'right': x = width * (1 + r(1) * 0.05); y = r(2) * height; break;
        case 'centre': x = width / 2 + (r(1) - 0.5) * width * 0.05; y = height / 2 + (r(2) - 0.5) * height * 0.05; break;
        default: x = r(1) * width; y = r(2) * height;
      }
      const heading = direction + (r(3) - 0.5) * spread;
      const pace = speed * (0.5 + r(4));
      x += Math.cos(heading) * pace * age + (noise(seed + age * 0.7) - 0.5) * turbulence;
      y += Math.sin(heading) * pace * age + (noise(seed * 3 + age * 0.7) - 0.5) * turbulence;
      // Fade in and out over its life, and twinkle while it lives.
      const life01 = age / life;
      let a = Math.sin(Math.PI * Math.min(1, Math.max(0, life01)));
      if (twinkle > 0 && depth > 0) a *= 1 - depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * (twinkle * age + r(5))));
      a *= alpha;
      if (a <= 0.004) return;
      const size = sizeLow + (sizeHigh - sizeLow) * r(6);
      const sprite = this.#sprite(shape, colours[Math.floor(r(7) * colours.length)]);
      ctx.globalAlpha = opacity * a;
      ctx.drawImage(sprite, x - size, y - size, size * 2, size * 2);
    };

    for (let i = 0; i < count; i++) {
      // Each particle lives over and over, offset from the others; each life starts somewhere new.
      const cycle = t / lifetime + hash(i);
      const life = Math.floor(cycle);
      stamp(i * 7919 + life * 104729, (cycle - life) * lifetime, lifetime, 1);
    }
    // A burst on the beat: extra particles that flash with the kick and fade with it.
    const beat = typeof frame.music.beat === 'number' ? frame.music.beat : 0;
    const beats = typeof frame.music.beats === 'number' ? Math.floor(frame.music.beats) : 0;
    if (burst > 0 && beat > 0.01) {
      for (let i = 0; i < burst; i++) stamp(beats * 7907 + i * 31 + 1_000_003, lifetime * 0.5, lifetime, beat);
    }
  }

  #image(params: ResolvedParams, frame: Frame) {
    const picture = frame.images.get(str(params, 'image'));
    if (!picture || !picture.width || !picture.height) return;
    this.#picture(params, picture, picture.width, picture.height);
  }

  #video(params: ResolvedParams, frame: Frame, index: number) {
    const source = str(params, 'video');
    if (!source || !frame.video) return;
    const picture = frame.video(source, index, clipTimingOf(params, frame));
    if (!picture || !picture.width || !picture.height) return;
    this.#picture(params, picture.image, picture.width, picture.height);
  }

  /** Draws a picture or a video frame as an image or video layer's settings say: fitted, rounded, tinted. */
  #picture(params: ResolvedParams, picture: CanvasImageSource, pictureWidth: number, pictureHeight: number) {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    let w = (num(params, 'width') / 100) * width;
    let h = (num(params, 'height') / 100) * height;
    const fit = str(params, 'fit');
    const ratio = pictureWidth / pictureHeight;
    if (fit === 'natural') [w, h] = [pictureWidth, pictureHeight];
    else if (fit === 'contain') [w, h] = w / h > ratio ? [h * ratio, h] : [w, w / ratio];
    else if (fit === 'cover') [w, h] = w / h > ratio ? [w, w / ratio] : [h * ratio, h];
    this.#place(params);
    const [left, top] = anchored(str(params, 'anchor'), 0, 0, w, h);
    this.#record(params, left, top, w, h);

    // Drawn on its own first, so that tint and rounding touch the picture only.
    const scratch = this.#scratchCanvas();
    const s = scratch.getContext('2d')!;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.clearRect(0, 0, scratch.width, scratch.height);
    const pw = Math.min(scratch.width, Math.ceil(w));
    const ph = Math.min(scratch.height, Math.ceil(h));
    s.filter = `brightness(${Math.max(0, num(params, 'brightness'))}) saturate(${Math.max(0, num(params, 'saturation'))})`;
    s.save();
    const rounding = (num(params, 'rounding') / 100) * Math.min(pw, ph);
    if (rounding > 0) {
      s.beginPath();
      s.roundRect(0, 0, pw, ph, rounding);
      s.clip();
    }
    s.drawImage(picture, 0, 0, pw, ph);
    s.restore();
    s.filter = 'none';
    const key = str(params, 'key');
    if (key === 'colour' || key === 'dark') keyOut(s, pw, ph, key, col(params, 'keyColour'), num(params, 'keyTolerance'), num(params, 'keySoftness'));
    const tint = col(params, 'tint');
    const tintAmount = num(params, 'tintAmount');
    if (tint && tintAmount > 0) {
      s.globalCompositeOperation = 'source-atop';
      s.globalAlpha = tintAmount;
      s.fillStyle = hexOf(tint);
      s.fillRect(0, 0, pw, ph);
      s.globalAlpha = 1;
    }
    const shadow = col(params, 'shadowColour');
    const blur = (num(params, 'shadowBlur') / 100) * this.#unit;
    if (shadow && blur > 0) {
      ctx.shadowColor = hexOf(shadow);
      ctx.shadowBlur = blur;
    }
    ctx.drawImage(scratch, 0, 0, pw, ph, left, top, w, h);
  }

  #text(params: ResolvedParams, frame: Frame, memory: Memory) {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    let text = str(params, 'text');
    const kase = str(params, 'case');
    if (kase === 'upper') text = text.toUpperCase();
    if (kase === 'lower') text = text.toLowerCase();

    // A change of text plays out over a moment: the old leaving, the new arriving.
    // It moves on with the time on the clock rather than the time in the mix,
    // so that a name typed in while the music is paused still fades in.
    if (memory.shown === undefined) memory.shown = text;
    if (text !== memory.shown) {
      memory.previous = memory.shown;
      memory.shown = text;
      memory.changing = 0;
    }
    const takes = num(params, 'changeSeconds');
    const change = str(params, 'change');
    if (memory.changing !== undefined) memory.changing = takes > 0 ? Math.min(1, memory.changing + (frame.clockDt ?? frame.dt) / takes) : 1;
    if (memory.changing !== undefined && memory.changing < 1) this.changing = true;
    const progress = memory.changing === undefined || change === 'cut' ? 1 : memory.changing;

    const size = (num(params, 'size') / 100) * this.#unit;
    ctx.font = `${Math.round(num(params, 'weight'))} ${size}px ${fontStack(str(params, 'font'))}`;
    ctx.letterSpacing = `${(num(params, 'letterSpacing') / 100) * size}px`;
    ctx.textBaseline = 'alphabetic';
    const align = str(params, 'align');
    ctx.textAlign = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
    this.#place(params);

    const lines = (value: string): string[] => {
      const limit = (num(params, 'width') / 100) * width;
      const out: string[] = [];
      for (const paragraph of value.split('\n')) {
        let line = '';
        for (const word of paragraph.split(/\s+/)) {
          const tried = line ? `${line} ${word}` : word;
          if (line && ctx.measureText(tried).width > limit) {
            out.push(line);
            line = word;
          } else line = tried;
        }
        out.push(line);
      }
      return out;
    };

    const block = (value: string, alpha: number, offset: number, visible = value.length) => {
      if (alpha <= 0) return;
      if (params.hideWhenEmpty && !value.trim()) return;
      const rows = lines(value);
      const lineHeight = (size * num(params, 'lineHeight')) / 100;
      const blockWidth = Math.max(...rows.map((row) => ctx.measureText(row).width), 0);
      const blockHeight = lineHeight * rows.length;
      const [left, top] = anchored(str(params, 'anchor'), 0, 0, blockWidth, blockHeight);
      this.#record(params, left, top, blockWidth, blockHeight);
      const x = ctx.textAlign === 'left' ? left : ctx.textAlign === 'right' ? left + blockWidth : left + blockWidth / 2;
      const opacity = ctx.globalAlpha;
      ctx.globalAlpha = opacity * alpha;
      const box = col(params, 'boxColour');
      if (box) {
        const pad = (num(params, 'boxPadding') / 100) * this.#unit;
        ctx.fillStyle = hexOf(box);
        ctx.beginPath();
        ctx.roundRect(left - pad, top + offset - pad, blockWidth + pad * 2, blockHeight + pad * 2, pad * 0.6);
        ctx.fill();
      }
      const shadow = col(params, 'shadowColour');
      const blur = (num(params, 'shadowBlur') / 100) * this.#unit;
      ctx.shadowColor = shadow && blur > 0 ? hexOf(shadow) : 'transparent';
      ctx.shadowBlur = blur;
      const outline = (num(params, 'outlineWidth') / 100) * this.#unit;
      const outlineColour = col(params, 'outlineColour');
      const fill = col(params, 'colour');
      let left_ = visible;
      rows.forEach((row, i) => {
        const shownRow = row.slice(0, Math.max(0, left_));
        left_ -= row.length + 1;
        const y = top + offset + lineHeight * i + size * 0.8 + (lineHeight - size) / 2;
        if (outline > 0 && outlineColour) {
          ctx.lineWidth = outline;
          ctx.lineJoin = 'round';
          ctx.strokeStyle = hexOf(outlineColour);
          ctx.strokeText(shownRow, x, y);
        }
        if (fill) {
          ctx.fillStyle = hexOf(fill);
          ctx.fillText(shownRow, x, y);
        }
      });
      ctx.globalAlpha = opacity;
    };

    const previous = memory.previous ?? '';
    if (progress >= 1) block(text, 1, 0);
    else if (change === 'fade') {
      block(previous, 1 - progress, 0);
      block(text, progress, 0);
    } else if (change === 'slide') {
      const distance = size * 1.2;
      block(previous, 1 - progress, -distance * progress);
      block(text, progress, distance * (1 - progress));
    } else if (change === 'typewriter') {
      block(text, 1, 0, Math.round(text.length * progress));
    } else block(text, 1, 0);
  }

  #spectrum(params: ResolvedParams, frame: Frame, memory: Memory) {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    const bars = Math.max(1, Math.min(512, Math.round(num(params, 'bars'))));
    if (!memory.bars || memory.bars.length !== bars) {
      memory.bars = new Float32Array(bars);
      memory.peaks = new Float32Array(bars);
    }
    const low = Math.max(LOWEST_HZ, num(params, 'lowHz'));
    const high = Math.min(HIGHEST_HZ, Math.max(low * 1.5, num(params, 'highHz')));
    const bandAt = (hz: number) => (Math.log(hz / LOWEST_HZ) / Math.log(HIGHEST_HZ / LOWEST_HZ)) * BAND_COUNT - 0.5;
    const rise = num(params, 'rise');
    const fall = num(params, 'fall');
    const follow = (seconds: number) => (seconds > 0 ? 1 - Math.exp(-frame.dt / seconds) : 1);
    for (let i = 0; i < bars; i++) {
      const hz = low * Math.pow(high / low, (i + 0.5) / bars);
      const position = Math.max(0, Math.min(BAND_COUNT - 1, bandAt(hz)));
      const b = Math.floor(position);
      const next = Math.min(BAND_COUNT - 1, b + 1);
      const target = frame.spectrum[b] + (frame.spectrum[next] - frame.spectrum[b]) * (position - b);
      const now = memory.bars[i];
      memory.bars[i] = now + (target - now) * follow(target > now ? rise : fall);
      memory.peaks![i] = Math.max(memory.bars[i], memory.peaks![i] - frame.dt * 0.6);
    }

    const w = (num(params, 'width') / 100) * width;
    const h = (num(params, 'height') / 100) * height;
    const lowColour = col(params, 'colourLow') ?? fromHsl(150, 0.7, 0.55);
    const highColour = col(params, 'colourHigh') ?? lowColour;
    const colouring = str(params, 'colouring');
    const colourOf = (i: number, value: number) =>
      colouring === 'one colour' ? lowColour : mixColours(lowColour, highColour, colouring === 'by height' ? value : i / Math.max(1, bars - 1));
    const gap = Math.max(0, Math.min(0.9, num(params, 'gap') / 100));
    const mirrored = params.mirrored === true;
    const rounded = params.rounded === true;
    this.#place(params);

    if (str(params, 'form') === 'circle') {
      const radius = (num(params, 'radius') / 100) * this.#unit;
      // Round, the bars' length is a size like the radius, so that the ring keeps its proportions in any shape of picture.
      const reach = (num(params, 'height') / 100) * this.#unit;
      this.#record(params, -radius, -radius, radius * 2, radius * 2, true);
      const step = (Math.PI * 2) / bars;
      ctx.lineCap = rounded ? 'round' : 'butt';
      for (let i = 0; i < bars; i++) {
        const value = memory.bars[i];
        const angle = i * step - Math.PI / 2;
        const length = Math.max(1, value * reach);
        ctx.strokeStyle = hexOf(colourOf(i, value));
        ctx.lineWidth = Math.max(1, radius * step * (1 - gap));
        ctx.beginPath();
        const inner = mirrored ? radius - length / 2 : radius;
        ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
        ctx.lineTo(Math.cos(angle) * (inner + length), Math.sin(angle) * (inner + length));
        ctx.stroke();
      }
      return;
    }
    const [left, top] = anchored(str(params, 'anchor'), 0, 0, w, h);
    this.#record(params, left, top, w, h);
    const slot = w / bars;
    const barWidth = Math.max(1, slot * (1 - gap));
    const base = mirrored ? top + h / 2 : top + h;
    for (let i = 0; i < bars; i++) {
      const value = memory.bars[i];
      const length = Math.max(1, value * (mirrored ? h / 2 : h));
      const x = left + i * slot + (slot - barWidth) / 2;
      ctx.fillStyle = hexOf(colourOf(i, value));
      ctx.beginPath();
      if (mirrored) ctx.roundRect(x, base - length, barWidth, length * 2, rounded ? barWidth / 2 : 0);
      else ctx.roundRect(x, base - length, barWidth, length, rounded ? [barWidth / 2, barWidth / 2, 0, 0] : 0);
      ctx.fill();
      if (params.peaks) {
        const peak = memory.peaks![i] * (mirrored ? h / 2 : h);
        ctx.fillRect(x, base - peak - Math.max(2, h * 0.012), barWidth, Math.max(2, h * 0.012));
      }
    }
  }

  #waveform(params: ResolvedParams, frame: Frame) {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    const w = (num(params, 'width') / 100) * width;
    const h = (num(params, 'height') / 100) * height;
    const points = Math.max(8, Math.min(1024, Math.round(w / 3)));
    const levels = frame.levelHistory(Math.max(0.05, num(params, 'seconds')), points);
    const colour = col(params, 'colour');
    if (!colour) return;
    const style = str(params, 'style');
    this.#place(params);
    ctx.strokeStyle = hexOf(colour);
    ctx.fillStyle = hexOf(colour);
    ctx.lineWidth = Math.max(1, (num(params, 'lineWidth') / 100) * this.#unit);
    ctx.lineJoin = 'round';

    if (str(params, 'form') === 'circle') {
      const radius = (num(params, 'radius') / 100) * this.#unit;
      const reach = (num(params, 'height') / 100) * this.#unit;
      this.#record(params, -radius, -radius, radius * 2, radius * 2, true);
      ctx.beginPath();
      for (let p = 0; p <= points; p++) {
        const value = levels[p % points];
        const angle = (p / points) * Math.PI * 2 - Math.PI / 2;
        const r = radius + value * reach * 0.5;
        if (p === 0) ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
        else ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
      }
      ctx.closePath();
      if (style === 'line') ctx.stroke();
      else ctx.fill();
      return;
    }
    const [left, top] = anchored(str(params, 'anchor'), 0, 0, w, h);
    this.#record(params, left, top, w, h);
    const middle = top + h / 2;
    const xOf = (p: number) => left + (p / (points - 1)) * w;
    ctx.beginPath();
    if (style === 'line') {
      levels.forEach((value, p) => (p === 0 ? ctx.moveTo(xOf(p), top + h - value * h) : ctx.lineTo(xOf(p), top + h - value * h)));
      ctx.stroke();
    } else if (style === 'filled') {
      ctx.moveTo(left, top + h);
      levels.forEach((value, p) => ctx.lineTo(xOf(p), top + h - value * h));
      ctx.lineTo(left + w, top + h);
      ctx.closePath();
      ctx.fill();
    } else {
      levels.forEach((value, p) => ctx.lineTo(xOf(p), middle - (value * h) / 2));
      for (let p = points - 1; p >= 0; p--) ctx.lineTo(xOf(p), middle + (levels[p] * h) / 2);
      ctx.closePath();
      ctx.fill();
    }
  }

  /**
   * A shape, filled and outlined. Only `amount` of it may be drawn: its fill
   * cut off across, down or round from where `reveal` says, its outline
   * whole; "keeping its shape", its fill the shape itself made that much as
   * long, so that a rounded bar keeps its rounded end; or "along the
   * outline", its outline traced part of the way round and its fill whole.
   * What is not drawn can be shown in another colour, the empty part of a
   * progress bar.
   */
  #shape(params: ResolvedParams) {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    const w = Math.max(0, (num(params, 'width') / 100) * width);
    const h = params.square === true ? w : Math.max(0, (num(params, 'height') / 100) * height);
    this.#place(params);
    const [left, top] = anchored(str(params, 'anchor'), 0, 0, w, h);
    this.#record(params, left, top, w, h);
    if (w <= 0 || h <= 0) return;
    ctx.translate(left + w / 2, top + h / 2);

    const options = {
      sides: num(params, 'sides'),
      inner: num(params, 'inner') / 100,
      thickness: num(params, 'thickness') / 100,
      rounding: num(params, 'rounding') / 100,
    };
    const contours = shapeOutline(str(params, 'shape'), w, h, options);
    const pathOf = (contour: number[]) => {
      const path = new Path2D();
      for (let i = 0; i < contour.length; i += 2) (i === 0 ? path.moveTo : path.lineTo).call(path, contour[i], contour[i + 1]);
      path.closePath();
      return path;
    };
    const whole = new Path2D();
    for (const contour of contours) whole.addPath(pathOf(contour));

    const fillColour = col(params, 'fillColour');
    let fill: string | CanvasGradient | null = fillColour ? hexOf(fillColour) : null;
    const kind = str(params, 'fill');
    const second = col(params, 'fillColour2');
    if (fillColour && second && kind !== 'one colour') {
      let gradient: CanvasGradient;
      if (kind === 'radial gradient') gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) / 2);
      else {
        // 90° runs left to right, as the gradient layer's does; the ends are where the box's corners reach along that line.
        const angle = (num(params, 'gradientAngle') * Math.PI) / 180 - Math.PI / 2;
        const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
        const reach = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
        gradient = ctx.createLinearGradient(-dx * reach, -dy * reach, dx * reach, dy * reach);
      }
      gradient.addColorStop(0, hexOf(fillColour));
      gradient.addColorStop(1, hexOf(second));
      fill = gradient;
    }
    const outlineColour = col(params, 'outlineColour');
    const line = (num(params, 'outlineWidth') / 100) * this.#unit;
    const outline = outlineColour && line > 0 ? hexOf(outlineColour) : null;
    const rest = col(params, 'restColour');
    const amount = Math.max(0, Math.min(1, num(params, 'amount')));
    const reveal = str(params, 'reveal');
    ctx.lineWidth = line;
    ctx.lineJoin = num(params, 'rounding') > 0 ? 'round' : 'miter';

    if (reveal === 'along the outline') {
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill(whole, 'evenodd');
      }
      if (!outline || line <= 0) return;
      // Each contour traced from its start, the same fraction of its own length; its dashes are given over to that.
      ctx.lineCap = 'butt';
      for (const contour of contours) {
        const path = pathOf(contour);
        const length = lengthOf(contour);
        if (rest && amount < 1) {
          ctx.strokeStyle = hexOf(rest);
          ctx.setLineDash([0, length * amount, length * (1 - amount), length]);
          ctx.stroke(path);
        }
        if (amount > 0) {
          ctx.strokeStyle = outline;
          ctx.setLineDash(amount < 1 ? [length * amount, length * 2] : []);
          ctx.stroke(path);
        }
      }
      ctx.setLineDash([]);
      return;
    }

    if (reveal.endsWith('keeping its shape')) {
      // Beneath, the whole shape in the colour of what is not drawn; over it, the shape as long as is drawn, from its one edge.
      if (rest && amount < 1) {
        ctx.fillStyle = hexOf(rest);
        ctx.fill(whole, 'evenodd');
      }
      if (fill && amount > 0) {
        const across = reveal.startsWith('left');
        const part = across
          ? shapeOutline(str(params, 'shape'), w * amount, h, options).map((c) => c.map((v, i) => (i % 2 === 0 ? v - (w * (1 - amount)) / 2 : v)))
          : shapeOutline(str(params, 'shape'), w, h * amount, options).map((c) => c.map((v, i) => (i % 2 === 1 ? v + (h * (1 - amount)) / 2 : v)));
        const path = new Path2D();
        for (const contour of part) path.addPath(pathOf(contour));
        ctx.fillStyle = fill;
        ctx.fill(path, 'evenodd');
      }
      this.#outline(params, whole, outline, line);
      return;
    }

    // The part drawn, as a region to cut the fill to: far larger than the shape, so that only its one edge cuts.
    const far = (w + h) * 2 + line * 4;
    const drawn = new Path2D();
    if (reveal === 'clockwise' || reveal === 'anticlockwise') {
      const start = (num(params, 'startAngle') * Math.PI) / 180 - Math.PI / 2;
      drawn.moveTo(0, 0);
      drawn.arc(0, 0, far, start, start + (reveal === 'clockwise' ? 1 : -1) * amount * Math.PI * 2, reveal === 'anticlockwise');
      drawn.closePath();
    } else if (reveal === 'right') drawn.rect(w / 2 - w * amount, -far, far, far * 2);
    else if (reveal === 'top') drawn.rect(-far, -far, far * 2, far - h / 2 + h * amount);
    else if (reveal === 'bottom') drawn.rect(-far, h / 2 - h * amount, far * 2, far);
    else if (reveal === 'the middle') drawn.rect((-w * amount) / 2, -far, w * amount, far * 2);
    else drawn.rect(-far, -far, far - w / 2 + w * amount, far * 2);
    const fillPart = (style: string | CanvasGradient, region: Path2D | null, rule: CanvasFillRule = 'nonzero') => {
      ctx.save();
      if (region) ctx.clip(region, rule);
      ctx.fillStyle = style;
      ctx.fill(whole, 'evenodd');
      ctx.restore();
    };
    if (rest && amount < 1) {
      // What is not drawn: everything but the part drawn, cut even-odd from a box larger still.
      const undrawn = new Path2D();
      undrawn.rect(-far * 2, -far * 2, far * 4, far * 4);
      if (amount > 0) undrawn.addPath(drawn);
      fillPart(hexOf(rest), undrawn, 'evenodd');
    }
    if (fill && amount > 0) fillPart(fill, amount < 1 ? drawn : null);
    this.#outline(params, whole, outline, line);
  }

  /** A shape's outline all the way round, solid, dashed or dotted. */
  #outline(params: ResolvedParams, path: Path2D, colour: string | null, line: number) {
    if (!colour || line <= 0) return;
    const ctx = this.#ctx;
    const style = str(params, 'outlineStyle');
    ctx.setLineDash(style === 'dashed' ? [line * 3, line * 2] : style === 'dotted' ? [0, line * 2] : []);
    ctx.lineCap = style === 'dotted' ? 'round' : 'butt';
    ctx.strokeStyle = colour;
    ctx.stroke(path);
    ctx.setLineDash([]);
  }

  /** Glow: the picture so far, blurred and added onto itself. */
  #glow(params: ResolvedParams, opacity: number) {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    // Only what is brighter than the threshold glows; blurred to the edges, as the Blur effect is.
    const threshold = num(params, 'threshold');
    const scratch = this.#extraCanvas(0);
    this.#blurInto(this.#copyOfPicture(), scratch, (num(params, 'radius') / 100) * this.#unit,
      `brightness(${Math.max(0, 1 - threshold) * 100 + 20}%) contrast(${100 + threshold * 300}%)`);
    const s = scratch.getContext('2d')!;
    const tint = col(params, 'tint');
    if (tint && hexOf(tint) !== '#ffffff') {
      s.globalCompositeOperation = 'multiply';
      s.fillStyle = hexOf(tint);
      s.fillRect(0, 0, width, height);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, opacity * num(params, 'strength'));
    ctx.drawImage(scratch, 0, 0);
  }

  // -------------------------------------------------------------------------
  // Effects that change the picture beneath them. Each is drawn back over it
  // with the layer's opacity and blend, so a lower opacity mixes in less.

  /**
   * Blurs `source` into `target` (of the same size) by `radius` pixels, after
   * any other `filter`. The canvas's blur takes what lies beyond the picture
   * to be transparent, which leaves the edges half blurred, fading to the
   * sharp picture beneath; so the picture is first extended past its edges by
   * stretching its outermost pixels outwards, blurred, and cut back.
   */
  #blurInto(source: OffscreenCanvas, target: OffscreenCanvas, radius: number, filter = '') {
    const { width, height } = this.#canvas;
    const t = target.getContext('2d')!;
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalCompositeOperation = 'copy';
    t.globalAlpha = 1;
    if (radius <= 0) {
      t.filter = filter || 'none';
      t.drawImage(source, 0, 0);
      t.filter = 'none';
      return;
    }
    const pad = Math.ceil(radius * 3);
    const wide = this.#extraCanvas(3, width + pad * 2, height + pad * 2);
    const w = wide.getContext('2d')!;
    w.setTransform(1, 0, 0, 1, 0, 0);
    w.globalCompositeOperation = 'copy';
    w.globalAlpha = 1;
    w.filter = 'none';
    w.drawImage(source, pad, pad);
    w.globalCompositeOperation = 'source-over';
    // The outermost row or column of pixels on each side, stretched across the margin; the corners, one pixel each.
    w.drawImage(source, 0, 0, width, 1, pad, 0, width, pad);
    w.drawImage(source, 0, height - 1, width, 1, pad, pad + height, width, pad);
    w.drawImage(source, 0, 0, 1, height, 0, pad, pad, height);
    w.drawImage(source, width - 1, 0, 1, height, pad + width, pad, pad, height);
    w.drawImage(source, 0, 0, 1, 1, 0, 0, pad, pad);
    w.drawImage(source, width - 1, 0, 1, 1, pad + width, 0, pad, pad);
    w.drawImage(source, 0, height - 1, 1, 1, 0, pad + height, pad, pad);
    w.drawImage(source, width - 1, height - 1, 1, 1, pad + width, pad + height, pad, pad);
    // Blurred whole, then cut: drawn cut, the canvas would cut first and blur after, beside nothing again.
    const blurred = this.#extraCanvas(4, width + pad * 2, height + pad * 2);
    const b = blurred.getContext('2d')!;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'copy';
    b.globalAlpha = 1;
    b.filter = `${filter} blur(${radius}px)`.trim();
    b.drawImage(wide, 0, 0);
    b.filter = 'none';
    t.filter = 'none';
    t.drawImage(blurred, pad, pad, width, height, 0, 0, width, height);
  }

  /** The picture beneath, blurred to the edges. */
  #blurred(radius: number) {
    const copy = this.#copyOfPicture();
    const result = this.#extraCanvas(0);
    this.#blurInto(copy, result, radius);
    this.#putBack(result);
  }

  /**
   * Lays an effect's result down. At the normal blend it takes the place of
   * the picture beneath, mixed in by the layer's opacity: what was beneath is
   * faded by as much as the result is added. Laid over it instead, the
   * picture beneath would show wherever the result is see-through, as it is
   * in a group: the spectrum a kaleidoscope was made from, under its pattern.
   * With any other blend, the result is blended with what is beneath.
   */
  #putBack(result: OffscreenCanvas) {
    const ctx = this.#ctx;
    if (ctx.globalCompositeOperation !== 'source-over') return void ctx.drawImage(result, 0, 0);
    const { width, height } = this.#canvas;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(result, 0, 0);
    ctx.restore();
  }

  /** The graphics card's way of applying LUTs; null where WebGL 2 is not to be had, and the processor does it. */
  #lutGl: LutGl | null | undefined;

  /** The picture beneath, through a colour lookup table. */
  #lut(params: ResolvedParams, frame: Frame) {
    const lut = frame.luts?.get(str(params, 'lut'));
    if (!lut) return;
    const { width, height } = this.#canvas;
    if (this.#lutGl === undefined) this.#lutGl = LutGl.make();
    const result = this.#lutGl?.apply(this.#surface, lut, width, height);
    if (result) return this.#putBack(result);
    // On the processor: slower, the same colours.
    const copy = this.#copyOfPicture();
    const pixels = copy.getContext('2d')!.getImageData(0, 0, width, height);
    applyLut(lut, pixels.data);
    const out = this.#extraCanvas(0);
    out.getContext('2d')!.putImageData(pixels, 0, 0);
    this.#putBack(out);
  }

  /** The picture beneath, through one of the canvas's filters. */
  #filtered(filter: string) {
    const copy = this.#copyOfPicture();
    const result = this.#extraCanvas(0);
    const r = result.getContext('2d')!;
    r.setTransform(1, 0, 0, 1, 0, 0);
    r.globalCompositeOperation = 'copy';
    r.globalAlpha = 1;
    r.filter = filter;
    r.drawImage(copy, 0, 0);
    r.filter = 'none';
    this.#putBack(result);
  }

  /**
   * Draws `source` into `result` with its red, green and blue each moved on
   * its own: by `place`, which gets the channel (0 red, 1 green, 2 blue) and
   * transforms the drawing for it.
   */
  #channels(source: OffscreenCanvas, result: OffscreenCanvas, place: (s: OffscreenCanvasRenderingContext2D, channel: number) => void) {
    const { width, height } = this.#canvas;
    const one = this.#extraCanvas(1);
    const c = one.getContext('2d')!;
    const r = result.getContext('2d')!;
    // From clear, not black: in a group, where nothing is drawn stays see-through.
    r.setTransform(1, 0, 0, 1, 0, 0);
    r.globalAlpha = 1;
    r.globalCompositeOperation = 'source-over';
    r.clearRect(0, 0, width, height);
    r.globalCompositeOperation = 'lighter';
    ['#ff0000', '#00ff00', '#0000ff'].forEach((only, channel) => {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      c.clearRect(0, 0, width, height);
      place(c, channel);
      c.drawImage(source, 0, 0);
      // Keeps this channel alone, and only where the picture is.
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'multiply';
      c.fillStyle = only;
      c.fillRect(0, 0, width, height);
      c.globalCompositeOperation = 'destination-in';
      place(c, channel);
      c.drawImage(source, 0, 0);
      r.drawImage(one, 0, 0);
    });
  }

  /**
   * Chromatic aberration: red and blue pulled apart from green. Straight, in
   * one direction; or from the centre, as a lens does it, none in the middle
   * and most at the edges.
   */
  #split(params: ResolvedParams) {
    const { width, height } = this.#canvas;
    const amount = (num(params, 'amount') / 100) * width;
    if (amount === 0) return;
    const copy = this.#copyOfPicture();
    const result = this.#extraCanvas(0);
    const radial = str(params, 'form') === 'from the centre';
    const angle = (num(params, 'angle') * Math.PI) / 180;
    // From the centre: red enlarged most, green half as much, blue not at all, so that
    // red and blue are the amount apart at the corners and no edge is left without a colour.
    const scale = amount / Math.hypot(width / 2, height / 2);
    this.#channels(copy, result, (c, channel) => {
      const sign = channel === 0 ? 1 : channel === 2 ? -1 : 0;
      if (radial) {
        const k = 1 + ((sign + 1) / 2) * scale;
        c.setTransform(k, 0, 0, k, (width / 2) * (1 - k), (height / 2) * (1 - k));
      } else {
        c.setTransform(1, 0, 0, 1, Math.cos(angle) * amount * sign, Math.sin(angle) * amount * sign);
      }
    });
    this.#putBack(result);
  }

  /**
   * A digital glitch: on some moments, slices of the picture torn sideways,
   * with its colours split. What happens is worked out from the time alone,
   * so a video glitches the same each time it is made.
   */
  #glitch(params: ResolvedParams, frame: Frame) {
    const { width, height } = this.#canvas;
    const tick = Math.floor(frame.seconds * Math.max(0.1, num(params, 'rate')));
    const random = (n: number) => hash(tick * 7919 + n * 104729 + 17);
    // How often: the share of moments that glitch.
    if (random(0) >= num(params, 'amount')) return;
    const copy = this.#copyOfPicture();
    const result = this.#extraCanvas(0);
    const split = (num(params, 'split') / 100) * width * (0.5 + random(1));
    if (split > 0) {
      this.#channels(copy, result, (c, channel) => c.setTransform(1, 0, 0, 1, (channel - 1) * split, 0));
    } else {
      const r = result.getContext('2d')!;
      r.setTransform(1, 0, 0, 1, 0, 0);
      r.globalCompositeOperation = 'copy';
      r.drawImage(copy, 0, 0);
    }
    // Slices of the picture, each moved sideways: taken from the split picture, so they carry its colours.
    const r = result.getContext('2d')!;
    r.globalCompositeOperation = 'source-over';
    r.setTransform(1, 0, 0, 1, 0, 0);
    const torn = this.#extraCanvas(2);
    const t = torn.getContext('2d')!;
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalCompositeOperation = 'copy';
    t.drawImage(result, 0, 0);
    const slices = Math.max(1, Math.round(num(params, 'slices') * (0.3 + 0.7 * random(2))));
    const shift = (num(params, 'shift') / 100) * width;
    for (let i = 0; i < slices; i++) {
      const y = Math.floor(random(10 + i * 3) * height);
      const h = Math.max(2, Math.floor((0.005 + 0.06 * random(11 + i * 3) ** 2) * height));
      const dx = Math.round((random(12 + i * 3) * 2 - 1) * shift);
      r.drawImage(torn, 0, y, width, h, dx, y, width, h);
    }
    this.#putBack(result);
  }

  /**
   * A kaleidoscope: one slice of the picture beneath, round a centre (the
   * layer's position), repeated all the way round, every other one flipped
   * when mirrored so that neighbours meet without a seam. The layer's
   * rotation turns the pattern and its scale zooms in on the slice.
   */
  #kaleidoscope(params: ResolvedParams) {
    const { width, height } = this.#canvas;
    const segments = Math.max(2, Math.min(64, Math.round(num(params, 'segments'))));
    const copy = this.#copyOfPicture();
    const result = this.#extraCanvas(0);
    const r = result.getContext('2d')!;
    const cx = (num(params, 'x') / 100) * width;
    const cy = (num(params, 'y') / 100) * height;
    const zoom = Math.max(0.01, num(params, 'scale') / 100);
    const turn = (num(params, 'rotation') * Math.PI) / 180;
    const taken = (num(params, 'angle') * Math.PI) / 180;
    const mirrored = params.mirrored !== false;
    const slice = (Math.PI * 2) / segments;
    // Far enough to reach every corner from any centre.
    const reach = Math.hypot(width, height) * 2;
    r.setTransform(1, 0, 0, 1, 0, 0);
    r.globalAlpha = 1;
    r.globalCompositeOperation = 'source-over';
    r.clearRect(0, 0, width, height);
    // The picture mirrored past its edges, without end: a slice reaching further than the picture does
    // goes on into its reflection rather than into black.
    const pattern = r.createPattern(this.#mirrorTile(copy), 'repeat')!;
    for (let i = 0; i < segments; i++) {
      r.save();
      r.translate(cx, cy);
      r.rotate(turn + i * slice);
      if (mirrored && i % 2 === 1) r.scale(1, -1);
      // A wedge a hair wider than its share, so that its edges overlap the next and leave no line between them.
      r.beginPath();
      r.moveTo(0, 0);
      r.arc(0, 0, reach, -slice / 2 - 0.004, slice / 2 + 0.004);
      r.closePath();
      r.clip();
      // The slice of the picture round the direction it is taken from, turned to lie along the wedge.
      r.rotate(-taken);
      r.scale(zoom, zoom);
      r.translate(-cx, -cy);
      r.fillStyle = pattern;
      r.fillRect(cx - reach / zoom, cy - reach / zoom, (reach * 2) / zoom, (reach * 2) / zoom);
      r.restore();
    }
    this.#putBack(result);
  }

  /**
   * The picture beneath moved to the layer's position, turned, sized and
   * flipped. Past its edges: nothing (black, or see-through in a group), the
   * picture repeated, the picture mirrored so that each copy meets the next
   * without a seam, or its outermost pixels drawn out.
   */
  #transform(params: ResolvedParams) {
    const { width, height } = this.#canvas;
    const copy = this.#copyOfPicture();
    const result = this.#extraCanvas(0);
    const r = result.getContext('2d')!;
    const zoom = Math.max(0.01, num(params, 'scale') / 100);
    const where = new DOMMatrix()
      .translate((num(params, 'x') / 100) * width, (num(params, 'y') / 100) * height)
      .rotate(num(params, 'rotation'))
      .scale(params.flipX === true ? -zoom : zoom, params.flipY === true ? -zoom : zoom)
      .translate(-width / 2, -height / 2);
    // The part of the picture's own space that lands in the frame: its corners taken back through the move.
    const back = where.inverse();
    const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => back.transformPoint({ x, y }));
    const left = Math.floor(Math.min(...corners.map((c) => c.x))) - 1;
    const top = Math.floor(Math.min(...corners.map((c) => c.y))) - 1;
    const right = Math.ceil(Math.max(...corners.map((c) => c.x))) + 1;
    const bottom = Math.ceil(Math.max(...corners.map((c) => c.y))) + 1;

    r.setTransform(1, 0, 0, 1, 0, 0);
    r.globalAlpha = 1;
    r.globalCompositeOperation = 'source-over';
    r.filter = 'none';
    r.clearRect(0, 0, width, height);
    // Outside a group nothing past the edges is black, as the picture starts; inside one, see-through.
    if (this.#depth === 0) {
      r.fillStyle = '#000000';
      r.fillRect(0, 0, width, height);
    }
    r.setTransform(where);
    const edges = str(params, 'edges');
    if (edges === 'repeat' || edges === 'mirror') {
      r.fillStyle = r.createPattern(edges === 'mirror' ? this.#mirrorTile(copy) : copy, 'repeat')!;
      r.fillRect(left, top, right - left, bottom - top);
    } else if (edges === 'extend') {
      // The edge rows and columns stretched out to the frame's reach, the corner pixels into the corners.
      const [x0, y0, x1, y1] = [Math.min(0, left), Math.min(0, top), Math.max(width, right), Math.max(height, bottom)];
      const parts: [number, number, number, number, number, number, number, number][] = [
        [0, 0, width, height, 0, 0, width, height],
        [0, 0, 1, height, x0, 0, -x0, height], [width - 1, 0, 1, height, width, 0, x1 - width, height],
        [0, 0, width, 1, 0, y0, width, -y0], [0, height - 1, width, 1, 0, height, width, y1 - height],
        [0, 0, 1, 1, x0, y0, -x0, -y0], [width - 1, 0, 1, 1, width, y0, x1 - width, -y0],
        [0, height - 1, 1, 1, x0, height, -x0, y1 - height], [width - 1, height - 1, 1, 1, width, height, x1 - width, y1 - height],
      ];
      for (const [sx, sy, sw, sh, dx, dy, dw, dh] of parts) if (dw > 0 && dh > 0) r.drawImage(copy, sx, sy, sw, sh, dx, dy, dw, dh);
    } else {
      r.drawImage(copy, 0, 0);
    }
    r.setTransform(1, 0, 0, 1, 0, 0);
    // An outline to move, turn and size it by on the picture: the picture's own edges, where they went.
    this.#record(params, -width / 2, -height / 2, width, height);
    this.#putBack(result);
  }

  /**
   * The picture beneath with the frames before it fading behind: as an echo
   * (the past mixed in), or leaving only its bright parts or its dark parts
   * behind. The past is zoomed and turned round the layer's position each
   * frame, by time rather than by frame, so the preview and the export, at
   * different frame rates, leave the same trails. Paused, or after a jump,
   * there is no past: the picture is shown as it is, edits and all.
   */
  #trails(params: ResolvedParams, frame: Frame, memory: Memory) {
    const { width, height } = this.#canvas;
    const copy = this.#copyOfPicture();
    let trail = memory.trail;
    const fresh = !trail || trail.width !== width || trail.height !== height;
    // In half floats: in bytes, a faint trail faded by a few percent a frame rounds back to what it was, and never goes.
    if (fresh) [trail, memory.past] = [new OffscreenCanvas(width, height), new OffscreenCanvas(width, height)];
    memory.trail = trail;
    const t = trail!.getContext('2d', { colorType: 'float16' })!;
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalAlpha = 1;
    t.filter = 'none';
    const dt = frame.dt;
    if (fresh || dt <= 0 || dt > 1) {
      t.globalCompositeOperation = 'copy';
      t.drawImage(copy, 0, 0);
      t.globalCompositeOperation = 'source-over';
      return this.#putBack(trail!);
    }
    // After `length` seconds, a twentieth of a frame is left.
    const keep = Math.exp((-3 * dt) / Math.max(0.01, num(params, 'length')));
    // The past moved on: zoomed and turned round the layer's position, by as much as this frame's share of a second.
    const past = memory.past!;
    const p = past.getContext('2d', { colorType: 'float16' })!;
    const cx = (num(params, 'x') / 100) * width;
    const cy = (num(params, 'y') / 100) * height;
    const zoom = Math.pow(Math.max(0.01, 1 + num(params, 'zoom') / 100), dt);
    p.setTransform(1, 0, 0, 1, 0, 0);
    p.globalAlpha = 1;
    p.filter = 'none';
    p.globalCompositeOperation = 'copy';
    p.translate(cx, cy);
    p.rotate((num(params, 'turn') * dt * Math.PI) / 180);
    p.scale(zoom, zoom);
    p.translate(-cx, -cy);
    p.drawImage(trail!, 0, 0);
    p.setTransform(1, 0, 0, 1, 0, 0);
    const mode = str(params, 'mode');
    if (mode === 'echo') {
      // Now, with the past laid over it at what is left of it.
      t.globalCompositeOperation = 'copy';
      t.drawImage(copy, 0, 0);
      t.globalCompositeOperation = 'source-over';
      t.globalAlpha = keep;
      t.drawImage(past, 0, 0);
    } else {
      // The past faded towards black (or white), then whichever is brighter (or darker) of it and now, pixel by pixel.
      const bright = mode === 'bright parts';
      p.globalCompositeOperation = 'destination-over';
      p.fillStyle = bright ? '#000000' : '#ffffff';
      p.fillRect(0, 0, width, height);
      p.globalCompositeOperation = 'source-over';
      p.globalAlpha = 1 - keep;
      p.fillRect(0, 0, width, height);
      p.globalAlpha = 1;
      t.globalCompositeOperation = 'copy';
      t.drawImage(copy, 0, 0);
      t.globalCompositeOperation = bright ? 'lighten' : 'darken';
      t.drawImage(past, 0, 0);
    }
    t.globalAlpha = 1;
    t.globalCompositeOperation = 'source-over';
    this.#putBack(trail!);
  }

  /** The picture and its mirror images, two by two: repeated, it goes on mirrored without end, with no seams. */
  #mirrorTile(copy: OffscreenCanvas): OffscreenCanvas {
    const { width, height } = this.#canvas;
    const tile = this.#extraCanvas(5, width * 2, height * 2);
    const t = tile.getContext('2d')!;
    t.globalAlpha = 1;
    t.globalCompositeOperation = 'copy';
    for (const [fx, fy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      t.setTransform(fx, 0, 0, fy, fx < 0 ? width * 2 : 0, fy < 0 ? height * 2 : 0);
      t.drawImage(copy, 0, 0);
      t.globalCompositeOperation = 'source-over';
    }
    t.setTransform(1, 0, 0, 1, 0, 0);
    return tile;
  }

  /** A clear canvas the size of the picture for a layer to draw on alone, to be blended by hand. */
  #layerCanvas(): Context {
    const layer = this.#extraCanvas(6).getContext('2d')!;
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalAlpha = 1;
    layer.globalCompositeOperation = 'source-over';
    layer.filter = 'none';
    layer.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    return layer;
  }

  /**
   * Burns the layer just drawn on its own into the picture: beneath + layer
   * - 1, as linear burn is, then mixed in by `amount`, the layer's opacity.
   * Worked as the canvas can, on a copy of the picture: inverted, the
   * layer's inverse added where the layer is, and the sum inverted back,
   * 1 - ((1 - beneath) + (1 - layer)).
   */
  #linearBurn(amount: number, beneath: Canvas, onto: Context) {
    const { width, height } = this.#canvas;
    const layer = this.#extraCanvas(6);
    // The layer's inverse, where the layer is: white with the layer taken away by difference, then cut to its shape.
    const inverse = this.#extraCanvas(7);
    const i = inverse.getContext('2d')!;
    i.setTransform(1, 0, 0, 1, 0, 0);
    i.globalAlpha = 1;
    i.globalCompositeOperation = 'copy';
    i.fillStyle = '#ffffff';
    i.fillRect(0, 0, width, height);
    i.globalCompositeOperation = 'difference';
    i.drawImage(layer, 0, 0);
    i.globalCompositeOperation = 'destination-in';
    i.drawImage(layer, 0, 0);
    const burnt = this.#extraCanvas(8);
    const b = burnt.getContext('2d')!;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalAlpha = 1;
    b.globalCompositeOperation = 'copy';
    b.drawImage(beneath, 0, 0);
    b.fillStyle = '#ffffff';
    b.globalCompositeOperation = 'difference';
    b.fillRect(0, 0, width, height);
    b.globalCompositeOperation = 'lighter';
    b.drawImage(inverse, 0, 0);
    b.globalCompositeOperation = 'difference';
    b.fillRect(0, 0, width, height);
    const ctx = onto;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = amount;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(burnt, 0, 0);
    ctx.restore();
  }
}
/**
 * Makes part of a picture transparent: what is near the key colour (a green
 * screen), or what is dark (a clip made on black). Within `tolerance` (a
 * fraction) of the way to the furthest colour it goes entirely; over the
 * next `softness` it fades back in, so edges stay smooth.
 */
function keyOut(
  ctx: OffscreenCanvasRenderingContext2D, width: number, height: number, kind: 'colour' | 'dark', colour: Colour | null, tolerance: number, softness: number,
) {
  if (width <= 0 || height <= 0) return;
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const key = colour ?? parseHex('#00ff00')!;
  const [kr, kg, kb] = [key.r * 255, key.g * 255, key.b * 255];
  const low = Math.max(0, tolerance);
  const high = low + Math.max(1e-3, softness);
  // The furthest a colour can be from another: corner to corner of the colour cube.
  const furthest = Math.sqrt(3) * 255;
  for (let i = 0; i < data.length; i += 4) {
    const distance = kind === 'dark'
      ? (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
      : Math.hypot(data[i] - kr, data[i + 1] - kg, data[i + 2] - kb) / furthest;
    if (distance >= high) continue;
    data[i + 3] = distance <= low ? 0 : Math.round(data[i + 3] * ((distance - low) / (high - low)));
  }
  ctx.putImageData(image, 0, 0);
}

/**
 * Applies LUTs on the graphics card: the picture is a texture, the LUT a 3D
 * texture read between its points by the card itself, and the result a
 * canvas to draw back. A LUT is sent to the card once, then kept while it is
 * in use.
 */
class LutGl {
  readonly #canvas: OffscreenCanvas;
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #picture: WebGLTexture;
  readonly #tables = new WeakMap<Lut, WebGLTexture>();
  #uniforms: Record<'picture' | 'table' | 'size' | 'low' | 'high', WebGLUniformLocation | null>;

  static make(): LutGl | null {
    try {
      return typeof OffscreenCanvas === 'undefined' ? null : new LutGl();
    } catch {
      return null;
    }
  }

  constructor() {
    this.#canvas = new OffscreenCanvas(1, 1);
    const gl = this.#canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('No WebGL 2');
    this.#gl = gl;
    const shader = (type: number, source: string) => {
      const made = gl.createShader(type)!;
      gl.shaderSource(made, source);
      gl.compileShader(made);
      if (!gl.getShaderParameter(made, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(made) ?? 'Shader');
      return made;
    };
    const program = gl.createProgram()!;
    // One triangle over the whole picture, made from the vertex's number alone.
    gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
      void main() {
        vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`));
    // The picture's pixels are read as they are, not premultiplied, and written back premultiplied, as the canvas keeps them.
    // A point's value is at the middle of its texel, so 0 and 1 land on the first and the last point exactly.
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      precision highp sampler3D;
      uniform sampler2D picture;
      uniform sampler3D table;
      uniform float size;
      uniform vec3 low;
      uniform vec3 high;
      out vec4 colour;
      void main() {
        ivec2 at = ivec2(gl_FragCoord.xy);
        at.y = textureSize(picture, 0).y - 1 - at.y;
        vec4 c = texelFetch(picture, at, 0);
        vec3 t = clamp((c.rgb - low) / (high - low), 0.0, 1.0);
        vec3 looked = clamp(texture(table, (t * (size - 1.0) + 0.5) / size).rgb, 0.0, 1.0);
        colour = vec4(looked * c.a, c.a);
      }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Program');
    this.#program = program;
    this.#uniforms = {
      picture: gl.getUniformLocation(program, 'picture'),
      table: gl.getUniformLocation(program, 'table'),
      size: gl.getUniformLocation(program, 'size'),
      low: gl.getUniformLocation(program, 'low'),
      high: gl.getUniformLocation(program, 'high'),
    };
    this.#picture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.#picture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  #table(lut: Lut): WebGLTexture {
    const known = this.#tables.get(lut);
    if (known) return known;
    const gl = this.#gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Half floats are read between points by any card; full floats need an extension for that.
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
    for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.#tables.set(lut, texture);
    return texture;
  }

  /** The picture through the LUT, on a canvas of this class's own; null if the card could not do it. */
  apply(source: Canvas, lut: Lut, width: number, height: number): OffscreenCanvas | null {
    const gl = this.#gl;
    if (gl.isContextLost()) return null;
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.#program);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.#table(lut));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#picture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1i(this.#uniforms.picture, 0);
    gl.uniform1i(this.#uniforms.table, 1);
    gl.uniform1f(this.#uniforms.size, lut.size);
    gl.uniform3fv(this.#uniforms.low, lut.min);
    gl.uniform3fv(this.#uniforms.high, lut.max);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return gl.getError() === gl.NO_ERROR ? this.#canvas : null;
  }
}
