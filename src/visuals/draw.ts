// Draws a frame of a template on a 2D canvas: the same code for the preview in
// the visuals window and for every frame of a video export. Everything a
// frame shows follows from the moment in the mix and what the music gives
// there, so any frame can be drawn on its own, in any order, and comes out
// the same. The exceptions remember a little from the frame before (the rise
// and fall of the spectrum, a text changing); `reset` forgets it after a jump.
//
// Kept free of Node imports; it runs in a window.

import { fromHsl, parseHex, whiteBalance, type Colour } from './colour.ts';
import { BAND_COUNT, HIGHEST_HZ, LOWEST_HZ } from '../features.ts';
import type { Values } from './expression.ts';
import { fontStack } from './fonts.ts';
import { hexOf, LAYER_TYPES, type PreparedLayer, type ResolvedParams, type TextValues } from './template.ts';
import type { ClipTiming, Playback } from './clip.ts';
import { applyLut, scalingLut, type Lut } from './lut.ts';
import { lengthOf, shapeOutline } from './outline.ts';
import { covered, kindNumber, NOISE_SHADER, noiseValue, seedBits, type NoiseOptions } from './noise.ts';
import { DISPLACE_SHADER, displacementAt, modeNumber, type Displacement } from './displace.ts';
import { fewer, hexagonAt, hexCells, hexColour, hexRadius, squareCells, triangleAt, triangleCells, type Cell, type Region } from './cells.ts';
import { brightnessOf, canvasStops, gradientAt, gradientMapTable, stopsOf, turnStops, type Stop } from './gradient-map.ts';

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

/** A layer's gradient: its stops in use (gradient-map.ts), in order. */
const stopsIn = (params: ResolvedParams): Stop[] => stopsOf((n) => col(params, `colour${n}`), (n) => num(params, `position${n}`));

/** Whether a layer's gradient blends round the colour wheel rather than evenly. */
const wheelIn = (params: ResolvedParams) => str(params, 'stopBlend') === 'round the colour wheel';

/** Gives a canvas gradient a layer's stops, closely following their blending; going round, for a conic one. */
function giveStops(gradient: CanvasGradient, stops: Stop[], params: ResolvedParams, wrap = false) {
  for (const [at, colour] of canvasStops(stops, wrap, wheelIn(params))) gradient.addColorStop(at, hexOf(colour));
}

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
  /**
   * For each layer inside groups that are turned or sized, how they turn and
   * size it, as a 2×2 matrix (a, b, c, d, column by column) from its own
   * frame to the picture's; null where nothing does. So that the editor can
   * move a layer the way it is dragged.
   */
  frames: ([number, number, number, number] | null)[] = [];
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
    this.frames = layers.map(() => null);
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

  /**
   * Draws layers `start` to `end` of the list, a group's with its layers in
   * it. A layer used as a mask takes the rest of the range: those layers are
   * drawn through it.
   */
  #drawRange(layers: PreparedLayer[], start: number, end: number, frame: Frame) {
    for (let index = start; index < end;) {
      const inside = layers[index].type === 'group' ? Math.max(0, Math.min(layers[index].size, end - index - 1)) : 0;
      const params = layers[index].resolve(frame.music, frame.text);
      // A mask switched off (hidden) masks nothing: the layers above it show as they are.
      if (params.visible !== false && (params.mask === 'by its shape' || params.mask === 'by its brightness')) {
        return this.#drawMasked(layers, index, inside, end, params, frame);
      }
      this.#drawLayer(layers, index, inside, frame);
      index += 1 + inside;
    }
  }

  /** Masks and what they mask, a pair of canvases for each mask within another. */
  #maskCanvases: [OffscreenCanvas, OffscreenCanvas][] = [];
  #maskDepth = 0;

  /**
   * The layers from after the mask at `index` to `end`, drawn through it.
   * The mask is drawn alone, as it would be drawn, and becomes how much of
   * each pixel shows: its coverage, or its brightness too; grown or shrunk,
   * feathered, then inverted. Its opacity and fades say how much it shows.
   * The layers are drawn onto a copy of the picture so far, so that effects
   * among them see what is beneath; then laid back over it through the mask.
   */
  #drawMasked(layers: PreparedLayer[], index: number, inside: number, end: number, params: ResolvedParams, frame: Frame) {
    const { width, height } = this.#canvas;
    const depth = this.#maskDepth++;
    let pair = this.#maskCanvases[depth];
    if (!pair || pair[0].width !== width || pair[0].height !== height) pair = this.#maskCanvases[depth] = [new OffscreenCanvas(width, height), new OffscreenCanvas(width, height)];
    const [maskCanvas, content] = pair;
    const fresh = (canvas: OffscreenCanvas) => {
      const c = canvas.getContext('2d')!;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      c.filter = 'none';
      return c;
    };
    const [surface, before] = [this.#surface, this.#ctx];

    // The mask layer alone, as it would be drawn; where it is is noted for the editor as for any layer.
    const m = fresh(maskCanvas);
    m.clearRect(0, 0, width, height);
    [this.#surface, this.#ctx] = [maskCanvas, m];
    this.#drawLayer(layers, index, inside, frame);
    [this.#surface, this.#ctx] = [surface, before];

    let mask: OffscreenCanvas = maskCanvas;
    // By its brightness: white shows, black hides, as much as it covers.
    if (params.mask === 'by its brightness') {
      const table = new Uint8ClampedArray(256 * 4).fill(255);
      for (let i = 0; i < 256; i++) table[i * 4 + 3] = i;
      mask = this.#recoloured(maskCanvas, table);
    }
    const grow = (num(params, 'maskExpand') / 100) * this.#unit;
    if (grow >= 0.5) mask = this.#dilate(mask, grow);
    else if (grow <= -0.5) mask = this.#inverted(this.#dilate(this.#inverted(mask, 16), -grow), 17);
    const feather = (num(params, 'maskFeather') / 100) * this.#unit;
    if (feather > 0) {
      const soft = this.#extraCanvas(15);
      this.#blurInto(mask, soft, feather / 2);
      mask = soft;
    }
    if (params.maskInvert === true) mask = this.#inverted(mask, 16);
    // Kept in the mask's own canvas: the scratch canvases above are used again by the layers drawn through it.
    if (mask !== maskCanvas) {
      const keep = fresh(maskCanvas);
      keep.globalCompositeOperation = 'copy';
      keep.drawImage(mask, 0, 0);
    }

    // The layers through the mask, onto a copy of the picture so far.
    const c = fresh(content);
    c.globalCompositeOperation = 'copy';
    c.drawImage(surface, 0, 0);
    c.globalCompositeOperation = 'source-over';
    [this.#surface, this.#ctx] = [content, c];
    this.#drawRange(layers, index + 1 + inside, end, frame);
    [this.#surface, this.#ctx] = [surface, before];
    this.#maskDepth--;

    // Where the mask shows, the picture becomes what was drawn; elsewhere it stays as it was. Partly, where it partly shows.
    const kept = fresh(content);
    kept.globalCompositeOperation = 'destination-in';
    kept.drawImage(maskCanvas, 0, 0);
    before.save();
    before.setTransform(1, 0, 0, 1, 0, 0);
    before.globalAlpha = 1;
    before.filter = 'none';
    before.globalCompositeOperation = 'destination-out';
    before.drawImage(maskCanvas, 0, 0);
    before.globalCompositeOperation = 'lighter';
    before.drawImage(content, 0, 0);
    before.restore();
  }

  /** A mask the other way round, on scratch canvas `n`: shown where it hid, hidden where it showed. */
  #inverted(mask: OffscreenCanvas, n: number): OffscreenCanvas {
    const out = this.#extraCanvas(n);
    const o = out.getContext('2d')!;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.globalAlpha = 1;
    o.filter = 'none';
    o.globalCompositeOperation = 'copy';
    o.fillStyle = '#ffffff';
    o.fillRect(0, 0, out.width, out.height);
    o.globalCompositeOperation = 'destination-out';
    o.drawImage(mask, 0, 0);
    return out;
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
    if (group) this.#moveGroupBoxes(index, inside, params);
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
      case 'group': this.#layGroup(group!, params); break;
      case 'solid': this.#solid(params); break;
      case 'gradient': this.#gradient(params, frame); break;
      case 'particles': this.#particles(params, frame); break;
      case 'image': this.#image(params, frame); break;
      case 'video': this.#video(params, frame, index); break;
      case 'text': this.#text(params, frame, memory); break;
      case 'spectrum': this.#spectrum(params, frame, memory); break;
      case 'waveform': this.#waveform(params, frame); break;
      case 'shape': this.#shape(params); break;
      case 'noise': this.#noise(params, frame); break;
      case 'grid': this.#grid(params, frame); break;
      case 'mosaic': this.#mosaic(params); break;
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
      case 'whiteBalance': this.#whiteBalance(params); break;
      case 'displace': this.#displace(params, frame); break;
      case 'gradientMap': this.#gradientMap(params); break;
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

  /**
   * Where a group's layers end up once it is laid down, moved: the middle of
   * the picture they were drawn in goes to the group's position, turned and
   * sized about it. At 50%, 50%, 100% and 0°, just where they were.
   */
  #groupMove(params: ResolvedParams): DOMMatrix {
    const { width, height } = this.#canvas;
    return new DOMMatrix()
      .translateSelf((num(params, 'x') / 100) * width, (num(params, 'y') / 100) * height)
      .rotateSelf(num(params, 'rotation'))
      .scaleSelf(num(params, 'scale') / 100)
      .translateSelf(-width / 2, -height / 2);
  }

  /** Lays a group's picture down, moved as its placement says. */
  #layGroup(group: OffscreenCanvas, params: ResolvedParams) {
    const ctx = this.#ctx;
    ctx.save();
    ctx.setTransform(ctx.getTransform().multiply(this.#groupMove(params)));
    ctx.drawImage(group, 0, 0);
    ctx.restore();
  }

  /**
   * Notes where a group lies for the editor, and moves where its layers lie
   * with it. Its outline is the box round all its layers' outlines, as they
   * were drawn; one with none (only gradients, say) has none, so that it does
   * not cover the whole picture when clicked on.
   */
  #moveGroupBoxes(index: number, inside: number, params: ResolvedParams) {
    const move = this.#groupMove(params);
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = index + 1; i <= index + inside; i++) {
      // Within this group, inside any it holds.
      const [a, b, c, d] = this.frames[i] ?? [1, 0, 0, 1];
      this.frames[i] = [move.a * a + move.c * b, move.b * a + move.d * b, move.a * c + move.c * d, move.b * c + move.d * d];
      const box = this.boxes[i];
      if (!box) continue;
      // Its corners as drawn, before the group moved them.
      const turn = (box.rotation * Math.PI) / 180;
      const [cos, sin] = [Math.cos(turn) * box.scale, Math.sin(turn) * box.scale];
      for (const [cx, cy] of [[box.left, box.top], [box.left + box.w, box.top], [box.left, box.top + box.h], [box.left + box.w, box.top + box.h]]) {
        const [x, y] = [box.x + cos * cx - sin * cy, box.y + sin * cx + cos * cy];
        [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x), Math.max(bottom, y)];
      }
      // Moved as the group moves it: its anchor, its size and its turn.
      const anchor = move.transformPoint(new DOMPoint(box.x, box.y));
      this.boxes[i] = { ...box, x: anchor.x, y: anchor.y, scale: box.scale * (num(params, 'scale') / 100), rotation: box.rotation + num(params, 'rotation') };
    }
    if (left > right) return;
    const { width, height } = this.#canvas;
    // The group's anchor is its position; its box is round its layers, from the middle of the picture they were drawn in.
    this.boxes[index] = {
      x: (num(params, 'x') / 100) * width,
      y: (num(params, 'y') / 100) * height,
      left: left - width / 2, top: top - height / 2, w: right - left, h: bottom - top,
      scale: num(params, 'scale') / 100,
      rotation: num(params, 'rotation'),
      circle: false,
    };
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
    const stops = turnStops(stopsIn(params), num(params, 'hueShift') * frame.seconds);
    if (stops.length === 0) return;
    const angle = ((num(params, 'angle') + num(params, 'drift') * frame.seconds) * Math.PI) / 180;
    const cx = (num(params, 'x') / 100) * width;
    const cy = (num(params, 'y') / 100) * height;
    const reach = (Math.hypot(width, height) / 2) * (num(params, 'scale') / 100);
    let gradient: CanvasGradient;
    const kind = str(params, 'kind');
    if (kind === 'radial') gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
    else if (kind === 'conic') gradient = ctx.createConicGradient(angle, cx, cy);
    else gradient = ctx.createLinearGradient(cx - Math.cos(angle) * reach, cy - Math.sin(angle) * reach, cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach);
    giveStops(gradient, stops, params, kind === 'conic');
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
    // With no stop in use, a green, rather than nothing.
    const stops = stopsIn(params);
    if (stops.length === 0) stops.push({ colour: fromHsl(150, 0.7, 0.55), position: 0 });
    const colouring = str(params, 'colouring');
    const wheel = wheelIn(params);
    const colourOf = (i: number, value: number) =>
      colouring === 'one colour' ? stops[0].colour : gradientAt(stops, colouring === 'by height' ? value : i / Math.max(1, bars - 1), wheel);
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

    const stops = stopsIn(params);
    const kind = str(params, 'fill');
    let fill: string | CanvasGradient | null = stops.length ? hexOf(stops[0].colour) : null;
    if (stops.length > 1 && kind !== 'one colour') {
      let gradient: CanvasGradient;
      if (kind === 'radial gradient') gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) / 2);
      else {
        // 90° runs left to right, as the gradient layer's does; the ends are where the box's corners reach along that line.
        const angle = (num(params, 'gradientAngle') * Math.PI) / 180 - Math.PI / 2;
        const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
        const reach = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
        gradient = ctx.createLinearGradient(-dx * reach, -dy * reach, dx * reach, dy * reach);
      }
      giveStops(gradient, stops, params);
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

  /**
   * A grid over the whole picture (cells.ts): its middle at the layer's
   * position, turned and sized with the layer, scrolling as its speed says.
   * A floor is drawn in perspective instead, its vanishing point there.
   */
  #grid(params: ResolvedParams, frame: Frame) {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    const unit = this.#unit;
    const s = Math.max(1, (num(params, 'cell') / 100) * unit);
    const line = Math.max(0, (num(params, 'lineWidth') / 100) * unit);
    const kind = str(params, 'kind');
    const lineColour = col(params, 'lineColour');
    const fills = [col(params, 'fill1'), col(params, 'fill2'), col(params, 'fill3')];
    const scale = Math.max(1e-3, num(params, 'scale') / 100);
    const travelled = (num(params, 'scroll') / 100) * unit * frame.seconds;
    this.#place(params);
    if (kind === 'floor') return this.#floor(params, s, line, lineColour, travelled, scale);
    const way = (num(params, 'direction') * Math.PI) / 180;
    const [ox, oy] = [Math.cos(way) * travelled, Math.sin(way) * travelled];
    // Enough to cover the picture however the grid is turned.
    const reach = Math.hypot(width, height) / scale + 2 * s;
    const region: Region = [-reach, -reach, reach, reach];
    /** One path a colour, filled at once: far quicker than a fill for each cell. */
    const fillBy = (cells: Cell[], colourOf: (cell: Cell) => number, shape: (path: Path2D, cell: Cell) => void) => {
      const paths = fills.map(() => new Path2D());
      for (const cell of cells) {
        const which = colourOf(cell);
        if (fills[which]) shape(paths[which], cell);
      }
      paths.forEach((path, which) => {
        if (!fills[which]) return;
        ctx.fillStyle = hexOf(fills[which]);
        ctx.fill(path);
      });
    };
    switch (kind) {
      case 'checkerboard': {
        const inset = Math.min(s / 2 - 0.5, line / 2);
        const radius = (num(params, 'rounding') / 100) * (s - 2 * inset);
        fillBy(squareCells(s, ox, oy, region), (cell) => (((cell.i + cell.j) % 2) + 2) % 2, (path, cell) => {
          path.roundRect(cell.x - s / 2 + inset, cell.y - s / 2 + inset, s - 2 * inset, s - 2 * inset, radius);
        });
        return;
      }
      case 'hex cells': {
        const used = fills[2] ? 3 : 2;
        const radius = hexRadius(s) * Math.max(0, 1 - line / s);
        fillBy(hexCells(s, ox, oy, region), (cell) => hexColour(cell) % used, (path, cell) => addPolygon(path, hexagonAt(cell.x, cell.y, radius)));
        return;
      }
      case 'dots': {
        const radius = (Math.max(0, num(params, 'dotSize')) * s) / 2;
        fillBy(squareCells(s, ox, oy, region), () => 0, (path, cell) => {
          path.moveTo(cell.x + radius, cell.y);
          path.arc(cell.x, cell.y, radius, 0, Math.PI * 2);
        });
        return;
      }
      case 'stripes': {
        // Bands half a cell wide, the first colour and the second by turns, across the grid's width.
        const band = s / 2;
        const bands: Cell[] = [];
        for (let i = Math.floor((-reach - ox) / band); i * band + ox < reach; i++) bands.push({ x: ox + i * band, y: 0, i, j: 0 });
        fillBy(bands, (cell) => ((cell.i % 2) + 2) % 2, (path, cell) => path.rect(cell.x, -reach, band, reach * 2));
        return;
      }
    }
    if (!lineColour || line <= 0) return;
    const path = new Path2D();
    if (kind === 'hex grid') {
      // Three edges of each hexagon: the other three are its neighbours'.
      const radius = hexRadius(s);
      for (const cell of hexCells(s, ox, oy, region)) {
        const corners = hexagonAt(cell.x, cell.y, radius);
        path.moveTo(corners[10], corners[11]);
        for (let k = 0; k < 3; k++) path.lineTo(corners[k * 2], corners[k * 2 + 1]);
      }
    } else {
      for (let i = Math.floor((-reach - ox) / s); i * s + ox < reach; i++) {
        path.moveTo(i * s + ox, -reach);
        path.lineTo(i * s + ox, reach);
      }
      for (let j = Math.floor((-reach - oy) / s); j * s + oy < reach; j++) {
        path.moveTo(-reach, j * s + oy);
        path.lineTo(reach, j * s + oy);
      }
    }
    ctx.strokeStyle = hexOf(lineColour);
    ctx.lineWidth = line;
    ctx.stroke(path);
  }

  /**
   * A floor of lines in perspective, below a horizon through the layer's
   * position: a camera above a flat grid, looking along it. Across the
   * picture's foot the cells are `s` wide and the lines `line`; further off
   * both shrink towards the vanishing point, so the distance does not pile
   * up into a band, and they fade as they go. Scrolling brings it towards the
   * viewer. Perspective is how far off the foot of the picture is, against
   * the camera's height: more is flatter.
   */
  #floor(params: ResolvedParams, s: number, line: number, colour: Colour | null, travelled: number, scale: number) {
    if (!colour || line <= 0) return;
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    // The camera's height is the distance down to the picture's foot, so that the nearest line is there.
    const h = Math.max(s, (height - (num(params, 'y') / 100) * height) / scale);
    const f = h * Math.max(0.05, num(params, 'perspective'));
    const fade = Math.min(1, Math.max(0, num(params, 'fade')));
    const reach = Math.hypot(width, height) / scale;
    /** The colour as seen at this height below the horizon: fading towards it. */
    const seen = (y: number) => hexOf({ ...colour, a: colour.a * (1 - fade * (1 - Math.min(1, y / h))) });
    // Across: one line every cell of depth, from the foot of the picture to where they are under a pixel apart.
    // Its width shrinks with the distance; under a pixel wide, it fades instead.
    const phase = ((travelled % s) + s) % s;
    const alpha = ctx.globalAlpha;
    for (let k = -1; k < 4000; k++) {
      const z = f + k * s - phase;
      if (z <= 0) continue;
      const y = (f * h) / z;
      if (y > h + line) continue;
      if (y < 0.5) break;
      const width = (line * y) / h;
      ctx.lineWidth = Math.max(1, width);
      ctx.globalAlpha = alpha * Math.min(1, width);
      ctx.strokeStyle = seen(y);
      ctx.beginPath();
      ctx.moveTo(-reach, y);
      ctx.lineTo(reach, y);
      ctx.stroke();
    }
    ctx.globalAlpha = alpha;
    // Along: wedges from past the foot of the picture to a point at the vanishing point, narrowing and fading on the way.
    const along = ctx.createLinearGradient(0, 0, 0, h);
    along.addColorStop(0, seen(0));
    along.addColorStop(1, seen(h));
    ctx.fillStyle = along;
    const path = new Path2D();
    const count = Math.min(2000, Math.ceil((reach * 4) / s));
    const far = Math.max(h + line, reach);
    const wide = (line * far) / h / 2;
    for (let k = -count; k <= count; k++) {
      // At the foot a line is where it lies on the floor; further down, past the picture, wider in proportion.
      const x = k * s * (far / h);
      path.moveTo(x - wide, far);
      path.lineTo(x + wide, far);
      path.lineTo(0, 0);
      path.closePath();
    }
    ctx.fill(path);
  }

  /**
   * Mosaic: the picture beneath in cells (cells.ts), each the colour under
   * it. The colours come from the picture made small, a pixel to a cell, so
   * that each is the average of its cell; squares that are not turned are
   * that small picture made large again, a block to a pixel.
   */
  #mosaic(params: ResolvedParams) {
    const { width, height } = this.#canvas;
    const s = Math.max(2, (num(params, 'size') / 100) * this.#unit);
    const [ox, oy] = [(num(params, 'x') / 100) * width, (num(params, 'y') / 100) * height];
    const turn = (num(params, 'rotation') * Math.PI) / 180;
    const shape = str(params, 'cells');
    const gap = Math.min(0.9, Math.max(0, num(params, 'gap')));
    const rounding = Math.max(0, num(params, 'rounding') / 100);
    const levels = str(params, 'colours') === 'fewer colours' ? Math.max(2, num(params, 'levels')) : 0;
    // The small picture: a pixel for each cell of the grid through the layer's position.
    const [x0, y0] = [ox - Math.ceil(ox / s) * s, oy - Math.ceil(oy / s) * s];
    const [gw, gh] = [Math.ceil((width - x0) / s) + 1, Math.ceil((height - y0) / s) + 1];
    const small = this.#extraCanvas(14, gw, gh);
    const sc = small.getContext('2d', { willReadFrequently: true })!;
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.globalCompositeOperation = 'copy';
    sc.imageSmoothingEnabled = true;
    sc.imageSmoothingQuality = 'high';
    sc.drawImage(this.#surface, 0, 0, width, height, -x0 / s, -y0 / s, width / s, height / s);
    const averages = sc.getImageData(0, 0, gw, gh);
    const data = averages.data;
    // A cell over the picture's edge was averaged with what is past it, which is nothing, and came out partly see-through.
    // Mostly on the picture, as much of it as lies there counts for all of it; mostly off it (where shrinking the picture
    // may have left nothing at all), it takes the average of its neighbour further in.
    const inside = (start: number, size: number) => Math.max(0, Math.min(1, (Math.min(size, start + s) - Math.max(0, start)) / s));
    const copy = (to: number, from: number) => { for (let c = 0; c < 4; c++) data[to * 4 + c] = data[from * 4 + c]; };
    for (let i = 0; i < gw; i++) {
      const covered = inside(x0 + i * s, width);
      for (let j = 0; j < gh; j++) {
        if (covered >= 0.5) data[(j * gw + i) * 4 + 3] = Math.min(255, data[(j * gw + i) * 4 + 3] / covered);
      }
    }
    for (let j = 0; j < gh; j++) {
      const covered = inside(y0 + j * s, height);
      for (let i = 0; i < gw; i++) {
        if (covered >= 0.5 && covered < 1) data[(j * gw + i) * 4 + 3] = Math.min(255, data[(j * gw + i) * 4 + 3] / covered);
      }
    }
    // Mostly off the picture: from the edge inwards on the left and the top, outwards on the right and the bottom, so the copies carry on.
    for (let i = gw - 1; i >= 0; i--) if (x0 + i * s + s / 2 < 0) for (let j = 0; j < gh; j++) copy(j * gw + i, j * gw + i + 1);
    for (let i = 0; i < gw; i++) if (x0 + i * s + s / 2 > width) for (let j = 0; j < gh; j++) copy(j * gw + i, j * gw + i - 1);
    for (let j = gh - 1; j >= 0; j--) if (y0 + j * s + s / 2 < 0) for (let i = 0; i < gw; i++) copy(j * gw + i, (j + 1) * gw + i);
    for (let j = 0; j < gh; j++) if (y0 + j * s + s / 2 > height) for (let i = 0; i < gw; i++) copy(j * gw + i, (j - 1) * gw + i);
    if (levels) for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = fewer(data[i + c] / 255, levels) * 255;
    const out = this.#extraCanvas(0);
    const o = out.getContext('2d')!;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.globalCompositeOperation = 'source-over';
    o.globalAlpha = 1;
    o.filter = 'none';
    o.clearRect(0, 0, width, height);
    if (shape === 'squares' && turn === 0 && gap === 0 && rounding === 0) {
      // Each average a block of the cell's size: the small picture made large, without smoothing.
      sc.putImageData(averages, 0, 0);
      o.imageSmoothingEnabled = false;
      o.drawImage(small, x0, y0, gw * s, gh * s);
      o.imageSmoothingEnabled = true;
      return this.#putBack(out);
    }
    const gapColour = col(params, 'gapColour');
    if (gapColour) {
      o.fillStyle = hexOf(gapColour);
      o.fillRect(0, 0, width, height);
    }
    // The cells are laid out turned about the layer's position; the region they cover, in their own turned frame.
    const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
    const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => [cos * (x - ox) + sin * (y - oy), -sin * (x - ox) + cos * (y - oy)]);
    const region: Region = [
      Math.min(...corners.map((c) => c[0])) - s, Math.min(...corners.map((c) => c[1])) - s,
      Math.max(...corners.map((c) => c[0])) + s, Math.max(...corners.map((c) => c[1])) + s,
    ];
    o.setTransform(cos, sin, -sin, cos, ox, oy);
    const cells = shape === 'hexagons' ? hexCells(s, 0, 0, region) : shape === 'triangles' ? triangleCells(s, 0, 0, region) : squareCells(s, 0, 0, region);
    // Cells that touch, drawn each on its own, would show hairlines of what is between at their edges: with no gap, each is outlined in its own colour too.
    o.lineWidth = 1;
    o.lineJoin = 'round';
    for (const cell of cells) {
      // The average under the cell's middle, as it lies on the picture; for a cell whose middle is past the edge, the nearest on it.
      const px = Math.min(width - 0.5, Math.max(0.5, ox + cos * cell.x - sin * cell.y));
      const py = Math.min(height - 0.5, Math.max(0.5, oy + sin * cell.x + cos * cell.y));
      const i = Math.round((px - x0) / s - 0.5);
      const j = Math.round((py - y0) / s - 0.5);
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const k = (j * gw + i) * 4;
      if (data[k + 3] === 0) continue;
      const style = `rgba(${data[k]}, ${data[k + 1]}, ${data[k + 2]}, ${(data[k + 3] / 255).toFixed(3)})`;
      o.fillStyle = style;
      o.beginPath();
      if (shape === 'circles' || shape === 'halftone') {
        // A halftone dot's area follows the brightness under it.
        const bright = shape === 'halftone' ? Math.sqrt(brightnessOf(data[k], data[k + 1], data[k + 2]) / 255) : 1;
        const radius = (s / 2) * (1 - gap) * bright;
        if (radius < 0.3) continue;
        o.arc(cell.x, cell.y, radius, 0, Math.PI * 2);
      } else if (shape === 'hexagons') {
        addPolygon(o, hexagonAt(cell.x, cell.y, hexRadius(s) * (1 - gap)));
      } else if (shape === 'triangles') {
        const corners = triangleAt(cell, s);
        addPolygon(o, corners.map((v, n) => (n % 2 === 0 ? cell.x : cell.y) + (v - (n % 2 === 0 ? cell.x : cell.y)) * (1 - gap)));
      } else {
        const side = s * (1 - gap);
        o.roundRect(cell.x - side / 2, cell.y - side / 2, side, side, rounding * side);
      }
      o.fill();
      if (gap === 0 && shape !== 'circles' && shape !== 'halftone') {
        o.strokeStyle = style;
        o.stroke();
      }
    }
    o.setTransform(1, 0, 0, 1, 0, 0);
    this.#putBack(out);
  }

  #noiseGl: NoiseGl | null | undefined;

  /**
   * A pattern of noise.ts over the whole picture: its middle at the layer's
   * position, its features `size` of the short side across, turned with the
   * layer; drawn on the graphics card, or else on the processor.
   */
  #noise(params: ResolvedParams, frame: Frame) {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    const size = Math.max(1e-3, (num(params, 'size') / 100) * this.#unit * (num(params, 'scale') / 100));
    const turn = (num(params, 'rotation') * Math.PI) / 180;
    const [cos, sin] = [Math.cos(turn) / size, Math.sin(turn) / size];
    // Drifting moves its middle across the picture, so the pattern goes the way the direction says, at its speed.
    const way = (num(params, 'direction') * Math.PI) / 180;
    const travelled = (num(params, 'drift') / 100) * this.#unit * frame.seconds;
    // The gradient as a table of 256 colours, by the pattern's value, as a gradient map has it.
    const table = gradientMapTable(stopsIn(params), { shift: 0, hueShift: 0, low: 0, high: 1, wheel: wheelIn(params) });
    if (!table) return;
    const look: NoiseLook = {
      origin: [(num(params, 'x') / 100) * width + Math.cos(way) * travelled, (num(params, 'y') / 100) * height + Math.sin(way) * travelled],
      axes: [cos, -sin, sin, cos],
      time: num(params, 'evolve') * frame.seconds,
      options: { kind: str(params, 'kind'), detail: num(params, 'detail'), roughness: num(params, 'roughness'), warp: num(params, 'warp'), seed: num(params, 'seed') },
      coverage: num(params, 'coverage'),
      softness: num(params, 'softness'),
      table,
    };
    if (this.#noiseGl === undefined) this.#noiseGl = NoiseGl.make();
    const picture = this.#noiseGl?.draw(width, height, look) ?? this.#noiseOnProcessor(look);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(picture, 0, 0, width, height);
    ctx.restore();
  }

  /**
   * The same pattern without a graphics card: worked out at a quarter of the
   * size each way, and enlarged, as every pixel would take far too long.
   */
  #noiseOnProcessor(look: NoiseLook): OffscreenCanvas {
    const { width, height } = this.#canvas;
    const step = 4;
    const [w, h] = [Math.max(1, Math.ceil(width / step)), Math.max(1, Math.ceil(height / step))];
    const out = this.#extraCanvas(0, w, h);
    const o = out.getContext('2d')!;
    const image = o.createImageData(w, h);
    const [a, b, c, d] = look.axes;
    const table = look.table;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // The middle of the block of pixels this one stands for, as the card takes the middle of each.
        const vx = (x + 0.5) * step - look.origin[0];
        const vy = (y + 0.5) * step - look.origin[1];
        const value = covered(noiseValue(a * vx + c * vy, b * vx + d * vy, look.time, look.options), look.coverage, look.softness);
        // Between the table's two nearest entries, as the card reads it; the table is not premultiplied, as the canvas takes it.
        const at = value * 255;
        const k = Math.min(254, Math.floor(at));
        const f = at - k;
        const i = (y * w + x) * 4;
        for (let ch = 0; ch < 4; ch++) image.data[i + ch] = table[k * 4 + ch] * (1 - f) + table[(k + 1) * 4 + ch] * f;
      }
    }
    o.putImageData(image, 0, 0);
    return out;
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

  #gradientMapGl: GradientMapGl | null | undefined;

  /** Gradient map: each pixel of the picture beneath recoloured by its brightness, from a table made for this frame. */
  #gradientMap(params: ResolvedParams) {
    const stops = stopsOf((n) => col(params, `colour${n}`), (n) => num(params, `position${n}`));
    const table = gradientMapTable(stops, { shift: num(params, 'shift'), hueShift: num(params, 'hueShift'), low: num(params, 'low'), high: num(params, 'high'), wheel: wheelIn(params) });
    if (!table) return;
    this.#putBack(this.#recoloured(this.#surface, table));
  }

  /**
   * A picture with each pixel recoloured by its brightness, from a table of
   * 256 colours (gradient-map.ts), on the graphics card or else on the
   * processor. The canvas it comes back on is shared: use it before another
   * recolouring.
   */
  #recoloured(source: Canvas, table: Uint8ClampedArray): OffscreenCanvas {
    const { width, height } = this.#canvas;
    if (this.#gradientMapGl === undefined) this.#gradientMapGl = GradientMapGl.make();
    const result = this.#gradientMapGl?.apply(source, table, width, height);
    if (result) return result;
    // On the processor: slower, the same colours.
    const out = this.#extraCanvas(0);
    const o = out.getContext('2d')!;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.globalCompositeOperation = 'copy';
    o.globalAlpha = 1;
    o.filter = 'none';
    o.drawImage(source, 0, 0);
    const pixels = o.getImageData(0, 0, width, height);
    const data = pixels.data;
    for (let i = 0; i < data.length; i += 4) {
      // Between the table's two nearest entries, as the card reads it.
      const at = brightnessOf(data[i], data[i + 1], data[i + 2]);
      const k = Math.min(254, Math.floor(at));
      const f = at - k;
      for (let c = 0; c < 4; c++) {
        const v = table[k * 4 + c] * (1 - f) + table[(k + 1) * 4 + c] * f;
        data[i + c] = c === 3 ? (v * data[i + 3]) / 255 : v;
      }
    }
    o.putImageData(pixels, 0, 0);
    return out;
  }

  #displaceGl: DisplaceGl | null | undefined;

  /** Displace: each pixel of the picture beneath read from a little way off, as displace.ts says; on the graphics card, or else on the processor. */
  #displace(params: ResolvedParams, frame: Frame) {
    const { width, height } = this.#canvas;
    const unit = this.#unit;
    const speed = num(params, 'speed');
    const displacement: Displacement = {
      mode: str(params, 'mode'),
      amount: (num(params, 'amount') / 100) * unit,
      twist: (num(params, 'twist') * Math.PI) / 180,
      size: Math.max(1, (num(params, 'size') / 100) * unit),
      radius: Math.max(1, (num(params, 'radius') / 100) * unit),
      direction: (num(params, 'direction') * Math.PI) / 180,
      time: speed * frame.seconds,
      noise: { kind: str(params, 'kind'), detail: num(params, 'detail'), roughness: 0.5, warp: 0, seed: num(params, 'seed') },
      ...(params.hold === true ? { hold: { width, height, margin: (Math.max(0, num(params, 'holdMargin')) / 100) * unit } } : {}),
    };
    const middle: [number, number] = [(num(params, 'x') / 100) * width, (num(params, 'y') / 100) * height];
    const split = Math.max(0, num(params, 'split'));
    // Held, nothing is read past the edges but what a colour split reaches, which the edge pixels give.
    const edges = displacement.hold ? 'extend' : str(params, 'edges');
    if (this.#displaceGl === undefined) this.#displaceGl = DisplaceGl.make();
    const result = this.#displaceGl?.apply(this.#surface, width, height, displacement, middle, split, edges)
      ?? this.#displaceOnProcessor(displacement, middle, split, edges);
    this.#putBack(result);
  }

  /**
   * The same without a graphics card: the offsets worked out every fourth
   * pixel each way and filled in between (they change smoothly), and each
   * pixel then read from the picture, between its pixels.
   */
  #displaceOnProcessor(d: Displacement, middle: [number, number], split: number, edges: string): OffscreenCanvas {
    const { width, height } = this.#canvas;
    const source = this.#copyOfPicture().getContext('2d')!.getImageData(0, 0, width, height).data;
    const step = 4;
    const [gw, gh] = [Math.ceil(width / step) + 1, Math.ceil(height / step) + 1];
    const grid = new Float32Array(gw * gh * 2);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const [dx, dy] = displacementAt(i * step + 0.5, j * step + 0.5, middle[0], middle[1], d);
        grid[(j * gw + i) * 2] = dx;
        grid[(j * gw + i) * 2 + 1] = dy;
      }
    }
    /** Where (x, y) falls when it lies past the edges, as the choice says; null for nothing there. */
    const place = (v: number, size: number): number | null => {
      if (v >= 0 && v <= size - 1) return v;
      if (edges === 'none') return null;
      if (edges === 'repeat') return ((v % size) + size) % size;
      if (edges === 'mirror') {
        const m = ((v % (2 * size)) + 2 * size) % (2 * size);
        return m < size ? m : 2 * size - 1 - m;
      }
      return Math.min(size - 1, Math.max(0, v));
    };
    // Read between pixels, premultiplied, so that see-through edges do not darken.
    const sample = (x: number, y: number, into: number[]) => {
      const px = place(x - 0.5, width);
      const py = place(y - 0.5, height);
      if (px === null || py === null) return into.fill(0);
      const [x0, y0] = [Math.floor(px), Math.floor(py)];
      const [x1, y1] = [Math.min(width - 1, x0 + 1), Math.min(height - 1, y0 + 1)];
      const [fx, fy] = [px - x0, py - y0];
      into.fill(0);
      for (const [xx, yy, w] of [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]]) {
        const k = (yy * width + xx) * 4;
        const a = source[k + 3] / 255;
        into[0] += source[k] * a * w;
        into[1] += source[k + 1] * a * w;
        into[2] += source[k + 2] * a * w;
        into[3] += a * w;
      }
      return into;
    };
    const out = this.#extraCanvas(0);
    const o = out.getContext('2d')!;
    const image = o.createImageData(width, height);
    const [c, red, blue] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (let y = 0; y < height; y++) {
      const gy = y / step;
      const j = Math.min(gh - 2, Math.floor(gy));
      const fy = gy - j;
      for (let x = 0; x < width; x++) {
        const gx = x / step;
        const i = Math.min(gw - 2, Math.floor(gx));
        const fx = gx - i;
        const at = (ii: number, jj: number, k: number) => grid[(jj * gw + ii) * 2 + k];
        const off = (k: number) => (at(i, j, k) * (1 - fx) + at(i + 1, j, k) * fx) * (1 - fy) + (at(i, j + 1, k) * (1 - fx) + at(i + 1, j + 1, k) * fx) * fy;
        const [dx, dy] = [off(0), off(1)];
        const [sx, sy] = [x + 0.5 + dx, y + 0.5 + dy];
        sample(sx, sy, c);
        if (split > 0) {
          sample(x + 0.5 + dx * (1 + split), y + 0.5 + dy * (1 + split), red);
          sample(x + 0.5 + dx * (1 - split), y + 0.5 + dy * (1 - split), blue);
          c[0] = red[0];
          c[2] = blue[2];
          c[3] = Math.max(c[3], red[3], blue[3]);
        }
        const k = (y * width + x) * 4;
        const a = c[3];
        image.data[k] = a > 0 ? c[0] / a : 0;
        image.data[k + 1] = a > 0 ? c[1] / a : 0;
        image.data[k + 2] = a > 0 ? c[2] / a : 0;
        image.data[k + 3] = a * 255;
      }
    }
    o.putImageData(image, 0, 0);
    return out;
  }

  /** The graphics card's way of applying LUTs; null where WebGL 2 is not to be had, and the processor does it. */
  #lutGl: LutGl | null | undefined;

  /** The picture beneath, through a colour lookup table. */
  #lut(params: ResolvedParams, frame: Frame) {
    const lut = frame.luts?.get(str(params, 'lut'));
    if (lut) this.#throughLut(lut);
  }

  /** White balances' LUTs, by their scalings, so that one that holds still is made, and sent to the graphics card, once. */
  #balances = new Map<string, Lut>();

  /** White balance: each of red, green and blue of the picture beneath scaled, through a LUT that does just that. */
  #whiteBalance(params: ResolvedParams) {
    const temperature = num(params, 'temperature');
    const tint = num(params, 'tint');
    if (temperature === 0 && tint === 0) return;
    const gains = whiteBalance(temperature, tint);
    const key = gains.map((gain) => gain.toFixed(4)).join();
    let lut = this.#balances.get(key);
    if (!lut) {
      // One following the music is new each frame: only the last few are kept.
      if (this.#balances.size >= 16) this.#balances.clear();
      lut = scalingLut(gains);
      this.#balances.set(key, lut);
    }
    this.#throughLut(lut);
  }

  /** The picture beneath through a LUT: on the graphics card, or else on the processor. */
  #throughLut(lut: Lut) {
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

/** Adds a closed polygon, as x, y pairs, to a path or a context's path. */
function addPolygon(path: Path2D | Context, points: number[]) {
  path.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) path.lineTo(points[i], points[i + 1]);
  path.closePath();
}

/** A canvas of its own for drawing on the graphics card, as the picture's canvas keeps colours: premultiplied. */
function glCanvas(): [OffscreenCanvas, WebGL2RenderingContext] {
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('No WebGL 2');
  return [canvas, gl];
}

/** A program that runs this fragment shader over every pixel: one triangle over the whole picture, made from the vertex's number alone. */
function glProgram(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const shader = (type: number, source: string) => {
    const made = gl.createShader(type)!;
    gl.shaderSource(made, source);
    gl.compileShader(made);
    if (!gl.getShaderParameter(made, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(made) ?? 'Shader');
    return made;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
    void main() {
      vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Program');
  return program;
}

/**
 * Draws noise layers' patterns on the graphics card (see noise.ts), on a
 * canvas of its own, the size of the picture.
 */
class NoiseGl {
  readonly #canvas: OffscreenCanvas;
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #table: WebGLTexture;
  readonly #uniforms = new Map<string, WebGLUniformLocation | null>();

  static make(): NoiseGl | null {
    try {
      return typeof OffscreenCanvas === 'undefined' ? null : new NoiseGl();
    } catch {
      return null;
    }
  }

  constructor() {
    [this.#canvas, this.#gl] = glCanvas();
    const gl = this.#gl;
    this.#program = glProgram(gl, NOISE_SHADER);
    // The gradient's table, read between its entries.
    this.#table = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.#table);
    for (const [name, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
      gl.texParameteri(gl.TEXTURE_2D, name, value);
    }
  }

  #at(name: string): WebGLUniformLocation | null {
    if (!this.#uniforms.has(name)) this.#uniforms.set(name, this.#gl.getUniformLocation(this.#program, name));
    return this.#uniforms.get(name)!;
  }

  /** The pattern, on this class's canvas; null if the card could not draw it. */
  draw(width: number, height: number, look: NoiseLook): OffscreenCanvas | null {
    const gl = this.#gl;
    if (gl.isContextLost()) return null;
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.#program);
    gl.uniform1f(this.#at('height'), height);
    gl.uniform2f(this.#at('origin'), look.origin[0], look.origin[1]);
    gl.uniformMatrix2fv(this.#at('axes'), false, look.axes);
    gl.uniform1f(this.#at('time'), look.time);
    gl.uniform1i(this.#at('kind'), kindNumber(look.options.kind));
    gl.uniform1i(this.#at('octaves'), Math.max(1, Math.min(8, Math.round(look.options.detail))));
    gl.uniform1f(this.#at('roughness'), Math.min(1, Math.max(0, look.options.roughness)));
    gl.uniform1f(this.#at('warp'), Math.max(0, look.options.warp));
    gl.uniform1ui(this.#at('seed'), seedBits(look.options.seed));
    gl.uniform1f(this.#at('coverage'), look.coverage);
    gl.uniform1f(this.#at('softness'), look.softness);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#table);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(look.table.buffer, look.table.byteOffset, look.table.byteLength));
    gl.uniform1i(this.#at('table'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return gl.getError() === gl.NO_ERROR ? this.#canvas : null;
  }
}

/** Recolours the picture by its brightness on the graphics card, from a table of 256 colours (gradient-map.ts). */
class GradientMapGl {
  readonly #canvas: OffscreenCanvas;
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #picture: WebGLTexture;
  readonly #table: WebGLTexture;

  static make(): GradientMapGl | null {
    try {
      return typeof OffscreenCanvas === 'undefined' ? null : new GradientMapGl();
    } catch {
      return null;
    }
  }

  constructor() {
    [this.#canvas, this.#gl] = glCanvas();
    const gl = this.#gl;
    // The picture's pixels are read as they are, not premultiplied, and written back premultiplied, as the canvas keeps them.
    // A brightness of 0 or 1 lands on the middle of the table's first or last entry, as the processor reads it.
    this.#program = glProgram(gl, `#version 300 es
      precision highp float;
      uniform sampler2D picture;
      uniform sampler2D table;
      out vec4 colour;
      void main() {
        ivec2 at = ivec2(gl_FragCoord.xy);
        at.y = textureSize(picture, 0).y - 1 - at.y;
        vec4 c = texelFetch(picture, at, 0);
        float b = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        vec4 m = texture(table, vec2((b * 255.0 + 0.5) / 256.0, 0.5));
        float a = m.a * c.a;
        colour = vec4(m.rgb * a, a);
      }`);
    // The picture read pixel by pixel; the table between its entries. Without filters set, a texture reads as black.
    this.#picture = gl.createTexture()!;
    this.#table = gl.createTexture()!;
    for (const [texture, filter] of [[this.#picture, gl.NEAREST], [this.#table, gl.LINEAR]] as const) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const [name, value] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
        gl.texParameteri(gl.TEXTURE_2D, name, value);
      }
    }
  }

  /** The picture recoloured, on this class's canvas; null if the card could not do it. */
  apply(source: Canvas, table: Uint8ClampedArray, width: number, height: number): OffscreenCanvas | null {
    const gl = this.#gl;
    if (gl.isContextLost()) return null;
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.#program);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.#table);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(table.buffer, table.byteOffset, table.byteLength));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#picture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1i(gl.getUniformLocation(this.#program, 'picture'), 0);
    gl.uniform1i(gl.getUniformLocation(this.#program, 'table'), 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return gl.getError() === gl.NO_ERROR ? this.#canvas : null;
  }
}

/** Moves the picture about on the graphics card, as displace.ts says, onto a canvas of its own. */
class DisplaceGl {
  readonly #canvas: OffscreenCanvas;
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #picture: WebGLTexture;
  readonly #uniforms = new Map<string, WebGLUniformLocation | null>();

  static make(): DisplaceGl | null {
    try {
      return typeof OffscreenCanvas === 'undefined' ? null : new DisplaceGl();
    } catch {
      return null;
    }
  }

  constructor() {
    [this.#canvas, this.#gl] = glCanvas();
    this.#program = glProgram(this.#gl, DISPLACE_SHADER);
    this.#picture = this.#gl.createTexture()!;
  }

  #at(name: string): WebGLUniformLocation | null {
    if (!this.#uniforms.has(name)) this.#uniforms.set(name, this.#gl.getUniformLocation(this.#program, name));
    return this.#uniforms.get(name)!;
  }

  /** The picture moved about, on this class's canvas; null if the card could not do it. */
  apply(source: Canvas, width: number, height: number, d: Displacement, middle: [number, number], split: number, edges: string): OffscreenCanvas | null {
    const gl = this.#gl;
    if (gl.isContextLost()) return null;
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.#program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#picture);
    // Premultiplied, as the canvas keeps it, so that reading between a see-through pixel and another does not darken.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // Past the edges, the card's own wrapping: drawn out, repeated or mirrored; "none" is cut off in the shader.
    const wrap = edges === 'repeat' ? gl.REPEAT : edges === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(this.#at('picture'), 0);
    gl.uniform2f(this.#at('size'), width, height);
    gl.uniform2f(this.#at('middle'), middle[0], middle[1]);
    gl.uniform1i(this.#at('mode'), modeNumber(d.mode));
    gl.uniform1f(this.#at('amount'), d.amount);
    gl.uniform1f(this.#at('twist'), d.twist);
    gl.uniform1f(this.#at('scale'), d.size);
    gl.uniform1f(this.#at('radius'), d.radius);
    gl.uniform2f(this.#at('direction'), Math.cos(d.direction), Math.sin(d.direction));
    gl.uniform1f(this.#at('time'), d.time);
    gl.uniform1f(this.#at('split'), split);
    gl.uniform1i(this.#at('edges'), edges === 'none' ? 0 : 1);
    gl.uniform1f(this.#at('hold'), d.hold ? d.hold.margin : -1);
    gl.uniform1i(this.#at('kind'), kindNumber(d.noise.kind));
    gl.uniform1i(this.#at('octaves'), Math.max(1, Math.min(8, Math.round(d.noise.detail))));
    gl.uniform1f(this.#at('roughness'), d.noise.roughness);
    gl.uniform1f(this.#at('warp'), d.noise.warp);
    gl.uniform1ui(this.#at('seed'), seedBits(d.noise.seed));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return gl.getError() === gl.NO_ERROR ? this.#canvas : null;
  }
}

/** Everything a noise layer's pattern is drawn from, for the card or the processor alike. */
interface NoiseLook {
  /** The pattern's middle, in pixels. */
  origin: [number, number];
  /** From pixels to the pattern's units, sized and turned: a 2×2 matrix, column by column, as the card takes it. */
  axes: [number, number, number, number];
  time: number;
  options: NoiseOptions;
  coverage: number;
  softness: number;
  /** The gradient's 256 colours by value, not premultiplied (gradientMapTable). */
  table: Uint8ClampedArray;
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
    [this.#canvas, this.#gl] = glCanvas();
    const gl = this.#gl;
    // The picture's pixels are read as they are, not premultiplied, and written back premultiplied, as the canvas keeps them.
    // A point's value is at the middle of its texel, so 0 and 1 land on the first and the last point exactly.
    const program = glProgram(gl, `#version 300 es
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
      }`);
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
