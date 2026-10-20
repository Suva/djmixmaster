// A colour and how opaque it is, as everywhere a colour is set has them: the
// browser's colour well, which knows red, green and blue only, and beside it
// a box for the opacity, 0 to 1 as a layer's Opacity is, to type or drag
// sideways. Together they make the hex code a template keeps: #rrggbb, or
// #rrggbbaa when the colour is see-through. The well's swatch is drawn as
// see-through as the colour, over a checkerboard, so that it shows.

import { parseHex, toHex } from '../../visuals/colour.ts';
import { scrubbableInput } from './scrub.ts';

export interface ColourInput {
  element: HTMLElement;
  /** The colour well, to be opened from elsewhere (a click on a gradient's stop) or given an id. */
  well: HTMLInputElement;
  /** Shows another colour, `#rrggbb` or `#rrggbbaa`; one that is none of them shows as solid white, as the well would. */
  show(hex: string): void;
}

const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const shown = (alpha: number) => String(Math.round(alpha * 100) / 100);

/** `change` is given the new colour as a hex code. `label` names the colour for screen readers. */
export function colourInput(hex: string, change: (hex: string) => void, label = 'Colour'): ColourInput {
  const element = document.createElement('span');
  element.className = 'colour-input';
  const well = document.createElement('input');
  well.type = 'color';
  well.setAttribute('aria-label', label);
  const alpha = document.createElement('input');
  alpha.type = 'number';
  alpha.className = 'colour-alpha';
  alpha.min = '0';
  alpha.max = '1';
  alpha.step = '0.01';
  alpha.title = 'Opacity: 1 is solid, 0 cannot be seen at all. Type it, or drag sideways';
  alpha.setAttribute('aria-label', `${label}, opacity`);
  element.append(well, alpha);

  const opacity = () => {
    const a = Number(alpha.value);
    return alpha.value !== '' && Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1;
  };
  const swatch = () => well.style.setProperty('--alpha', String(opacity()));
  const send = () => {
    swatch();
    change(toHex({ ...(parseHex(well.value) ?? WHITE), a: opacity() }));
  };
  well.addEventListener('input', send);
  alpha.addEventListener('input', () => {
    // Half typed ("0."), nothing yet.
    if (alpha.value !== '' && Number.isFinite(Number(alpha.value))) send();
  });
  // Typed past 0 to 1, it shows what it came to.
  alpha.addEventListener('change', () => (alpha.value = shown(opacity())));
  scrubbableInput(alpha, 1 / 300, 0, 1);

  function show(next: string) {
    const colour = parseHex(next) ?? WHITE;
    well.value = toHex({ ...colour, a: 1 });
    // Not while it is being typed in.
    if (document.activeElement !== alpha) alpha.value = shown(colour.a);
    swatch();
  }
  show(hex);
  return { element, well, show };
}
