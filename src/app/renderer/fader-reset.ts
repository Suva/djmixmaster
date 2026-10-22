// A double click on a slider puts it back to its default, as on a mixing desk's
// software. Each slider says what its default is where it is made; the reset
// then goes through the slider's own handlers, as if it had been dragged
// there, so it is saved, heard and undone like any other move.

/** Each slider's default: a value to move it to, or what to do instead where a value is not the whole story. */
const defaults = new WeakMap<HTMLInputElement, number | (() => void)>();

/** Says what a double click on `slider` puts it back to. */
export function resetsTo(slider: HTMLInputElement, value: number | (() => void)) {
  defaults.set(slider, value);
}

export function initFaderReset() {
  document.addEventListener('dblclick', (event) => {
    const slider = (event.target as Element | null)?.closest?.('input[type="range"]');
    if (!(slider instanceof HTMLInputElement) || slider.disabled) return;
    const value = defaults.get(slider);
    if (value === undefined) return;
    event.preventDefault();
    if (typeof value === 'function') {
      value();
      return;
    }
    slider.value = String(value);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
