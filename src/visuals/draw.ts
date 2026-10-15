// Draws a frame of a template on a 2D canvas: the same code for the preview in
// the visuals window and for every frame of a video export. Everything a
// frame shows follows from the moment in the mix and what the music gives
// there, so any frame can be drawn on its own, in any order, and comes out
// the same. The exceptions remember a little from the frame before (the rise
// and fall of the spectrum, a text changing); `reset` forgets it after a jump.
//
// Kept free of Node imports; it runs in a window.

import { fromHsl, mixColours, turnHue, type Colour } from './colour.ts';
import { BAND_COUNT, HIGHEST_HZ, LOWEST_HZ } from '../features.ts';
import type { Values } from './expression.ts';
import { fontStack } from './fonts.ts';
import { hexOf, type PreparedLayer, type ResolvedParams, type TextValues } from './template.ts';

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** What a frame is drawn from, besides the template. */
export interface Frame {
  /** Seconds into the mix, and since the frame before. */
  seconds: number;
  dt: number;
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
}

/** What a layer remembers from frame to frame. */
interface Memory {
  bars?: Float32Array;
  peaks?: Float32Array;
  shown?: string;
  previous?: string;
  /** How far the change from `previous` to `shown` has got, 0 to 1. */
  changing?: number;
}

const BLENDS: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over', add: 'lighter', screen: 'screen', multiply: 'multiply', overlay: 'overlay', difference: 'difference',
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
  readonly #ctx: Context;
  /** Scratch canvases for effects and images, kept between frames. */
  #scratch: OffscreenCanvas | null = null;
  #memories: Memory[] = [];
  /** Particle pictures, drawn once per shape, colour and size. */
  readonly #sprites = new Map<string, OffscreenCanvas>();

  constructor(canvas: Canvas) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d') as Context;
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

    layers.forEach((layer, index) => {
      const params = layer.resolve(frame.music, frame.text);
      if (params.visible === false) return;
      const appear = this.#appearance(params, frame);
      const opacity = (num(params, 'opacity') / 100) * appear;
      if (opacity <= 0) return;
      const memory = (this.#memories[index] ??= {});
      ctx.save();
      ctx.globalAlpha = Math.min(1, opacity);
      ctx.globalCompositeOperation = BLENDS[str(params, 'blend')] ?? 'source-over';
      switch (layer.type) {
        case 'gradient': this.#gradient(params, frame); break;
        case 'particles': this.#particles(params, frame); break;
        case 'image': this.#image(params, frame); break;
        case 'text': this.#text(params, frame, memory); break;
        case 'spectrum': this.#spectrum(params, frame, memory); break;
        case 'waveform': this.#waveform(params, frame); break;
        case 'glow': this.#glow(params, opacity); break;
      }
      ctx.restore();
    });
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

  #scratchCanvas(): OffscreenCanvas {
    const { width, height } = this.#canvas;
    if (!this.#scratch || this.#scratch.width !== width || this.#scratch.height !== height) this.#scratch = new OffscreenCanvas(width, height);
    return this.#scratch;
  }

  // -------------------------------------------------------------------------
  // Layers

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
    const speed = (num(params, 'speed') / 100) * height;
    const direction = (num(params, 'direction') * Math.PI) / 180;
    const spread = (num(params, 'spread') * Math.PI) / 180;
    const turbulence = (num(params, 'turbulence') / 100) * height * 0.2;
    const twinkle = num(params, 'twinkle');
    const depth = num(params, 'twinkleDepth') / 100;
    const sizeLow = (num(params, 'sizeLow') / 100) * height;
    const sizeHigh = (num(params, 'sizeHigh') / 100) * height;
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
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    let w = (num(params, 'width') / 100) * width;
    let h = (num(params, 'height') / 100) * height;
    const fit = str(params, 'fit');
    const ratio = picture.width / picture.height;
    if (fit === 'natural') [w, h] = [picture.width, picture.height];
    else if (fit === 'contain') [w, h] = w / h > ratio ? [h * ratio, h] : [w, w / ratio];
    else if (fit === 'cover') [w, h] = w / h > ratio ? [w, w / ratio] : [h * ratio, h];
    this.#place(params);
    const [left, top] = anchored(str(params, 'anchor'), 0, 0, w, h);

    // Drawn on its own first, so that tint and rounding touch the picture only.
    const scratch = this.#scratchCanvas();
    const s = scratch.getContext('2d')!;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.clearRect(0, 0, scratch.width, scratch.height);
    const pw = Math.min(scratch.width, Math.ceil(w));
    const ph = Math.min(scratch.height, Math.ceil(h));
    s.filter = `brightness(${num(params, 'brightness')}%) saturate(${num(params, 'saturation')}%)`;
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
    const tint = col(params, 'tint');
    const tintAmount = num(params, 'tintAmount') / 100;
    if (tint && tintAmount > 0) {
      s.globalCompositeOperation = 'source-atop';
      s.globalAlpha = tintAmount;
      s.fillStyle = hexOf(tint);
      s.fillRect(0, 0, pw, ph);
      s.globalAlpha = 1;
    }
    const shadow = col(params, 'shadowColour');
    const blur = (num(params, 'shadowBlur') / 100) * height;
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
    // It moves on with the time between frames rather than the time in the mix,
    // so that a name typed in while the music is paused still fades in.
    if (memory.shown === undefined) memory.shown = text;
    if (text !== memory.shown) {
      memory.previous = memory.shown;
      memory.shown = text;
      memory.changing = 0;
    }
    const takes = num(params, 'changeSeconds');
    const change = str(params, 'change');
    if (memory.changing !== undefined) memory.changing = takes > 0 ? Math.min(1, memory.changing + frame.dt / takes) : 1;
    const progress = memory.changing === undefined || change === 'cut' ? 1 : memory.changing;

    const size = (num(params, 'size') / 100) * height;
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
      const x = ctx.textAlign === 'left' ? left : ctx.textAlign === 'right' ? left + blockWidth : left + blockWidth / 2;
      const opacity = ctx.globalAlpha;
      ctx.globalAlpha = opacity * alpha;
      const box = col(params, 'boxColour');
      if (box) {
        const pad = (num(params, 'boxPadding') / 100) * height;
        ctx.fillStyle = hexOf(box);
        ctx.beginPath();
        ctx.roundRect(left - pad, top + offset - pad, blockWidth + pad * 2, blockHeight + pad * 2, pad * 0.6);
        ctx.fill();
      }
      const shadow = col(params, 'shadowColour');
      const blur = (num(params, 'shadowBlur') / 100) * height;
      ctx.shadowColor = shadow && blur > 0 ? hexOf(shadow) : 'transparent';
      ctx.shadowBlur = blur;
      const outline = (num(params, 'outlineWidth') / 100) * height;
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
      const radius = (num(params, 'radius') / 100) * height;
      const step = (Math.PI * 2) / bars;
      ctx.lineCap = rounded ? 'round' : 'butt';
      for (let i = 0; i < bars; i++) {
        const value = memory.bars[i];
        const angle = i * step - Math.PI / 2;
        const length = Math.max(1, value * h);
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
    ctx.lineWidth = Math.max(1, (num(params, 'lineWidth') / 100) * height);
    ctx.lineJoin = 'round';

    if (str(params, 'form') === 'circle') {
      const radius = (num(params, 'radius') / 100) * height;
      ctx.beginPath();
      for (let p = 0; p <= points; p++) {
        const value = levels[p % points];
        const angle = (p / points) * Math.PI * 2 - Math.PI / 2;
        const r = radius + value * h * 0.5;
        if (p === 0) ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
        else ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
      }
      ctx.closePath();
      if (style === 'line') ctx.stroke();
      else ctx.fill();
      return;
    }
    const [left, top] = anchored(str(params, 'anchor'), 0, 0, w, h);
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

  /** Glow: the picture so far, blurred and added onto itself. */
  #glow(params: ResolvedParams, opacity: number) {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    const scratch = this.#scratchCanvas();
    const s = scratch.getContext('2d')!;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'copy';
    s.globalAlpha = 1;
    // Only what is brighter than the threshold glows.
    const threshold = num(params, 'threshold') / 100;
    s.filter = `brightness(${Math.max(0, 1 - threshold) * 100 + 20}%) contrast(${100 + threshold * 300}%) blur(${(num(params, 'radius') / 100) * height}px)`;
    s.drawImage(this.#canvas, 0, 0);
    s.filter = 'none';
    const tint = col(params, 'tint');
    if (tint && hexOf(tint) !== '#ffffff') {
      s.globalCompositeOperation = 'multiply';
      s.fillStyle = hexOf(tint);
      s.fillRect(0, 0, width, height);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, opacity * (num(params, 'strength') / 100));
    ctx.drawImage(scratch, 0, 0);
  }
}
