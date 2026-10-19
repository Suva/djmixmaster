// A gradient's stops as a bar in the template editor, as a photo editor shows
// them: the gradient, with a marker under it for each stop. Drag a marker to
// move its stop, click it to choose its colour, click the bar to add a stop
// there, drag a marker away from the bar to take it out.
//
// The stops are ordinary settings (colour1…colour5, position1…position5; see
// gradient-map.ts), shown below the bar as well; the bar only sets them, so
// each can still follow the music. A stop whose place follows an expression
// is drawn where it is now and cannot be dragged; one whose colour does
// cannot be given another here.

import { parseHex, toHex, type Colour } from '../../visuals/colour.ts';
import { gradientAt, STOP_COUNT, stopsOf } from '../../visuals/gradient-map.ts';
import type { Layer, ParamValue, ResolvedParams } from '../../visuals/template.ts';

/** Pointer movement under this many pixels is a click, not a drag. */
const DRAG_START_PX = 4;
/** Dragged this far above or below the bar, a marker is taken out when let go. */
const REMOVE_PX = 36;

export interface StopBarContext {
  /** Gives settings of the layer new values, as one change. */
  set(values: Record<string, ParamValue>): void;
  /** What the layer's settings came to in the frame last drawn, or null. */
  live(): ResolvedParams | null;
  /** The defaults of the layer's settings, for those not given. */
  defaults: Record<string, ParamValue>;
  /** Shows a setting's new value in its own row below. */
  refresh(key: string): void;
}

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

export function stopBar(layer: Layer, context: StopBarContext): { element: HTMLElement; tick(): void } {
  const element = document.createElement('div');
  element.className = 'stop-bar';
  const track = document.createElement('div');
  track.className = 'stop-track';
  track.title = 'Click to add a stop here';
  const gradient = document.createElement('div');
  gradient.className = 'stop-gradient';
  track.append(gradient);
  const markers = document.createElement('div');
  markers.className = 'stop-markers';
  // The colour well that a click on a marker opens; one, reused.
  const well = document.createElement('input');
  well.type = 'color';
  well.className = 'stop-well';
  well.tabIndex = -1;
  element.append(track, markers, well);

  const given = (key: string) => layer.params[key] ?? context.defaults[key];
  const plainColour = (n: number) => {
    const value = given(`colour${n}`);
    return typeof value === 'string' && (value === '' || HEX.test(value)) ? value : null;
  };
  const plainPosition = (n: number) => {
    const value = given(`position${n}`);
    return typeof value === 'number' ? value : null;
  };
  /** A stop's colour and place as drawn: the live values where there are any, else the settings. */
  const now = (n: number): { colour: Colour | null; position: number } => {
    const live = context.live();
    const colour = live?.[`colour${n}`];
    const position = live?.[`position${n}`];
    const plain = plainColour(n);
    return {
      colour: colour && typeof colour === 'object' ? (colour as Colour) : plain ? parseHex(plain) : null,
      position: typeof position === 'number' ? position : plainPosition(n) ?? 0,
    };
  };

  const items: HTMLElement[] = [];
  for (let n = 1; n <= STOP_COUNT; n++) {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'stop-marker';
    marker.dataset.stop = String(n);
    marker.setAttribute('aria-label', `Stop ${n}`);
    marker.addEventListener('pointerdown', (event) => grab(event, n, marker));
    items.push(marker);
  }
  markers.append(...items);

  /** Moves a marker, or on a click without moving, opens its colour. */
  function grab(event: PointerEvent, n: number, marker: HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    const [startX, startY] = [event.clientX, event.clientY];
    const movable = plainPosition(n) !== null;
    let dragging = false;
    let removing = false;
    const move = (moved: PointerEvent) => {
      if (!dragging && Math.hypot(moved.clientX - startX, moved.clientY - startY) < DRAG_START_PX) return;
      dragging = true;
      const box = track.getBoundingClientRect();
      removing = moved.clientY < box.top - REMOVE_PX || moved.clientY > box.bottom + REMOVE_PX;
      marker.classList.toggle('removing', removing);
      if (!movable || removing) return;
      const at = Math.min(1, Math.max(0, (moved.clientX - box.left) / box.width));
      context.set({ [`position${n}`]: Math.round(at * 1000) / 1000 });
      draw();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      marker.classList.remove('removing');
      if (removing) {
        context.set({ [`colour${n}`]: '' });
        context.refresh(`colour${n}`);
      } else if (!dragging) pickColour(n);
      draw();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function pickColour(n: number) {
    const plain = plainColour(n);
    if (plain === null) return;
    well.value = (plain || '#ffffff').slice(0, 7);
    well.oninput = () => {
      // The well knows no transparency: what there was is kept.
      const alpha = HEX.test(String(given(`colour${n}`))) ? String(given(`colour${n}`)).slice(7) : '';
      context.set({ [`colour${n}`]: well.value + alpha });
      context.refresh(`colour${n}`);
      draw();
    };
    well.click();
  }

  // A click on the bar adds a stop there, in the colour the gradient has there, so that nothing changes until it is moved.
  track.addEventListener('click', (event) => {
    const free = items.findIndex((_, i) => plainColour(i + 1) === '');
    if (free < 0) return;
    const n = free + 1;
    const box = track.getBoundingClientRect();
    const at = Math.round(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * 1000) / 1000;
    const colour = gradientAt(stops(), at, wheel());
    context.set({ [`colour${n}`]: toHex(colour), [`position${n}`]: at });
    context.refresh(`colour${n}`);
    context.refresh(`position${n}`);
    draw();
  });

  const stops = () => stopsOf((n) => now(n).colour, (n) => now(n).position);
  const wheel = () => (context.live()?.stopBlend ?? given('stopBlend')) === 'round the colour wheel';

  let last = '';
  function draw() {
    const shown = stops();
    const css = shown.length === 0 ? 'transparent'
      : shown.length === 1 ? cssColour(shown[0].colour)
      // Blended as it will be drawn: CSS blends in OKLab or OKLCH when asked, the shorter way round as the drawing does.
      : `linear-gradient(${wheel() ? 'in oklch shorter hue' : 'in oklab'} to right, ${shown.map((stop) => `${cssColour(stop.colour)} ${(stop.position * 100).toFixed(2)}%`).join(', ')})`;
    const free = items.some((_, i) => plainColour(i + 1) === '');
    track.classList.toggle('full', !free);
    track.title = free ? 'Click to add a stop here' : 'Five stops at most: drag one away from the bar to take it out';
    const state = css + items.map((_, i) => JSON.stringify(now(i + 1))).join();
    if (state === last) return;
    last = state;
    gradient.style.background = css;
    items.forEach((marker, i) => {
      const n = i + 1;
      const { colour, position } = now(n);
      marker.hidden = colour === null;
      if (!colour) return;
      marker.style.left = `${position * 100}%`;
      marker.style.setProperty('--stop', cssColour(colour));
      const fixedPlace = plainPosition(n) === null;
      const fixedColour = plainColour(n) === null;
      marker.classList.toggle('fixed', fixedPlace);
      marker.title = `Stop ${n} at ${position.toFixed(2)}: `
        + (fixedPlace ? 'its place follows an expression, so it is set below, not by dragging. ' : 'drag to move it, or away from the bar to take it out. ')
        + (fixedColour ? 'Its colour follows an expression.' : 'Click to choose its colour.');
    });
  }
  draw();
  return { element, tick: draw };
}

const cssColour = (c: Colour) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a.toFixed(3)})`;
