// What a template for a video is: a stack of layers, each with parameters,
// and the fields it asks whoever uses it to fill in. Templates are kept as
// JSON and shared, so anything read in is checked here before use, and every
// problem is reported with where it is rather than silently ignored.
//
// Values of parameters:
//   number   a number, or an expression (expression.ts) as text
//   switch   true or false, or an expression: on when it is not 0
//   colour   an expression giving a colour: "#3ddc97", "colour1 * 0.5",
//            "complement(colour1)"; or "" for none
//   text     any text; %name% is replaced by a variable (see fillText)
//   choice   one of the parameter's choices
//   image, font  a name
// Fields are used by name in expressions (`colour1`, `amount`), and as
// %field% in text. A choice, image or font can also be just "%field%", so
// one field can serve several layers.
//
// Kept free of Node imports: the window checks templates and draws from them.

import { parseHex, toHex, type Colour } from './colour.ts';
import { compile, type Compiled, type Kind, type Problem, type Value } from './expression.ts';

export const TEMPLATE_FORMAT = 1;

export type ParamKind = 'number' | 'switch' | 'colour' | 'text' | 'choice' | 'image' | 'font';
export type ParamValue = number | boolean | string;

export interface ParamSpec {
  kind: ParamKind;
  label: string;
  default: ParamValue;
  /** For numbers: the range a knob covers. Expressions may go past it. */
  min?: number;
  max?: number;
  unit?: string;
  choices?: string[];
}

const number = (label: string, value: number, min: number, max: number, unit?: string): ParamSpec =>
  ({ kind: 'number', label, default: value, min, max, ...(unit ? { unit } : {}) });
const colour = (label: string, value: string): ParamSpec => ({ kind: 'colour', label, default: value });
const choice = (label: string, value: string, choices: string[]): ParamSpec => ({ kind: 'choice', label, default: value, choices });
const toggle = (label: string, value: boolean): ParamSpec => ({ kind: 'switch', label, default: value });

/** What every layer has. Positions and sizes are in percent of the frame, so a template fits any size. */
export const COMMON_PARAMS: Record<string, ParamSpec> = {
  visible: toggle('Visible', true),
  opacity: number('Opacity', 100, 0, 100, '%'),
  blend: choice('Blend', 'normal', ['normal', 'add', 'screen', 'multiply', 'overlay', 'difference']),
  x: number('Across', 50, 0, 100, '%'),
  y: number('Down', 50, 0, 100, '%'),
  anchor: choice('Anchor', 'centre', ['centre', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right']),
  scale: number('Scale', 100, 0, 400, '%'),
  rotation: number('Rotation', 0, -180, 180, '°'),
  from: number('Shown from', 0, 0, 36000, 's'),
  until: number('Shown until, before the end', 0, 0, 36000, 's'),
  fadeIn: number('Fade in', 0, 0, 30, 's'),
  fadeOut: number('Fade out', 0, 0, 30, 's'),
};

export interface LayerSpec {
  label: string;
  /** Layers that change what is beneath them instead of drawing their own picture. */
  effect?: boolean;
  params: Record<string, ParamSpec>;
}

/** The kinds of layer, with the parameters of each besides the common ones. The first set; see VISUALS.md for more. */
export const LAYER_TYPES: Record<string, LayerSpec> = {
  gradient: {
    label: 'Gradient',
    params: {
      kind: choice('Kind', 'linear', ['linear', 'radial', 'conic']),
      colour1: colour('Colour 1', '#101830'),
      colour2: colour('Colour 2', '#2a0f3c'),
      colour3: colour('Colour 3', ''),
      angle: number('Angle', 90, 0, 360, '°'),
      drift: number('Drift', 0, 0, 90, '°/s'),
      hueShift: number('Hue shift', 0, 0, 60, '°/s'),
    },
  },
  particles: {
    label: 'Glitter',
    params: {
      count: number('Count', 300, 0, 5000),
      sizeLow: number('Smallest', 0.2, 0, 5, '%'),
      sizeHigh: number('Largest', 0.8, 0, 5, '%'),
      colour1: colour('Colour 1', '#ffffff'),
      colour2: colour('Colour 2', ''),
      colour3: colour('Colour 3', ''),
      shape: choice('Shape', 'soft dot', ['dot', 'soft dot', 'star', 'sparkle']),
      speed: number('Speed', 5, 0, 100, '%/s'),
      direction: number('Direction', 270, 0, 360, '°'),
      spread: number('Spread', 30, 0, 360, '°'),
      turbulence: number('Turbulence', 10, 0, 100, '%'),
      lifetime: number('Lifetime', 6, 0.1, 60, 's'),
      twinkle: number('Twinkle', 2, 0, 20, 'Hz'),
      twinkleDepth: number('Twinkle depth', 50, 0, 100, '%'),
      area: choice('Starts from', 'everywhere', ['everywhere', 'bottom', 'top', 'left', 'right', 'centre']),
      burst: number('Burst on beat', 0, 0, 500),
    },
  },
  image: {
    label: 'Image',
    params: {
      image: { kind: 'image', label: 'Image', default: '' },
      fit: choice('Fit', 'contain', ['contain', 'cover', 'stretch', 'natural']),
      width: number('Width', 30, 0, 100, '%'),
      height: number('Height', 30, 0, 100, '%'),
      rounding: number('Corner rounding', 0, 0, 50, '%'),
      shadowColour: colour('Shadow colour', '#000000aa'),
      shadowBlur: number('Shadow blur', 0, 0, 10, '%'),
      tint: colour('Tint', '#ffffff'),
      tintAmount: number('Tint amount', 0, 0, 100, '%'),
      brightness: number('Brightness', 100, 0, 200, '%'),
      saturation: number('Saturation', 100, 0, 200, '%'),
    },
  },
  text: {
    label: 'Text',
    params: {
      text: { kind: 'text', label: 'Text', default: '%mixName%' },
      font: { kind: 'font', label: 'Font', default: 'Inter' },
      weight: number('Weight', 600, 100, 900),
      size: number('Size', 6, 0.5, 40, '%'),
      colour: colour('Colour', '#ffffff'),
      align: choice('Alignment', 'centre', ['left', 'centre', 'right']),
      letterSpacing: number('Letter spacing', 0, -10, 50, '%'),
      lineHeight: number('Line height', 120, 50, 300, '%'),
      width: number('Wrap at', 90, 5, 100, '%'),
      case: choice('Case', 'as written', ['as written', 'upper', 'lower']),
      outlineWidth: number('Outline', 0, 0, 5, '%'),
      outlineColour: colour('Outline colour', '#000000'),
      shadowColour: colour('Shadow colour', '#00000088'),
      shadowBlur: number('Shadow blur', 0, 0, 10, '%'),
      boxColour: colour('Box colour', ''),
      boxPadding: number('Box padding', 1, 0, 10, '%'),
      change: choice('When the text changes', 'fade', ['cut', 'fade', 'slide', 'typewriter']),
      changeSeconds: number('Change takes', 0.6, 0, 5, 's'),
      hideWhenEmpty: toggle('Hide when empty', true),
    },
  },
  spectrum: {
    label: 'Spectrum',
    params: {
      bars: number('Bars', 48, 4, 256),
      lowHz: number('Lowest', 30, 20, 1000, 'Hz'),
      highHz: number('Highest', 16000, 1000, 20000, 'Hz'),
      width: number('Width', 80, 0, 100, '%'),
      height: number('Height', 25, 0, 100, '%'),
      gap: number('Gap between bars', 30, 0, 90, '%'),
      rounded: toggle('Rounded ends', true),
      colourLow: colour('Colour, low bars', '#3ddc97'),
      colourHigh: colour('Colour, high bars', '#6aa9ff'),
      colouring: choice('Colouring', 'along', ['one colour', 'along', 'by height']),
      mirrored: toggle('Mirrored', false),
      rise: number('Rise time', 0.03, 0, 1, 's'),
      fall: number('Fall time', 0.25, 0, 2, 's'),
      peaks: toggle('Peak markers', false),
      form: choice('Form', 'straight', ['straight', 'circle']),
      radius: number('Radius, as a circle', 20, 0, 50, '%'),
    },
  },
  waveform: {
    label: 'Waveform',
    params: {
      style: choice('Style', 'mirrored', ['line', 'filled', 'mirrored']),
      seconds: number('Time shown', 4, 0.01, 30, 's'),
      width: number('Width', 80, 0, 100, '%'),
      height: number('Height', 20, 0, 100, '%'),
      lineWidth: number('Line width', 0.3, 0.05, 3, '%'),
      colour: colour('Colour', '#3ddc97'),
      form: choice('Form', 'straight', ['straight', 'circle']),
      radius: number('Radius, as a circle', 20, 0, 50, '%'),
    },
  },
  glow: {
    label: 'Glow',
    effect: true,
    params: {
      threshold: number('Threshold', 60, 0, 100, '%'),
      strength: number('Strength', 60, 0, 300, '%'),
      radius: number('Radius', 2, 0, 20, '%'),
      tint: colour('Tint', '#ffffff'),
    },
  },
};

export type FieldKind = 'text' | 'colour' | 'image' | 'number' | 'choice' | 'font';

/** Something the template asks whoever uses it to fill in. */
export interface Field {
  /** The name it goes by in the template: %key% in text, `key` in expressions. */
  key: string;
  label: string;
  kind: FieldKind;
  default: string | number;
  min?: number;
  max?: number;
  choices?: string[];
}

export interface Layer {
  type: string;
  name?: string;
  params: Record<string, ParamValue>;
}

export interface Template {
  format: number;
  name: string;
  fields: Field[];
  layers: Layer[];
}

export interface TemplateProblem extends Partial<Problem> {
  /** Where, for a person: "Layer 2 (Text), Size". */
  where: string;
  message: string;
}

const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A value that is nothing but one variable: "%colour1%". */
const WHOLE_VARIABLE = /^%([A-Za-z_][A-Za-z0-9_]*)%$/;

// ---------------------------------------------------------------------------
// Variables in text

/** The variables the app gives every text, besides the template's own fields. See VISUALS.md. */
export const TEXT_VARIABLES = [
  'mixName', 'mixNumber', 'mixCount', 'mixLength', 'elapsed', 'remaining',
  'artist', 'title', 'album', 'recordingName', 'date',
  'currentTrack', 'currentArtist', 'currentTitle', 'trackNumber', 'trackCount', 'nextTrack', 'tempo',
] as const;

export type TextValues = Record<string, string | number>;

/**
 * Text with each %name% replaced by its value and %% by a percent sign. A
 * name that has no value is left as written, and listed, so that an editor
 * can point it out. Numbers are shown whole.
 */
export function fillText(text: string, values: TextValues): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const filled = text.replace(/%%|%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name: string | undefined) => {
    if (!name) return '%';
    if (!(name in values)) {
      unknown.push(name);
      return match;
    }
    const value = values[name];
    return typeof value === 'number' ? String(Math.round(value)) : value;
  });
  return { text: filled, unknown };
}

/** The variables a text uses, with where each is, for checking and underlining. */
export function variablesIn(text: string): { name: string; start: number; end: number }[] {
  return [...text.matchAll(/%%|%([A-Za-z_][A-Za-z0-9_]*)%/g)]
    .filter((match) => match[1])
    .map((match) => ({ name: match[1], start: match.index!, end: match.index! + match[0].length }));
}

// ---------------------------------------------------------------------------
// Checking

export interface Names {
  /** Names expressions may use, and whether each is a number or a colour: the music values and the template's number and colour fields. */
  expressions: Record<string, Kind>;
  /** Names text may use: the app's text variables and all of the template's fields. */
  text: string[];
}

/** The names a template's expressions may use: the music values, and its number and colour fields. */
function expressionNames(fields: Field[], musicNames: readonly string[]): Record<string, Kind> {
  const names: Record<string, Kind> = Object.fromEntries(musicNames.map((name) => [name, 'number' as Kind]));
  for (const field of fields) if (field.kind === 'number' || field.kind === 'colour') names[field.key] = field.kind;
  return names;
}

/**
 * Checks a template read from anywhere and gives back one that can be used:
 * every layer of a known type, every parameter present and of the right
 * kind, expressions that compile. Whatever is wrong is listed, and replaced
 * by the parameter's default, so that a slightly broken template still draws.
 * `textNames` are the variables the app provides to text.
 */
export function checkTemplate(raw: unknown, musicNames: readonly string[], textNames: readonly string[]): {
  template: Template;
  problems: TemplateProblem[];
} {
  const problems: TemplateProblem[] = [];
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Template>;
  if (typeof raw !== 'object' || raw === null) problems.push({ where: 'Template', message: 'This is not a template' });
  if (source.format !== undefined && source.format !== TEMPLATE_FORMAT) {
    problems.push({ where: 'Template', message: `Made for a newer version of the app (format ${source.format})` });
  }

  const fields: Field[] = [];
  for (const [index, item] of (Array.isArray(source.fields) ? source.fields : []).entries()) {
    const where = `Field ${index + 1}`;
    const field = item as Partial<Field>;
    if (typeof field.key !== 'string' || !FIELD_KEY.test(field.key)) {
      problems.push({ where, message: 'Needs a name of letters and digits, starting with a letter' });
      continue;
    }
    if (fields.some((other) => other.key === field.key) || musicNames.includes(field.key) || textNames.includes(field.key)) {
      problems.push({ where: `${where} (${field.key})`, message: `The name ${field.key} is already taken` });
      continue;
    }
    const kinds: FieldKind[] = ['text', 'colour', 'image', 'number', 'choice', 'font'];
    const kind = kinds.includes(field.kind as FieldKind) ? (field.kind as FieldKind) : 'text';
    fields.push({
      key: field.key,
      label: typeof field.label === 'string' && field.label ? field.label : field.key,
      kind,
      default: kind === 'number' ? (Number.isFinite(field.default) ? Number(field.default) : 0) : String(field.default ?? ''),
      ...(kind === 'number' && Number.isFinite(field.min) ? { min: field.min } : {}),
      ...(kind === 'number' && Number.isFinite(field.max) ? { max: field.max } : {}),
      ...(kind === 'choice' && Array.isArray(field.choices) ? { choices: field.choices.map(String) } : {}),
    });
  }
  const names: Names = {
    expressions: expressionNames(fields, musicNames),
    text: [...textNames, ...fields.map((field) => field.key)],
  };
  const fieldOf = (key: string) => fields.find((field) => field.key === key);

  const layers: Layer[] = [];
  for (const [index, item] of (Array.isArray(source.layers) ? source.layers : []).entries()) {
    const layer = (typeof item === 'object' && item !== null ? item : {}) as Partial<Layer>;
    const spec = LAYER_TYPES[layer.type as string];
    const title = `Layer ${index + 1}${spec ? ` (${layer.name || spec.label})` : ''}`;
    if (!spec) {
      problems.push({ where: `Layer ${index + 1}`, message: `Unknown kind of layer: ${String(layer.type)}` });
      continue;
    }
    const given = (typeof layer.params === 'object' && layer.params !== null ? layer.params : {}) as Record<string, unknown>;
    const all = { ...COMMON_PARAMS, ...spec.params };
    for (const key of Object.keys(given)) {
      if (!(key in all)) problems.push({ where: title, message: `${spec.label} has no setting called ${key}` });
    }
    const params: Record<string, ParamValue> = {};
    for (const [key, param] of Object.entries(all)) {
      const where = `${title}, ${param.label}`;
      const value = given[key];
      const problem = value === undefined ? null : checkValue(value, param, names, fieldOf);
      if (problem) problems.push({ where, ...problem });
      params[key] = value === undefined || problem ? param.default : (value as ParamValue);
    }
    layers.push({ type: layer.type!, ...(typeof layer.name === 'string' && layer.name ? { name: layer.name } : {}), params });
  }

  return {
    template: {
      format: TEMPLATE_FORMAT,
      name: typeof source.name === 'string' && source.name ? source.name : 'Untitled',
      fields,
      layers,
    },
    problems,
  };
}

/** What is wrong with one parameter's value, if anything. */
function checkValue(
  value: unknown, param: ParamSpec, names: Names, fieldOf: (key: string) => Field | undefined,
): Omit<TemplateProblem, 'where'> | null {
  const whole = typeof value === 'string' ? WHOLE_VARIABLE.exec(value) : null;
  switch (param.kind) {
    case 'number':
    case 'switch': {
      if (typeof value === 'number' || (param.kind === 'switch' && typeof value === 'boolean')) return null;
      if (typeof value !== 'string') return { message: `Should be ${param.kind === 'switch' ? 'on or off' : 'a number'} or an expression` };
      const compiled = compile(value, names.expressions, 'number');
      return compiled.ok ? null : compiled.problem;
    }
    case 'colour': {
      if (typeof value !== 'string') return { message: 'Should be a colour such as #3ddc97, or an expression' };
      if (value === '') return null;
      if (whole) return { message: `Use the field by its name, without percent signs: ${whole[1]}` };
      const compiled = compile(value, names.expressions, 'colour');
      return compiled.ok ? null : compiled.problem;
    }
    case 'choice': {
      if (typeof value !== 'string') return { message: `Should be one of: ${param.choices!.join(', ')}` };
      if (whole && fieldOf(whole[1])?.kind === 'choice') return null;
      return param.choices!.includes(value) ? null : { message: `Should be one of: ${param.choices!.join(', ')}` };
    }
    case 'text': {
      if (typeof value !== 'string') return { message: 'Should be text' };
      const unknown = variablesIn(value).find((variable) => !names.text.includes(variable.name));
      return unknown
        ? { message: `There is no variable called ${unknown.name}`, start: unknown.start, end: unknown.end }
        : null;
    }
    case 'image':
    case 'font': {
      if (typeof value !== 'string') return { message: `Should be the name of ${param.kind === 'image' ? 'an image' : 'a font'}` };
      if (whole) {
        const field = fieldOf(whole[1]);
        return field?.kind === param.kind ? null : { message: `${whole[1]} is not ${param.kind === 'image' ? 'an image' : 'a font'} field of this template` };
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Using a checked template

export type ResolvedParams = Record<string, number | boolean | string | Colour | null>;

/** A layer ready to draw from: its parameters worked out for any frame. */
export interface PreparedLayer {
  type: string;
  spec: LayerSpec;
  /**
   * The parameters for a frame, with fields and variables filled in and
   * expressions evaluated. A colour comes out as a Colour, or null for none.
   */
  resolve(music: Record<string, Value>, text: TextValues): ResolvedParams;
  /** Forgets what smoothing functions remember, after a jump in time. */
  reset(): void;
}

/**
 * Prepares a checked template, with what its user filled in, for drawing.
 * Fields left unfilled take their defaults.
 */
export function prepare(template: Template, filled: Record<string, string | number>, musicNames: readonly string[]): PreparedLayer[] {
  const fieldValues: Record<string, string | number> = {};
  for (const field of template.fields) fieldValues[field.key] = filled[field.key] ?? field.default;
  // Number and colour fields, as expressions see them.
  const fieldNumbers: Record<string, Value> = {};
  for (const field of template.fields) {
    if (field.kind === 'number') fieldNumbers[field.key] = Number(fieldValues[field.key]) || 0;
    if (field.kind === 'colour') fieldNumbers[field.key] = parseHex(String(fieldValues[field.key])) ?? { r: 0, g: 0, b: 0, a: 1 };
  }
  // In text, a colour field shows as its hex code.
  const fieldTexts: TextValues = { ...fieldValues };
  const known = expressionNames(template.fields, musicNames);

  return template.layers.map((layer) => {
    const spec = LAYER_TYPES[layer.type];
    const all = { ...COMMON_PARAMS, ...spec.params };
    const expressions: [string, Compiled, ParamKind][] = [];
    const fixed: ResolvedParams = {};
    const texts: [string, string][] = [];
    for (const [key, param] of Object.entries(all)) {
      const value = layer.params[key] ?? param.default;
      if (param.kind === 'colour') {
        if (value === '') {
          fixed[key] = null;
          continue;
        }
        const compiled = compile(String(value), known, 'colour');
        // Checked already; a template changed since falls back to the default.
        if (compiled.ok) expressions.push([key, compiled.compiled, 'colour']);
        else fixed[key] = parseHex(String(param.default));
      } else if ((param.kind === 'number' || param.kind === 'switch') && typeof value === 'string') {
        const compiled = compile(value, known, 'number');
        if (compiled.ok) expressions.push([key, compiled.compiled, param.kind]);
        else fixed[key] = param.default;
      } else if (param.kind === 'text') {
        texts.push([key, String(value)]);
      } else {
        const whole = typeof value === 'string' ? WHOLE_VARIABLE.exec(value) : null;
        fixed[key] = whole && whole[1] in fieldValues ? fieldValues[whole[1]] : value;
      }
    }
    return {
      type: layer.type,
      spec,
      resolve(music, text) {
        const values = { ...music, ...fieldNumbers };
        const resolved: ResolvedParams = { ...fixed };
        for (const [key, compiled, kind] of expressions) {
          const result = compiled.evaluate(values);
          resolved[key] = kind === 'switch' ? result !== 0 : result;
        }
        for (const [key, value] of texts) resolved[key] = fillText(value, { ...text, ...fieldTexts }).text;
        return resolved;
      },
      reset() {
        for (const [, compiled] of expressions) compiled.reset();
      },
    };
  });
}

/** A resolved colour as a hex code, for drawing with a 2D canvas. */
export const hexOf = (colour: Colour | null) => (colour ? toHex(colour) : 'transparent');
