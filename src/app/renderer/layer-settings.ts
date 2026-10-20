// The settings of one layer in the template editor, made from what its kind
// of layer has (LAYER_TYPES): a slider for a number, a switch, a colour, a
// list, a text, a picture, a font. A number, a switch or a colour can instead
// be an expression (the ƒ button), which is checked as it is typed, with what
// is wrong underlined, and shows what it comes to while the music plays.
//
// Every change goes back through `set`, as the setting's new value, and is
// made by the editor to the layer given here, which is the editor's own; the
// controls are not rebuilt meanwhile, so typing is never interrupted.

import { MUSIC_NAMES } from '../../visuals/music.ts';
import { toHex, type Colour } from '../../visuals/colour.ts';
import {
  ASSET_PREFIX, checkSetting, COMMON_PARAMS, FOLDER_LUT_PREFIX, folderLutsOf, LUT_PREFIX, MEDIA_PREFIX, RECORDING_VIDEO, settingsOf, LAYER_TYPES, STYLE_PARAMS, TEXT_VARIABLES,
  type Layer, type MediaFile, type ParamSpec, type ParamValue, type ResolvedParams, type Template,
} from '../../visuals/template.ts';
import { BUILTIN_LUT_PREFIX, BUILTIN_LUTS } from '../../visuals/builtin-luts.ts';
import type { PackedLut } from '../../visuals/lut.ts';
import type { FolderLut } from '../api.ts';
import { lutPicker, type LutChoice } from './lut-picker.ts';
import { fontPicker } from './font-picker.ts';
import { scrubbableInput } from './scrub.ts';
import { stopBar } from './stop-bar.ts';
import { colourInput } from './colour-input.ts';
import { STOP_COUNT } from '../../visuals/gradient-map.ts';
import { MOTION_SOURCES, MOTION_SPEEDS, motionExpression, parseMotion, timed, type Motion, type MotionSource, type MotionSpeed } from '../../visuals/motion.ts';

export interface LayerSettingsContext {
  /** The template as it is now, for what fields and pictures it has, and for checking. */
  template(): Template;
  /** Gives a setting of the layer a new value. */
  set(key: string, value: ParamValue): void;
  /** Gives several settings new values, as one change; one at a time where it is not given. */
  setMany?(values: Record<string, ParamValue>): void;
  /** Packs a picture into the template and gives the setting it. */
  pack(key: string, name: string, data: string): void;
  /** What the layer's settings came to in the frame last drawn, or null. */
  live(): ResolvedParams | null;
  /** Asks for a picture file and gives its name and contents as a data URL, or null. */
  pickPicture(): Promise<{ name: string; data: string } | null>;
  /** Asks for a video file and makes it one the template can keep: its name, and where it is. */
  pickVideo(): Promise<{ name: string; file: MediaFile } | null>;
  /** Keeps a video with the template and gives the setting it. */
  keepVideo(key: string, name: string, file: MediaFile): void;
  /** Asks for a .cube file and gives its name and the LUT packed; null if none, or it cannot be read. */
  pickLut(): Promise<{ name: string; lut: PackedLut } | null>;
  /** The LUTs in the LUT folder, as last looked at. */
  folderLuts(): FolderLut[];
  /** Keeps a LUT in the template and gives the setting it. */
  keepLut(key: string, name: string, lut: PackedLut): void;
}

/**
 * The LUTs a template can name: those it keeps; those in the LUT folder,
 * which it names by where they are there and does not keep (until it is
 * exported to share); and those that come with the app, last, as there are
 * many and a collection of one's own is what is looked for first. A folder
 * LUT it names that is not there now is still
 * listed, so that it can be seen to be chosen.
 */
export function lutChoices(template: Template, folder: FolderLut[]): LutChoice[] {
  const named = new Set(folderLutsOf(template));
  for (const lut of folder) named.delete(lut.name);
  return [
    ...Object.keys(template.luts ?? {}).map((name) => ({ value: LUT_PREFIX + name, label: name, group: 'Kept in the template' })),
    ...folder.map((lut) => ({ value: FOLDER_LUT_PREFIX + lut.name, label: lut.name, group: 'LUT folder' })),
    ...[...named].map((name) => ({ value: FOLDER_LUT_PREFIX + name, label: `${name} (not in the folder)`, group: 'LUT folder' })),
    ...BUILTIN_LUTS.map((lut) => ({ value: BUILTIN_LUT_PREFIX + lut.name, label: lut.name, group: lut.group })),
  ];
}

/**
 * The name to keep a LUT under in a template: that of one it keeps already
 * with the same table, so that choosing a look again does not keep it twice;
 * or else its own, made free.
 */
export function keptLutName(template: Template, picked: { name: string; lut: PackedLut }): { name: string; known: boolean } {
  const kept = template.luts ?? {};
  const same = Object.keys(kept).find((name) => kept[name].data === picked.lut.data && kept[name].size === picked.lut.size);
  return same ? { name: same, known: true } : { name: freeName(picked.name.split('/').pop()!, Object.keys(kept)), known: false };
}

/** A name not yet taken among these, for something added: the one wanted, or it with a number. */
export function freeName(wanted: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  let name = wanted;
  for (let n = 2; names.has(name); n++) name = `${wanted} ${n}`;
  return name;
}

/** Settings shown under the layer's own, folded away until wanted. */
const GROUPS: [string, string[], boolean][] = [
  ['Placement', ['x', 'y', 'anchor', 'scale', 'rotation'], true],
  ['Drop shadow', ['dropShadow', 'dropColour', 'dropOpacity', 'dropAngle', 'dropDistance', 'dropSize'], false],
  ['Stroke', ['stroke', 'strokeColour', 'strokeOpacity', 'strokeWidth'], false],
  ['Outer glow', ['outerGlow', 'glowColour', 'glowOpacity', 'glowSize', 'glowSpread'], false],
  ['Inner shadow', ['innerShadow', 'innerShadowColour', 'innerShadowOpacity', 'innerShadowAngle', 'innerShadowDistance', 'innerShadowSize'], false],
  ['Inner glow', ['innerGlow', 'innerGlowColour', 'innerGlowOpacity', 'innerGlowSize', 'innerGlowChoke'], false],
  ['Mask', ['mask', 'maskInvert', 'maskExpand', 'maskFeather'], false],
  ['Timing', ['from', 'until', 'fadeIn', 'fadeOut'], false],
];
/** The settings above the list of layers, as an image editor has them, and not among the others. */
export const ABOVE_LAYERS = ['blend', 'opacity'];
/** Which groups were folded, kept while other layers are selected. */
const opened = new Map<string, boolean>();

/** Choices shown with more than their stored name: what an image editor would call them too. */
export const SHOWN_AS: Record<string, string> = { add: 'add (linear dodge)' };

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
/** Whether a value of a setting is an expression rather than a plain value. */
function isExpression(value: ParamValue, param: ParamSpec): boolean {
  if (param.kind === 'number' || param.kind === 'switch') return typeof value === 'string';
  if (param.kind === 'colour') return typeof value === 'string' && value !== '' && !HEX.test(value);
  return false;
}

/**
 * Settings switched to expressions with the ƒ button, by layer. A colour
 * written plain, #ffffff, is also a valid expression, so what it looks like
 * cannot tell which it is meant as; this remembers, while the layer lasts.
 */
const asExpression = new WeakMap<Layer, Set<string>>();

const shown = (value: number) => (Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2));

/**
 * The settings of a layer: all of them in their groups, but for those above
 * the list of layers; or, given `only`, just those, side by side.
 */
export function layerSettings(layer: Layer, context: LayerSettingsContext, only?: string[]): { element: HTMLElement; tick(): void } {
  const spec = LAYER_TYPES[layer.type];
  const element = document.createElement('div');
  element.className = only ? 'layer-settings some' : 'layer-settings';
  /** Updates of the live values, one per setting that is an expression. */
  const ticks = new Map<string, (live: ResolvedParams) => void>();
  /**
   * Plain numbers brought up to date with the setting, when it was changed
   * elsewhere: the opacity box above the layers, a drag on the picture.
   */
  const syncs = new Map<string, () => void>();
  /** Each setting's way of showing its value again, after it was changed elsewhere: from a gradient's stop bar. */
  const rebuilds = new Map<string, () => void>();

  const group = (title: string, keys: string[], open: boolean) => {
    const details = document.createElement('details');
    details.open = opened.get(title) ?? open;
    details.addEventListener('toggle', () => opened.set(title, details.open));
    const summary = document.createElement('summary');
    summary.textContent = title;
    details.append(summary);
    // A style's heading has a dot while it is on, so that it shows folded away; so has the mask's, while the layer is one.
    if (keys[0] in STYLE_PARAMS || keys[0] === 'mask') {
      const dot = document.createElement('span');
      dot.className = 'style-on';
      dot.title = keys[0] === 'mask' ? 'This layer is a mask' : `${title} is on`;
      summary.append(dot);
      const on = (value: unknown) => value === true || (typeof value === 'string' && value !== 'off');
      const show = () => (dot.hidden = !on(context.live()?.[keys[0]]));
      show();
      ticks.set(`style:${keys[0]}`, show);
    }
    const all = settingsOf(spec);
    for (const key of keys) if (all[key]) details.append(setting(key, all[key]));
    return details;
  };

  function setting(key: string, param: ParamSpec): HTMLElement {
    const row = document.createElement('div');
    row.className = 'setting';
    row.dataset.key = key;
    const head = document.createElement('div');
    head.className = 'setting-head';
    const label = document.createElement('label');
    label.textContent = param.unit ? `${param.label} (${param.unit})` : param.label;
    const live = document.createElement('output');
    live.className = 'live';
    head.append(label, live);
    const body = document.createElement('div');
    body.className = 'setting-body';
    const problem = document.createElement('p');
    problem.className = 'setting-problem';
    row.append(head, body, problem);

    const value = () => layer.params[key] ?? param.default;
    const chosen = asExpression.get(layer) ?? new Set<string>();
    asExpression.set(layer, chosen);
    const expressed = () => chosen.has(key) || isExpression(value(), param);
    const canExpress = !param.fixed && (param.kind === 'number' || param.kind === 'switch' || param.kind === 'colour');
    // A number can be set to follow the music without writing the expression: "Moves with…".
    const motionPanel = document.createElement('div');
    motionPanel.className = 'motion';
    motionPanel.hidden = true;
    row.append(motionPanel);
    if (param.kind === 'number' && !param.fixed) {
      const wave = document.createElement('button');
      wave.type = 'button';
      wave.className = 'fx motion-button';
      wave.textContent = '∿';
      wave.title = 'Moves with…: make this follow the bass, the beat or a slow wave, without writing an expression';
      wave.setAttribute('aria-label', `${param.label} moves with the music`);
      wave.addEventListener('click', () => {
        motionPanel.hidden = !motionPanel.hidden;
        wave.classList.toggle('on', !motionPanel.hidden);
        if (!motionPanel.hidden) showMotion();
      });
      head.append(wave);
    }
    /** The motion's controls, from the expression if it was written by them, else starting from the value now. */
    function showMotion() {
      const current = value();
      const nowValue = typeof current === 'number' ? current : Number(context.live()?.[key] ?? param.default);
      const span = (param.max ?? 100) - (param.min ?? 0);
      let motion: Motion = (typeof current === 'string' ? parseMotion(current) : null)
        ?? { base: Number(shown(nowValue)), amount: Number(shown(span / 10)), source: 'bass', speed: 'smooth', period: 8 };
      const apply = () => {
        chosen.add(key);
        context.set(key, motionExpression(motion));
        build();
      };
      const line = (title: string, ...controls: HTMLElement[]) => {
        const box = document.createElement('label');
        box.className = 'motion-line';
        const text = document.createElement('span');
        text.textContent = title;
        box.append(text, ...controls);
        return box;
      };
      const source = document.createElement('select');
      for (const [id, label] of MOTION_SOURCES) source.add(new Option(label, id));
      source.value = motion.source;
      const amount = document.createElement('input');
      amount.type = 'range';
      amount.min = String(-span);
      amount.max = String(span);
      amount.step = String(span / 200);
      amount.value = String(motion.amount);
      const amountShown = document.createElement('output');
      amountShown.textContent = shown(motion.amount);
      const speed = document.createElement('select');
      for (const [id, label] of MOTION_SPEEDS) speed.add(new Option(label, id));
      speed.value = motion.speed;
      const period = document.createElement('input');
      period.type = 'number';
      period.min = '0.1';
      period.step = 'any';
      period.value = String(motion.period);
      const speedLine = line('Speed', speed);
      const periodLine = line('Seconds', period);
      const showKind = () => {
        speedLine.hidden = timed(motion.source);
        periodLine.hidden = !timed(motion.source);
      };
      source.addEventListener('change', () => {
        motion = { ...motion, source: source.value as MotionSource };
        showKind();
        apply();
      });
      amount.addEventListener('input', () => {
        motion = { ...motion, amount: Number(amount.value) };
        amountShown.textContent = shown(motion.amount);
        apply();
      });
      speed.addEventListener('change', () => {
        motion = { ...motion, speed: speed.value as MotionSpeed };
        apply();
      });
      scrubbableInput(period, 0.05, 0.1);
      period.addEventListener('input', () => {
        if (!(Number(period.value) > 0)) return;
        motion = { ...motion, period: Number(period.value) };
        apply();
      });
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.textContent = 'Stop moving';
      stop.title = 'Keep the value it moves from, standing still';
      stop.addEventListener('click', () => {
        chosen.delete(key);
        context.set(key, motion.base);
        motionPanel.hidden = true;
        head.querySelector('.motion-button')?.classList.remove('on');
        build();
      });
      const base = document.createElement('input');
      base.type = 'number';
      base.step = 'any';
      base.value = String(motion.base);
      base.title = 'The value with nothing moving it';
      scrubbableInput(base, span / 300);
      base.addEventListener('input', () => {
        if (base.value === '' || !Number.isFinite(Number(base.value))) return;
        motion = { ...motion, base: Number(base.value) };
        apply();
      });
      showKind();
      motionPanel.replaceChildren(line('Moves with', source), line('From', base), line('Amount', amount, amountShown), speedLine, periodLine, stop);
      // Opening it sets the setting moving at once, so that what it does is seen.
      if (typeof current !== 'string' || !parseMotion(current)) apply();
    }
    if (canExpress) {
      const fx = document.createElement('button');
      fx.type = 'button';
      fx.className = 'fx';
      fx.textContent = 'ƒ';
      fx.title = 'Write this as an expression, to make it follow the music: 1 + 0.5 * bass, say';
      fx.setAttribute('aria-label', `${param.label} as an expression`);
      fx.addEventListener('click', () => {
        const now = value();
        let next: ParamValue;
        if (expressed()) {
          chosen.delete(key);
          // Back to a plain value: what the expression comes to now, or the default.
          const current = context.live()?.[key];
          if (param.kind === 'colour') next = current && typeof current === 'object' ? toHex(current as Colour) : String(param.default);
          else if (param.kind === 'switch') next = typeof current === 'boolean' ? current : Boolean(param.default);
          else next = typeof current === 'number' ? Number(shown(current)) : param.default;
        } else {
          chosen.add(key);
          next = param.kind === 'switch' ? (now ? '1' : '0') : String(now === '' ? param.default || '#ffffff' : now);
        }
        context.set(key, next);
        build();
      });
      head.append(fx);
    }

    function build() {
      problem.textContent = '';
      live.textContent = '';
      ticks.delete(key);
      syncs.delete(key);
      row.classList.toggle('expression', expressed());
      if (expressed()) body.replaceChildren(expression());
      else body.replaceChildren(plain());
    }

    function change(next: ParamValue) {
      context.set(key, next);
    }

    /** The setting as an expression: a line of text, checked as it is typed. */
    function expression(): HTMLElement {
      const wrap = document.createElement('div');
      wrap.className = 'expr';
      // Behind the field, the same text with what is wrong marked; the field itself is transparent.
      const mirror = document.createElement('div');
      mirror.className = 'expr-mirror';
      mirror.setAttribute('aria-hidden', 'true');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'expr-input';
      input.spellcheck = false;
      input.value = String(value());
      const check = () => {
        const wrong = checkSetting(context.template(), input.value, param, MUSIC_NAMES, TEXT_VARIABLES);
        problem.textContent = wrong ? wrong.message : '';
        const text = input.value;
        if (wrong && wrong.start !== undefined && wrong.end !== undefined) {
          const mark = document.createElement('mark');
          // A problem at the very end, such as something missing, marks a space after it.
          mark.textContent = text.slice(wrong.start, Math.max(wrong.end, wrong.start + 1)) || ' ';
          mirror.replaceChildren(text.slice(0, wrong.start), mark, text.slice(Math.max(wrong.end, wrong.start + 1)));
        } else {
          mirror.replaceChildren(text);
        }
        mirror.scrollLeft = input.scrollLeft;
        return wrong;
      };
      input.addEventListener('input', () => {
        check();
        change(input.value);
        // "Moves with…" open beside it shows the formula typed, while it is still one it could have written.
        if (!motionPanel.hidden) {
          if (parseMotion(input.value)) showMotion();
          else {
            motionPanel.hidden = true;
            head.querySelector('.motion-button')?.classList.remove('on');
          }
        }
      });
      input.addEventListener('scroll', () => (mirror.scrollLeft = input.scrollLeft));
      wrap.append(mirror, input);
      check();
      ticks.set(key, (resolved) => {
        const current = resolved[key];
        if (problem.textContent) live.textContent = '';
        else if (typeof current === 'number') live.textContent = `= ${shown(current)}`;
        else if (typeof current === 'boolean') live.textContent = current ? '= on' : '= off';
        else if (current && typeof current === 'object') {
          live.textContent = '';
          const swatch = document.createElement('span');
          swatch.className = 'swatch';
          swatch.style.background = toHex(current as Colour);
          live.append('= ', swatch);
        }
      });
      return wrap;
    }

    /** The setting as a plain value, with the control its kind calls for. */
    function plain(): HTMLElement {
      const current = value();
      switch (param.kind) {
        case 'number': {
          const box = document.createElement('div');
          box.className = 'number-setting';
          const range = document.createElement('input');
          range.type = 'range';
          range.min = String(param.min ?? 0);
          range.max = String(param.max ?? 100);
          range.step = String(((param.max ?? 100) - (param.min ?? 0)) / 200);
          range.value = String(current);
          const number = document.createElement('input');
          number.type = 'number';
          number.step = 'any';
          number.value = String(current);
          range.addEventListener('input', () => {
            number.value = shown(Number(range.value));
            change(Number(number.value));
          });
          number.addEventListener('input', () => {
            if (number.value === '' || !Number.isFinite(Number(number.value))) return;
            range.value = number.value;
            change(Number(number.value));
          });
          // Dragged sideways, it covers the knob's range in about 300 pixels; free to go past it, as typing is,
          // but for opacity, which means nothing outside it.
          const bounded = key === 'opacity';
          scrubbableInput(number, ((param.max ?? 100) - (param.min ?? 0)) / 300, bounded ? param.min : undefined, bounded ? param.max : undefined);
          syncs.set(key, () => {
            const now = layer.params[key];
            // Not while it is being typed in.
            if (typeof now !== 'number' || document.activeElement === number || Number(number.value) === now) return;
            number.value = String(now);
            range.value = String(now);
          });
          box.append(range, number);
          return box;
        }
        case 'switch': {
          const box = document.createElement('label');
          box.className = 'switch-setting';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = Boolean(current);
          input.addEventListener('change', () => change(input.checked));
          box.append(input, input.checked ? 'On' : 'Off');
          input.addEventListener('change', () => (box.lastChild!.textContent = input.checked ? 'On' : 'Off'));
          return box;
        }
        case 'colour': {
          const box = document.createElement('div');
          box.className = 'colour-setting';
          const hex = String(current);
          const code = document.createElement('span');
          code.className = 'colour-code';
          code.textContent = hex || 'None';
          const input = colourInput(hex, (next) => {
            code.textContent = next;
            box.classList.remove('none');
            change(next);
          }, param.label);
          box.append(input.element, code);
          if (param.default === '') {
            // A colour that may be left out: a second or third colour, a box behind text.
            const none = document.createElement('button');
            none.type = 'button';
            none.textContent = 'None';
            none.title = 'Leave this colour out';
            none.addEventListener('click', () => {
              code.textContent = 'None';
              box.classList.add('none');
              change('');
            });
            box.append(none);
          }
          box.classList.toggle('none', hex === '');
          return box;
        }
        case 'choice': {
          const select = document.createElement('select');
          for (const option of param.choices ?? []) select.add(new Option(SHOWN_AS[option] ?? option, option));
          for (const field of context.template().fields.filter((f) => f.kind === 'choice')) select.add(new Option(`Field: ${field.label}`, `%${field.key}%`));
          select.value = String(current);
          select.addEventListener('change', () => change(select.value));
          return select;
        }
        case 'text': {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'text-setting';
          input.spellcheck = false;
          input.value = String(current);
          input.title = `Variables in percent signs are filled in: %${TEXT_VARIABLES.slice(0, 4).join('%, %')}%, and the template's fields`;
          const check = () => {
            const wrong = checkSetting(context.template(), input.value, param, MUSIC_NAMES, TEXT_VARIABLES);
            problem.textContent = wrong ? wrong.message : '';
          };
          input.addEventListener('input', () => {
            check();
            change(input.value);
          });
          check();
          return input;
        }
        case 'image': {
          const select = document.createElement('select');
          select.add(new Option('None', ''));
          const template = context.template();
          for (const field of template.fields.filter((f) => f.kind === 'image')) select.add(new Option(`Field: ${field.label}`, `%${field.key}%`));
          for (const name of Object.keys(template.assets ?? {})) select.add(new Option(`Packed: ${name}`, ASSET_PREFIX + name));
          const value = String(current);
          if (value && ![...select.options].some((option) => option.value === value)) select.add(new Option(value.split(/[\\/]/).pop()!, value));
          select.add(new Option('Add a picture…', '+'));
          select.value = value;
          select.addEventListener('change', async () => {
            if (select.value !== '+') return change(select.value);
            select.value = String(layer.params[key] ?? '');
            const picked = await context.pickPicture();
            if (!picked) return;
            // Packed into the template, so that it travels with it.
            const taken = new Set(Object.keys(context.template().assets ?? {}));
            let name = picked.name;
            for (let n = 2; taken.has(name); n++) name = `${picked.name} ${n}`;
            context.pack(key, name, picked.data);
            build();
          });
          return select;
        }
        case 'video': {
          const select = document.createElement('select');
          select.add(new Option('None', ''));
          const template = context.template();
          select.add(new Option('The recording, when it is a video', RECORDING_VIDEO));
          for (const field of template.fields.filter((f) => f.kind === 'video')) select.add(new Option(`Field: ${field.label}`, `%${field.key}%`));
          for (const name of Object.keys(template.media ?? {})) select.add(new Option(`Kept: ${name}`, MEDIA_PREFIX + name));
          const value = String(current);
          if (value && ![...select.options].some((option) => option.value === value)) select.add(new Option(value.split(/[\\/]/).pop()!, value));
          select.add(new Option('Add a video…', '+'));
          select.value = value;
          select.addEventListener('change', async () => {
            if (select.value !== '+') return change(select.value);
            select.value = String(layer.params[key] ?? '');
            const picked = await context.pickVideo();
            if (!picked) return;
            context.keepVideo(key, freeName(picked.name, Object.keys(context.template().media ?? {})), picked.file);
            build();
          });
          return select;
        }
        case 'lut': {
          const template = context.template();
          return lutPicker({
            id: `setting-${key}`,
            current: String(current),
            choices: () => [
              { value: '', label: 'None' },
              ...template.fields.filter((f) => f.kind === 'lut').map((field) => ({ value: `%${field.key}%`, label: `Field: ${field.label}` })),
              ...lutChoices(context.template(), context.folderLuts()),
            ],
            choose: (value) => change(value),
            add: {
              label: 'Add a .cube file…',
              run: async () => {
                const picked = await context.pickLut();
                if (!picked) return;
                // Kept in the template, so that it travels with it.
                const { name, known } = keptLutName(context.template(), picked);
                if (known) change(LUT_PREFIX + name);
                else context.keepLut(key, name, picked.lut);
                build();
              },
            },
          });
        }
        case 'font': {
          const box = document.createElement('div');
          box.className = 'font-setting';
          const fields = context.template().fields.filter((f) => f.kind === 'font');
          const value = String(current);
          if (fields.length) {
            const select = document.createElement('select');
            select.add(new Option('Chosen here', ''));
            for (const field of fields) select.add(new Option(`Field: ${field.label}`, `%${field.key}%`));
            select.value = /^%.*%$/.test(value) ? value : '';
            select.addEventListener('change', () => {
              change(select.value || 'Sans');
              build();
            });
            box.append(select);
          }
          if (!/^%.*%$/.test(value)) box.append(fontPicker(`setting-${key}`, value, () => 'Aa Bb 123', (family) => change(family)));
          return box;
        }
      }
    }

    build();
    rebuilds.set(key, build);
    return row;
  }

  if (only) {
    const all = settingsOf(spec);
    for (const key of only) element.append(setting(key, all[key]));
  } else {
    // A group of settings with none that apply (a layer group has no placement) is left out.
    const all = settingsOf(spec);
    const own = Object.keys(spec.params);
    if (own.length) {
      const details = group(spec.label, own, true);
      // A gradient's stops as a bar to drag them on, above the settings it sets.
      if (spec.stops) {
        const bar = stopBar(layer, {
          set: (values) => (context.setMany ? context.setMany(values) : Object.entries(values).forEach(([key, value]) => context.set(key, value))),
          live: () => context.live(),
          defaults: Object.fromEntries(Object.entries(all).map(([key, param]) => [key, param.default])),
          refresh: (key) => rebuilds.get(key)?.(),
        });
        // Just above the stops' own settings, where the layer has others first.
        (details.querySelector('.setting[data-key="colour1"]') ?? details.querySelector('summary')!.nextSibling)!.before(bar.element);
        ticks.set('stop-bar', () => bar.tick());
        // The stops' own settings, folded under the bar, which sets them well enough for a gradient that holds still.
        // Opened for one to follow the music; and open by itself where one does, so that nothing moving is hidden.
        const keys = Array.from({ length: STOP_COUNT }, (_, i) => [`colour${i + 1}`, `position${i + 1}`]).flat();
        const each = document.createElement('details');
        each.className = 'stop-settings';
        const moving = keys.some((key) => isExpression(layer.params[key] ?? all[key].default, all[key]));
        each.open = moving || (opened.get('Each stop') ?? false);
        each.addEventListener('toggle', () => opened.set('Each stop', each.open));
        const summary = document.createElement('summary');
        summary.textContent = 'Each stop';
        summary.title = 'Each stop\'s colour and place as settings: to make one follow the music, or to set it exactly';
        each.append(summary, ...keys.map((key) => details.querySelector(`.setting[data-key="${key}"]`)!));
        bar.element.after(each);
      }
      element.append(details);
    }
    for (const [title, keys, open] of GROUPS) if (keys.some((key) => all[key])) element.append(group(title, keys, open));
  }
  return {
    element,
    tick() {
      for (const sync of syncs.values()) sync();
      const resolved = context.live();
      if (!resolved) return;
      for (const update of ticks.values()) update(resolved);
    },
  };
}
