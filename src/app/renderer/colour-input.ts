// A colour as everywhere a colour is set has it: a swatch, drawn as
// see-through as the colour over a checkerboard, that opens the app's colour
// picker (colour-picker.ts) for its colour and opacity together. The colour
// is the hex code a template keeps: #rrggbb, or #rrggbbaa when see-through.

import { parseHex } from '../../visuals/colour.ts';
import { closeColourPicker, colourChanged, openColourPicker, pickerOpenFor } from './colour-picker.ts';

export interface ColourInput {
  element: HTMLElement;
  /** The swatch, a button: to be given an id, or a label. */
  swatch: HTMLButtonElement;
  /** Opens the picker, as a click on the swatch does. */
  open(): void;
  /** Shows another colour, `#rrggbb` or `#rrggbbaa`; '' shows none. */
  show(hex: string): void;
}

/** `change` is given the new colour as a hex code. `label` names the colour, for its tooltip and screen readers. */
export function colourInput(hex: string, change: (hex: string) => void, label = 'Colour'): ColourInput {
  const element = document.createElement('span');
  element.className = 'colour-input';
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'colour-swatch';
  swatch.title = `${label}: click to choose its colour and opacity`;
  swatch.setAttribute('aria-label', label);
  const fill = document.createElement('span');
  fill.className = 'colour-swatch-fill';
  swatch.append(fill);
  element.append(swatch);

  let value = hex;
  const paint = () => {
    const c = parseHex(value);
    fill.style.background = c ? `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})` : 'transparent';
    swatch.dataset.colour = value;
  };
  const open = () => openColourPicker(swatch, value || '#ffffff', (next) => {
    value = next;
    paint();
    change(next);
  });
  swatch.addEventListener('click', () => (pickerOpenFor(swatch) ? closeColourPicker() : open()));
  paint();
  return {
    element,
    swatch,
    open,
    show(next) {
      value = next;
      paint();
      if (next) colourChanged(swatch, next);
    },
  };
}
