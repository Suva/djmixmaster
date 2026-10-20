// The app's own colour picker, opened from a colour's swatch. The system's
// picker, which the browser's colour input opens, knows red, green and blue
// only: Chromium turns its opacity off on the Mac, and Windows' has none. So
// this one has it all in one place, as image editors do: a square of
// saturation and brightness, a hue strip, an opacity strip over a
// checkerboard, the hex code (#rrggbb, or #rrggbbaa when see-through), red,
// green and blue 0 to 255 and opacity 0 to 1 as numbers to type or drag,
// and an eyedropper for a colour anywhere on the screen.
//
// One picker serves every swatch; opening it for one closes it for another.
// It changes the colour as it is dragged, as the system's did; a click
// elsewhere or Escape closes it. It is kept in hue, saturation and value
// while open, so that a colour dragged to black or grey keeps its hue.

import { parseHex, toHex, type Colour } from '../../visuals/colour.ts';
import { scrubbableInput } from './scrub.ts';

interface Open {
  anchor: HTMLElement;
  change(hex: string): void;
}

let open: Open | null = null;
/** The colour shown, in hue (degrees), saturation, value and opacity, each 0 to 1. */
let [hue, sat, val, alpha] = [0, 0, 1, 1];
/** The hex code last sent, to tell the swatch's echo of it from a colour changed elsewhere. */
let sent = '';
let parts: ReturnType<typeof build> | null = null;

/** Opens the picker under `anchor` (or above it, where there is no room below), showing `hex`. */
export function openColourPicker(anchor: HTMLElement, hex: string, change: (hex: string) => void) {
  parts ??= build();
  open = { anchor, change };
  setFrom(hex);
  sent = toHex(rgba());
  parts.element.hidden = false;
  place(anchor);
  render();
  window.addEventListener('pointerdown', outside, true);
  window.addEventListener('keydown', keys, true);
  window.addEventListener('scroll', scrolled, true);
  window.addEventListener('resize', closeColourPicker);
}

export function closeColourPicker() {
  if (!open || !parts) return;
  open = null;
  parts.element.hidden = true;
  window.removeEventListener('pointerdown', outside, true);
  window.removeEventListener('keydown', keys, true);
  window.removeEventListener('scroll', scrolled, true);
  window.removeEventListener('resize', closeColourPicker);
}

/** Whether the picker is open for this swatch. */
export const pickerOpenFor = (anchor: HTMLElement) => open?.anchor === anchor;

/** A colour changed elsewhere (undone, say) while the picker is open for this swatch. */
export function colourChanged(anchor: HTMLElement, hex: string) {
  if (open?.anchor !== anchor || hex.toLowerCase() === sent) return;
  setFrom(hex);
  sent = toHex(rgba());
  render();
}

// Hue, saturation and value to red, green and blue, and back.

function rgbOf(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

function setFrom(hex: string) {
  const c = parseHex(hex) ?? { r: 1, g: 1, b: 1, a: 1 };
  setRgb(c.r, c.g, c.b);
  alpha = c.a;
}

function setRgb(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  val = max;
  sat = max > 0 ? d / max : 0;
  // A grey has no hue of its own: the one there was is kept.
  if (d > 0) {
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue = (h * 60 + 360) % 360;
  }
}

const rgba = (): Colour => {
  const [r, g, b] = rgbOf(hue, sat, val);
  return { r, g, b, a: alpha };
};

function send() {
  // Its swatch gone (the settings were made again, by an undo, say), what it was for may be gone too.
  if (open && !open.anchor.isConnected) return closeColourPicker();
  sent = toHex(rgba());
  open?.change(sent);
}

function build() {
  const element = document.createElement('div');
  element.className = 'colour-picker';
  element.hidden = true;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement = element) => {
    const made = document.createElement(tag);
    made.className = className;
    parent.append(made);
    return made;
  };

  const field = make('div', 'picker-field');
  field.title = 'Saturation, left to right, and brightness, bottom to top';
  const thumb = make('div', 'picker-thumb', field);
  const hueStrip = make('div', 'picker-strip picker-hue');
  hueStrip.title = 'Hue';
  const hueKnob = make('div', 'picker-knob', hueStrip);
  const alphaStrip = make('div', 'picker-strip picker-alpha');
  alphaStrip.title = 'Opacity: solid at the right, not seen at all at the left';
  const alphaFill = make('div', 'picker-alpha-fill', alphaStrip);
  const alphaKnob = make('div', 'picker-knob', alphaStrip);

  const hexRow = make('div', 'picker-row');
  const swatch = make('span', 'picker-preview', hexRow);
  const swatchFill = make('span', 'picker-preview-fill', swatch);
  const hex = make('input', 'picker-hex', hexRow);
  hex.type = 'text';
  hex.spellcheck = false;
  hex.setAttribute('aria-label', 'Hex code');
  hex.title = 'The hex code: #rrggbb, or #rrggbbaa with its opacity';
  const dropper = make('button', 'picker-dropper', hexRow);
  dropper.type = 'button';
  dropper.textContent = '⌖';
  dropper.title = 'Pick a colour from anywhere on the screen';
  dropper.setAttribute('aria-label', 'Pick a colour from the screen');
  dropper.hidden = !('EyeDropper' in window);

  const numberRow = make('div', 'picker-row picker-numbers');
  const number = (name: string, title: string, max: number, perPixel: number) => {
    const label = make('label', 'picker-number', numberRow);
    label.title = title;
    label.append(name);
    const input = make('input', '', label);
    input.type = 'number';
    input.min = '0';
    input.max = String(max);
    input.step = max === 1 ? '0.01' : '1';
    input.setAttribute('aria-label', title);
    scrubbableInput(input, perPixel, 0, max);
    return input;
  };
  const red = number('R', 'Red, 0 to 255', 255, 1);
  const green = number('G', 'Green, 0 to 255', 255, 1);
  const blue = number('B', 'Blue, 0 to 255', 255, 1);
  const opacity = number('A', 'Opacity: 1 is solid, 0 cannot be seen at all', 1, 1 / 200);
  document.body.append(element);

  /** Follows the pointer while pressed on a square or a strip, from the press on. */
  const track = (target: HTMLElement, set: (x: number, y: number) => void) => {
    target.addEventListener('pointerdown', (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      // A press made by a script has no pointer to capture.
      try {
        target.setPointerCapture(down.pointerId);
      } catch {}
      const to = (event: PointerEvent) => {
        const box = target.getBoundingClientRect();
        if (!box.width || !box.height) return;
        const clamp = (x: number) => Math.min(1, Math.max(0, x));
        set(clamp((event.clientX - box.left) / box.width), clamp((event.clientY - box.top) / box.height));
        render();
        send();
      };
      to(down);
      const up = () => {
        target.removeEventListener('pointermove', to);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
      };
      target.addEventListener('pointermove', to);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    });
  };
  track(field, (x, y) => ([sat, val] = [x, 1 - y]));
  track(hueStrip, (x) => (hue = x * 360));
  track(alphaStrip, (x) => (alpha = Math.round(x * 100) / 100));

  hex.addEventListener('input', () => {
    const text = hex.value.trim();
    const colour = parseHex(text.startsWith('#') ? text : `#${text}`);
    if (!colour) return;
    setRgb(colour.r, colour.g, colour.b);
    alpha = colour.a;
    render();
    send();
  });
  // Left half typed, it shows the colour it has.
  hex.addEventListener('change', () => render());
  hex.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') closeColourPicker();
  });
  const numbers = () => {
    const values = [red, green, blue, opacity].map((input) => Number(input.value));
    if ([red, green, blue, opacity].some((input) => input.value === '') || !values.every(Number.isFinite)) return;
    const [r, g, b] = values.slice(0, 3).map((x) => Math.min(255, Math.max(0, x)) / 255);
    setRgb(r, g, b);
    alpha = Math.min(1, Math.max(0, values[3]));
    render();
    send();
  };
  for (const input of [red, green, blue, opacity]) {
    input.addEventListener('input', numbers);
    input.addEventListener('change', () => render());
  }
  dropper.addEventListener('click', async () => {
    try {
      const picked = await new (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper().open();
      const colour = parseHex(picked.sRGBHex);
      if (!colour || !open) return;
      setRgb(colour.r, colour.g, colour.b);
      render();
      send();
    } catch {
      // Escape while picking: nothing chosen.
    }
  });

  return { element, field, thumb, hueKnob, alphaFill, alphaKnob, swatchFill, hex, red, green, blue, opacity };
}

const css = ({ r, g, b, a }: Colour) => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;

function render() {
  if (!parts) return;
  const p = parts;
  const colour = rgba();
  const solid = { ...colour, a: 1 };
  const [hr, hg, hb] = rgbOf(hue, 1, 1);
  p.field.style.setProperty('--hue', css({ r: hr, g: hg, b: hb, a: 1 }));
  p.thumb.style.left = `${sat * 100}%`;
  p.thumb.style.top = `${(1 - val) * 100}%`;
  p.thumb.style.background = css(solid);
  p.hueKnob.style.left = `${(hue / 360) * 100}%`;
  p.alphaFill.style.background = `linear-gradient(to right, ${css({ ...colour, a: 0 })}, ${css(solid)})`;
  p.alphaKnob.style.left = `${alpha * 100}%`;
  p.swatchFill.style.background = css(colour);
  // Not a box being typed in.
  const fill = (input: HTMLInputElement, value: string) => {
    if (document.activeElement !== input) input.value = value;
  };
  fill(p.hex, toHex(colour));
  fill(p.red, String(Math.round(colour.r * 255)));
  fill(p.green, String(Math.round(colour.g * 255)));
  fill(p.blue, String(Math.round(colour.b * 255)));
  fill(p.opacity, String(Math.round(colour.a * 100) / 100));
}

function place(anchor: HTMLElement) {
  const element = parts!.element;
  const at = anchor.getBoundingClientRect();
  const { width, height } = element.getBoundingClientRect();
  const left = Math.min(Math.max(8, at.left), window.innerWidth - width - 8);
  const below = at.bottom + 6;
  const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, at.top - height - 6);
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

function outside(event: PointerEvent) {
  const target = event.target as Node;
  if (parts!.element.contains(target)) return;
  // The swatch's own click closes it, or opens it for another.
  if (open?.anchor.contains(target)) return;
  closeColourPicker();
}

function keys(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  // Escape is the picker's, not the editor's or the window's.
  event.stopPropagation();
  event.preventDefault();
  closeColourPicker();
}

function scrolled(event: Event) {
  if (!parts!.element.contains(event.target as Node)) closeColourPicker();
}
