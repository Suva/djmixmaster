// Number boxes that change when dragged sideways, as in image and 3D editors:
// press on one and drag left or right. A press without a drag is a click as
// before: into the box to type, or whatever else the box does. A box already
// being typed in is left to the typing.

/** Movement under this many pixels is a click, not a drag. */
const DRAG_START_PX = 4;

export interface ScrubOptions {
  /** The value now, or null when it cannot be dragged (it follows an expression, say). */
  value(): number | null;
  set(value: number): void;
  /** How much one pixel of dragging changes it; Shift makes it ten times finer. */
  perPixel: number;
  min?: number;
  max?: number;
  /** A press without a drag; by default, an input is focused for typing. */
  click?(): void;
}

/** Digits worth keeping for a value changed by this much a pixel. */
const digits = (step: number) => (step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0);

export function scrubbable(target: HTMLElement, options: ScrubOptions) {
  target.classList.add('scrub');
  target.addEventListener('mousedown', (down) => {
    if (down.button !== 0) return;
    // Already being typed in: the press places the cursor, as usual.
    if (target instanceof HTMLInputElement && document.activeElement === target) return;
    const start = options.value();
    down.preventDefault();
    let dragging = false;
    const move = (event: MouseEvent) => {
      const dx = event.clientX - down.clientX;
      if (!dragging && Math.abs(dx) < DRAG_START_PX) return;
      if (start === null) return;
      if (!dragging) document.body.classList.add('scrubbing');
      dragging = true;
      const step = options.perPixel * (event.shiftKey ? 0.1 : 1);
      let value = start + dx * step;
      if (options.min !== undefined) value = Math.max(options.min, value);
      if (options.max !== undefined) value = Math.min(options.max, value);
      options.set(Number(value.toFixed(digits(step))));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('scrubbing');
      if (dragging) {
        // The click that follows the end of a drag is not one; if none follows (let go elsewhere), none is caught later.
        const swallow = (event: MouseEvent) => event.stopPropagation();
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }));
        return;
      }
      if (options.click) options.click();
      else if (target instanceof HTMLInputElement) {
        target.focus();
        target.select();
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

/** A number input that can be dragged: it is set as if typed in, so whatever listens to its typing follows. */
export function scrubbableInput(input: HTMLInputElement, perPixel: number, min?: number, max?: number) {
  scrubbable(input, {
    value: () => (input.value === '' || !Number.isFinite(Number(input.value)) ? null : Number(input.value)),
    set: (value) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    perPixel,
    min,
    max,
  });
}
