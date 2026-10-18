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
//   video    a file's path, `media:name` for a video the template keeps, or
//            `recording:video` for the picture of the recording itself
//   lut      `lut:name` for a LUT the template keeps, `lutfolder:Film/Warm`
//            for Film/Warm.cube in the LUT folder, or a .cube file's path
//            (a LUT field filled in for a mix)
// Fields are used by name in expressions (`colour1`, `amount`), and as
// %field% in text. A choice, image, font, video or LUT can also be just "%field%", so
// one field can serve several layers.
//
// Kept free of Node imports: the window checks templates and draws from them.

import { parseHex, toHex, type Colour } from './colour.ts';
import { flatten, treeOf, type LayerNode } from './layer-tree.ts';
import { compile, type Compiled, type Kind, type Problem, type Value } from './expression.ts';
import { PLAYBACKS, RESTARTS } from './clip.ts';
import { unpackLut, type PackedLut } from './lut.ts';

export const TEMPLATE_FORMAT = 1;

export type ParamKind = 'number' | 'switch' | 'colour' | 'text' | 'choice' | 'image' | 'font' | 'video' | 'lut';
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
  /**
   * A number that cannot follow the music: the speed of a video, say, which
   * is added up frame by frame, and would come out differently at the
   * preview's frame rate than at the export's.
   */
  fixed?: boolean;
}

const number = (label: string, value: number, min: number, max: number, unit?: string): ParamSpec =>
  ({ kind: 'number', label, default: value, min, max, ...(unit ? { unit } : {}) });
const colour = (label: string, value: string): ParamSpec => ({ kind: 'colour', label, default: value });
const choice = (label: string, value: string, choices: string[]): ParamSpec => ({ kind: 'choice', label, default: value, choices });
const toggle = (label: string, value: boolean): ParamSpec => ({ kind: 'switch', label, default: value });
const fixed = (spec: ParamSpec): ParamSpec => ({ ...spec, fixed: true });

/** What every layer has. Positions and sizes are in percent of the frame, so a template fits any size. */
export const COMMON_PARAMS: Record<string, ParamSpec> = {
  visible: toggle('Visible', true),
  opacity: number('Opacity', 100, 0, 100, '%'),
  // "add" is also known as linear dodge.
  blend: choice('Blend', 'normal', [
    'normal', 'add', 'screen', 'lighten', 'colour dodge',
    'multiply', 'darken', 'colour burn', 'linear burn',
    'overlay', 'soft light', 'hard light', 'difference', 'exclusion',
    'hue', 'saturation', 'colour', 'luminosity',
  ]),
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

/**
 * Layer styles, as an image editor has them: made from the shape of what a
 * layer draws, and put beneath it. Every layer that draws has them, and
 * groups; effects do not. Sizes are in percent of the picture's short side.
 */
export const STYLE_PARAMS: Record<string, ParamSpec> = {
  dropShadow: toggle('Drop shadow', false),
  dropColour: colour('Colour', '#000000'),
  dropOpacity: number('Opacity', 60, 0, 100, '%'),
  dropAngle: number('Light from', 120, 0, 360, '°'),
  dropDistance: number('Distance', 0.8, 0, 10, '%'),
  dropSize: number('Softness', 1, 0, 10, '%'),
  stroke: toggle('Stroke', false),
  strokeColour: colour('Colour', '#ffffff'),
  strokeOpacity: number('Opacity', 100, 0, 100, '%'),
  strokeWidth: number('Width', 0.3, 0, 5, '%'),
  outerGlow: toggle('Outer glow', false),
  glowColour: colour('Colour', '#fff2b0'),
  glowOpacity: number('Opacity', 75, 0, 100, '%'),
  glowSize: number('Size', 2, 0, 10, '%'),
  glowSpread: number('Spread', 0, 0, 100, '%'),
  innerShadow: toggle('Inner shadow', false),
  innerShadowColour: colour('Colour', '#000000'),
  innerShadowOpacity: number('Opacity', 60, 0, 100, '%'),
  innerShadowAngle: number('Light from', 120, 0, 360, '°'),
  innerShadowDistance: number('Distance', 0.5, 0, 10, '%'),
  innerShadowSize: number('Softness', 1, 0, 10, '%'),
  innerGlow: toggle('Inner glow', false),
  innerGlowColour: colour('Colour', '#fff2b0'),
  innerGlowOpacity: number('Opacity', 75, 0, 100, '%'),
  innerGlowSize: number('Size', 2, 0, 10, '%'),
  innerGlowChoke: number('Choke', 0, 0, 100, '%'),
};

export interface LayerSpec {
  label: string;
  /** Layers that change what is beneath them instead of drawing their own picture. */
  effect?: boolean;
  params: Record<string, ParamSpec>;
  /** Which of the settings every layer has apply; all of them when not given. */
  common?: string[];
}

/** The kinds of layer, with the parameters of each besides the common ones. The first set; see VISUALS.md for more. */
export const LAYER_TYPES: Record<string, LayerSpec> = {
  solid: {
    label: 'Solid colour',
    // The whole picture in one colour: it has no place or size of its own.
    params: {
      colour: colour('Colour', '#101830'),
    },
    common: ['visible', 'opacity', 'blend', 'from', 'until', 'fadeIn', 'fadeOut'],
  },
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
  video: {
    label: 'Video',
    params: {
      video: { kind: 'video', label: 'Video', default: '' },
      playback: choice('Plays', 'loop', [...PLAYBACKS]),
      speed: fixed(number('Speed', 100, 10, 400, '%')),
      restart: choice('Starts again', 'never', [...RESTARTS]),
      inPoint: fixed(number('Clip from', 0, 0, 600, 's')),
      outPoint: fixed(number('Clip until, 0 for its end', 0, 0, 600, 's')),
      offset: fixed(number('Starts this far in', 0, 0, 600, 's')),
      fit: choice('Fit', 'cover', ['contain', 'cover', 'stretch', 'natural']),
      width: number('Width', 100, 0, 100, '%'),
      height: number('Height', 100, 0, 100, '%'),
      rounding: number('Corner rounding', 0, 0, 50, '%'),
      shadowColour: colour('Shadow colour', '#000000aa'),
      shadowBlur: number('Shadow blur', 0, 0, 10, '%'),
      tint: colour('Tint', '#ffffff'),
      tintAmount: number('Tint amount', 0, 0, 100, '%'),
      brightness: number('Brightness', 100, 0, 200, '%'),
      saturation: number('Saturation', 100, 0, 200, '%'),
      key: choice('Key out', 'none', ['none', 'colour', 'dark']),
      keyColour: colour('Key colour', '#00ff00'),
      keyTolerance: number('Key tolerance', 30, 0, 100, '%'),
      keySoftness: number('Key softness', 10, 0, 100, '%'),
    },
  },
  text: {
    label: 'Text',
    params: {
      text: { kind: 'text', label: 'Text', default: '%mixName%' },
      font: { kind: 'font', label: 'Font', default: 'Sans' },
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
  group: {
    label: 'Group',
    // Its layers are drawn together, then laid on the picture as one: shown or not, faded, mixed in.
    params: {},
    common: ['visible', 'opacity', 'blend', 'from', 'until', 'fadeIn', 'fadeOut'],
  },
  split: {
    label: 'Colour split',
    effect: true,
    params: {
      form: choice('Form', 'straight', ['straight', 'from the centre']),
      amount: number('Amount', 0.4, 0, 5, '%'),
      angle: number('Direction, when straight', 0, 0, 360, '°'),
    },
  },
  glitch: {
    label: 'Glitch',
    effect: true,
    params: {
      amount: number('How often', 30, 0, 100, '%'),
      slices: number('Slices', 10, 1, 60),
      shift: number('How far they tear', 6, 0, 40, '%'),
      split: number('Colour split', 0.6, 0, 5, '%'),
      rate: number('Changes a second', 8, 0.5, 30),
    },
  },
  adjust: {
    label: 'Brightness and contrast',
    effect: true,
    params: {
      brightness: number('Brightness', 100, 0, 300, '%'),
      contrast: number('Contrast', 100, 0, 300, '%'),
    },
  },
  hue: {
    label: 'Hue and saturation',
    effect: true,
    params: {
      hue: number('Hue', 0, -180, 180, '°'),
      saturation: number('Saturation', 100, 0, 300, '%'),
      lightness: number('Lightness', 0, -100, 100, '%'),
    },
  },
  kaleidoscope: {
    label: 'Kaleidoscope',
    effect: true,
    params: {
      segments: number('Segments', 6, 2, 24),
      angle: number('Taken from', 0, 0, 360, '°'),
      mirrored: toggle('Mirrored', true),
    },
  },
  transform: {
    label: 'Transform',
    effect: true,
    // Moves, turns and sizes the whole picture beneath, as one: its middle goes to the layer's position.
    // What shows past the picture's edges, as an editor's Transform has it: nothing, the picture again, mirrored, or its edges drawn out.
    params: {
      edges: choice('Past the edges', 'none', ['none', 'repeat', 'mirror', 'extend']),
      flipX: toggle('Flip across', false),
      flipY: toggle('Flip down', false),
    },
    common: ['visible', 'opacity', 'blend', 'x', 'y', 'scale', 'rotation', 'from', 'until', 'fadeIn', 'fadeOut'],
  },
  vignette: {
    label: 'Vignette',
    effect: true,
    // Darkens the edges of the picture beneath, round the layer's position.
    params: {
      colour: colour('Colour', '#000000'),
      size: number('Clear middle', 50, 0, 100, '%'),
      softness: number('Softness', 100, 0, 100, '%'),
      form: choice('Form', 'fits the picture', ['fits the picture', 'round']),
    },
    common: ['visible', 'opacity', 'blend', 'x', 'y', 'from', 'until', 'fadeIn', 'fadeOut'],
  },
  blur: {
    label: 'Blur',
    effect: true,
    params: {
      radius: number('Radius', 0.5, 0, 10, '%'),
    },
  },
  lut: {
    label: 'LUT',
    effect: true,
    // A look for the whole picture beneath: it has no place or size of its own. Opacity says how much of the look.
    params: {
      lut: { kind: 'lut', label: 'LUT', default: '' },
    },
    common: ['visible', 'opacity', 'blend', 'from', 'until', 'fadeIn', 'fadeOut'],
  },
};

/**
 * Every setting a layer of this kind has: those every layer has that apply to
 * it, its styles if it draws, then its own.
 */
export function settingsOf(spec: LayerSpec): Record<string, ParamSpec> {
  const common = spec.common ? Object.fromEntries(spec.common.map((key) => [key, COMMON_PARAMS[key]])) : COMMON_PARAMS;
  return { ...common, ...(spec.effect ? {} : STYLE_PARAMS), ...spec.params };
}

/**
 * The fonts a template can name, and what each stands for. Only fonts every
 * system has, under one name or another, so a template looks the same
 * wherever it is used.
 */
export const FONTS: Record<string, string> = {
  Sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  Condensed: '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", sans-serif',
  Serif: 'Georgia, "Times New Roman", serif',
  Mono: 'ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
  Rounded: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", system-ui, sans-serif',
  Impact: 'Impact, "Arial Black", sans-serif',
};

export type FieldKind = 'text' | 'colour' | 'image' | 'number' | 'choice' | 'font' | 'video' | 'lut';

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
  /** For a group: how many of the layers right after it are in it (see layer-tree.ts). */
  size?: number;
}

export interface Template {
  format: number;
  name: string;
  fields: Field[];
  layers: Layer[];
  /**
   * Pictures packed into the template, so that a template file carries
   * everything it shows: by name, as data URLs. An image setting or an
   * image field's default uses one as `asset:name`.
   */
  assets?: Record<string, string>;
  /**
   * Videos the template shows, by name; a video setting or field uses one as
   * `media:name`. Videos are too large to keep inside the template as
   * pictures are: each is a file, a small one copied into the app's media
   * folder, a large one left where it was. A template file to share carries
   * the files themselves.
   */
  media?: Record<string, MediaFile>;
  /**
   * Colour lookup tables the template keeps, by name, packed (see lut.ts); a
   * LUT setting or a LUT field's default uses one as `lut:name`. They are
   * small enough to travel inside the template, as pictures do.
   */
  luts?: Record<string, PackedLut>;
  /** Who made it and what it is, shown under the list of templates; it travels with a template file. */
  about?: TemplateAbout;
}

export interface TemplateAbout {
  author?: string;
  email?: string;
  /** An http or https address. */
  website?: string;
  description?: string;
}

/** A video a template uses: where the file is, and what tells it apart should it move. */
export interface MediaFile {
  path: string;
  bytes: number;
  /** As the app knows recordings by: their size and samples of their content. */
  fingerprint?: string;
}

/** What a video setting names to use a video the template keeps. */
export const MEDIA_PREFIX = 'media:';
/** What a LUT setting names to use a LUT the template keeps. */
export const LUT_PREFIX = 'lut:';
/**
 * What a LUT setting names to use a LUT in the LUT folder, then where it is
 * in it without the extension. Not kept in the template while it is the
 * user's own; packed into it when it is exported to share (`keepFolderLuts`).
 */
export const FOLDER_LUT_PREFIX = 'lutfolder:';
/** What a video setting names to show the recording's own picture, when the recording is a video. */
export const RECORDING_VIDEO = 'recording:video';

/** The parts of a template's about, with the most each may hold. */
export const ABOUT_LIMITS: Record<keyof TemplateAbout, number> = { author: 100, email: 200, website: 300, description: 2000 };

/** What is wrong with a value for a part of a template's about, if anything. */
export function aboutProblem(key: keyof TemplateAbout, value: string): string | null {
  if (!value) return null;
  if (value.length > ABOUT_LIMITS[key]) return `At most ${ABOUT_LIMITS[key]} characters`;
  if (key === 'website') {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'A web address, starting with https://';
    } catch {
      return 'A web address, starting with https://';
    }
  }
  if (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'An email address, such as name@example.com';
  return null;
}

/** What an image setting names to use a picture packed into the template. */
export const ASSET_PREFIX = 'asset:';
/** A packed picture: a data URL of one of the formats the app reads. */
const ASSET_DATA = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

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
export function expressionNames(fields: Field[], musicNames: readonly string[]): Record<string, Kind> {
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

  const assets: Record<string, string> = {};
  const givenAssets = typeof source.assets === 'object' && source.assets !== null ? source.assets : {};
  for (const [name, data] of Object.entries(givenAssets)) {
    if (typeof data === 'string' && ASSET_DATA.test(data)) assets[name] = data;
    else problems.push({ where: `Picture ${name}`, message: 'Not a picture the app can show (PNG, JPEG, WebP or GIF)' });
  }

  const media: Record<string, MediaFile> = {};
  const givenMedia = (typeof source.media === 'object' && source.media !== null ? source.media : {}) as Record<string, unknown>;
  for (const [name, item] of Object.entries(givenMedia)) {
    const file = (typeof item === 'object' && item !== null ? item : {}) as Partial<MediaFile>;
    if (typeof file.path !== 'string' || !file.path) {
      problems.push({ where: `Video ${name}`, message: 'Says nowhere where the video is' });
      continue;
    }
    media[name] = {
      path: file.path,
      bytes: Number.isFinite(file.bytes) ? Number(file.bytes) : 0,
      ...(typeof file.fingerprint === 'string' ? { fingerprint: file.fingerprint } : {}),
    };
  }

  const luts: Record<string, PackedLut> = {};
  const givenLuts = (typeof source.luts === 'object' && source.luts !== null ? source.luts : {}) as Record<string, unknown>;
  for (const [name, item] of Object.entries(givenLuts)) {
    try {
      unpackLut(item);
      luts[name] = item as PackedLut;
    } catch (error) {
      problems.push({ where: `LUT ${name}`, message: (error as Error).message });
    }
  }

  const about: TemplateAbout = {};
  const givenAbout = (typeof source.about === 'object' && source.about !== null ? source.about : {}) as Record<string, unknown>;
  for (const key of Object.keys(ABOUT_LIMITS) as (keyof TemplateAbout)[]) {
    const value = givenAbout[key];
    if (value === undefined || value === '') continue;
    const text = typeof value === 'string' ? value.trim() : '';
    const problem = typeof value === 'string' ? aboutProblem(key, text) : 'Should be text';
    if (problem) problems.push({ where: `About, ${key}`, message: problem });
    else if (text) about[key] = text;
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
    const kinds: FieldKind[] = ['text', 'colour', 'image', 'number', 'choice', 'font', 'video', 'lut'];
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

  // One entry per layer given, a stand-in for one that cannot be used, so that the groups'
  // counts still mean what they meant; the stand-ins are taken out once the groups are known.
  const DROPPED = '';
  const entries: Layer[] = [];
  for (const [index, item] of (Array.isArray(source.layers) ? source.layers : []).entries()) {
    const layer = (typeof item === 'object' && item !== null ? item : {}) as Partial<Layer>;
    const spec = LAYER_TYPES[layer.type as string];
    const title = `Layer ${index + 1}${spec ? ` (${layer.name || spec.label})` : ''}`;
    if (!spec) {
      problems.push({ where: `Layer ${index + 1}`, message: `Unknown kind of layer: ${String(layer.type)}` });
      entries.push({ type: DROPPED, params: {} });
      continue;
    }
    const given = (typeof layer.params === 'object' && layer.params !== null ? layer.params : {}) as Record<string, unknown>;
    const all = settingsOf(spec);
    for (const key of Object.keys(given)) {
      if (!(key in all)) problems.push({ where: title, message: `${spec.label} has no setting called ${key}` });
    }
    const params: Record<string, ParamValue> = {};
    for (const [key, param] of Object.entries(all)) {
      const where = `${title}, ${param.label}`;
      const value = given[key];
      const problem = value === undefined ? null : checkValue(value, param, names, fieldOf, { assets, media, luts });
      if (problem) problems.push({ where, ...problem });
      params[key] = value === undefined || problem ? param.default : (value as ParamValue);
    }
    entries.push({
      type: layer.type!,
      ...(typeof layer.name === 'string' && layer.name ? { name: layer.name } : {}),
      params,
      ...(layer.type === 'group' ? { size: Number.isFinite(layer.size) ? Number(layer.size) : 0 } : {}),
    });
  }
  const usable = (nodes: LayerNode[]): LayerNode[] =>
    nodes.filter((node) => node.layer.type !== DROPPED).map((node) => (node.children ? { ...node, children: usable(node.children) } : node));
  const layers = flatten(usable(treeOf(entries)));

  return {
    template: {
      format: TEMPLATE_FORMAT,
      name: typeof source.name === 'string' && source.name ? source.name : 'Untitled',
      fields,
      layers,
      ...(Object.keys(assets).length ? { assets } : {}),
      ...(Object.keys(media).length ? { media } : {}),
      ...(Object.keys(luts).length ? { luts } : {}),
      ...(Object.keys(about).length ? { about } : {}),
    },
    problems,
  };
}

/**
 * What is wrong with one setting's value in a template, if anything: as the
 * template is checked, for the editor to say while it is being typed.
 */
export function checkSetting(
  template: Template, value: unknown, param: ParamSpec, musicNames: readonly string[], textNames: readonly string[],
): Omit<TemplateProblem, 'where'> | null {
  const names: Names = {
    expressions: expressionNames(template.fields, musicNames),
    text: [...textNames, ...template.fields.map((field) => field.key)],
  };
  return checkValue(value, param, names, (key) => template.fields.find((field) => field.key === key),
    { assets: template.assets ?? {}, media: template.media ?? {}, luts: template.luts ?? {} });
}

/** What is wrong with one parameter's value, if anything. */
function checkValue(
  value: unknown, param: ParamSpec, names: Names, fieldOf: (key: string) => Field | undefined,
  { assets, media, luts }: { assets: Record<string, string>; media: Record<string, MediaFile>; luts: Record<string, PackedLut> },
): Omit<TemplateProblem, 'where'> | null {
  const whole = typeof value === 'string' ? WHOLE_VARIABLE.exec(value) : null;
  switch (param.kind) {
    case 'number':
    case 'switch': {
      if (param.fixed && typeof value !== 'number') return { message: 'Should be a number; this one cannot follow the music' };
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
      if (param.kind === 'image' && value.startsWith(ASSET_PREFIX) && !(value.slice(ASSET_PREFIX.length) in assets)) {
        return { message: `No picture called ${value.slice(ASSET_PREFIX.length)} is packed into this template` };
      }
      return null;
    }
    case 'video': {
      if (typeof value !== 'string') return { message: 'Should be a video' };
      if (whole) return fieldOf(whole[1])?.kind === 'video' ? null : { message: `${whole[1]} is not a video field of this template` };
      if (value.startsWith(MEDIA_PREFIX) && !(value.slice(MEDIA_PREFIX.length) in media)) {
        return { message: `This template keeps no video called ${value.slice(MEDIA_PREFIX.length)}` };
      }
      return null;
    }
    case 'lut': {
      if (typeof value !== 'string') return { message: 'Should be a LUT' };
      if (whole) return fieldOf(whole[1])?.kind === 'lut' ? null : { message: `${whole[1]} is not a LUT field of this template` };
      if (value.startsWith(LUT_PREFIX) && !(value.slice(LUT_PREFIX.length) in luts)) {
        return { message: `This template keeps no LUT called ${value.slice(LUT_PREFIX.length)}` };
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
  /** What the last call of `resolve` gave, for the editor to show; null before the first. */
  readonly last: ResolvedParams | null;
  /** For a group: how many of the layers after it are in it; 0 for any other layer. */
  size: number;
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
    const all = settingsOf(spec);
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
    let last: ResolvedParams | null = null;
    return {
      type: layer.type,
      spec,
      size: layer.type === 'group' ? Math.max(0, Math.floor(layer.size ?? 0)) : 0,
      resolve(music, text) {
        const values = { ...music, ...fieldNumbers };
        const resolved: ResolvedParams = { ...fixed };
        for (const [key, compiled, kind] of expressions) {
          const result = compiled.evaluate(values);
          resolved[key] = kind === 'switch' ? result !== 0 : result;
        }
        for (const [key, value] of texts) resolved[key] = fillText(value, { ...text, ...fieldTexts }).text;
        last = resolved;
        return resolved;
      },
      get last() {
        return last;
      },
      reset() {
        for (const [, compiled] of expressions) compiled.reset();
      },
    };
  });
}

/** The fonts a template draws with, given what was filled in: to be loaded before drawing. */
export function fontsOf(template: Template, filled: Record<string, string | number>): string[] {
  const fonts = new Set<string>();
  for (const layer of template.layers) {
    const value = layer.params.font;
    if (typeof value !== 'string') continue;
    const whole = WHOLE_VARIABLE.exec(value);
    const field = whole ? template.fields.find((f) => f.key === whole[1]) : undefined;
    fonts.add(field ? String(filled[field.key] ?? field.default) : value);
  }
  return [...fonts];
}

/**
 * Every picture a template shows with what was filled in: those of its image
 * fields, and those its image layers name themselves. Each is a file's path,
 * or `asset:name` for one packed into the template.
 */
export function imagesOf(template: Template, filled: Record<string, string | number>): string[] {
  const images = new Set<string>();
  for (const field of template.fields) {
    const value = String(filled[field.key] ?? field.default);
    if (field.kind === 'image' && value) images.add(value);
  }
  for (const layer of template.layers) {
    const value = layer.params.image;
    if (typeof value === 'string' && value && !WHOLE_VARIABLE.test(value)) images.add(value);
  }
  return [...images];
}

/**
 * Every LUT a template uses with what was filled in: each as `lut:name` for
 * one it keeps, or a .cube file's path.
 */
export function lutsOf(template: Template, filled: Record<string, string | number>): string[] {
  const luts = new Set<string>();
  for (const field of template.fields) {
    const value = String(filled[field.key] ?? field.default);
    if (field.kind === 'lut' && value) luts.add(value);
  }
  for (const layer of template.layers) {
    const value = layer.params.lut;
    if (layer.type === 'lut' && typeof value === 'string' && value && !WHOLE_VARIABLE.test(value)) luts.add(value);
  }
  return [...luts];
}

/** The LUTs of the LUT folder a template names, in its layers and its fields' defaults, by their names in the folder. */
export function folderLutsOf(template: Template): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.startsWith(FOLDER_LUT_PREFIX)) names.add(value.slice(FOLDER_LUT_PREFIX.length));
  };
  for (const field of template.fields) if (field.kind === 'lut') add(field.default);
  for (const layer of template.layers) if (layer.type === 'lut') add(layer.params.lut);
  return [...names];
}

/**
 * A copy of the template that keeps the LUT folder's LUTs it names, `packed`
 * by their names in the folder, and names them as kept: for a template file
 * to share, which has to work without the folder. A LUT kept already with
 * the same table is used rather than kept twice.
 */
export function keepFolderLuts(template: Template, packed: Record<string, PackedLut>): Template {
  const copy = structuredClone(template);
  const luts: Record<string, PackedLut> = { ...copy.luts };
  const keptAs = new Map<string, string>();
  for (const [name, lut] of Object.entries(packed)) {
    let as = Object.keys(luts).find((other) => luts[other].data === lut.data && luts[other].size === lut.size);
    if (!as) {
      const wanted = name.split('/').pop()!;
      as = wanted;
      for (let n = 2; as in luts; n++) as = `${wanted} ${n}`;
      luts[as] = lut;
    }
    keptAs.set(FOLDER_LUT_PREFIX + name, LUT_PREFIX + as);
  }
  for (const field of copy.fields) if (field.kind === 'lut') field.default = keptAs.get(String(field.default)) ?? field.default;
  for (const layer of copy.layers) {
    if (layer.type === 'lut' && typeof layer.params.lut === 'string') layer.params.lut = keptAs.get(layer.params.lut) ?? layer.params.lut;
  }
  if (Object.keys(luts).length) copy.luts = luts;
  return copy;
}

/**
 * Every video a template shows with what was filled in: each as a file's
 * path, `media:name` or `recording:video`, as `videoFile` takes them.
 */
export function videosOf(template: Template, filled: Record<string, string | number>): string[] {
  const videos = new Set<string>();
  for (const field of template.fields) {
    const value = String(filled[field.key] ?? field.default);
    if (field.kind === 'video' && value) videos.add(value);
  }
  for (const layer of template.layers) {
    const value = layer.params.video;
    if (layer.type === 'video' && typeof value === 'string' && value && !WHOLE_VARIABLE.test(value)) videos.add(value);
  }
  return [...videos];
}

/**
 * The file a video setting's value stands for: the template's own video, the
 * recording when it is a video, or a path as it is. Null for none.
 */
export function videoFile(source: string, template: Template, recording: { path: string; video: boolean } | null): string | null {
  if (!source) return null;
  if (source === RECORDING_VIDEO) return recording?.video ? recording.path : null;
  if (source.startsWith(MEDIA_PREFIX)) return template.media?.[source.slice(MEDIA_PREFIX.length)]?.path ?? null;
  return source;
}

/** Whether a name will do for a new field: letters, digits and _, not starting with a digit, and not taken. */
export function fieldNameProblem(template: Template, name: string, musicNames: readonly string[], textNames: readonly string[], except?: string): string | null {
  if (!FIELD_KEY.test(name)) return 'Letters and digits only, starting with a letter';
  if (name !== except && (template.fields.some((field) => field.key === name) || musicNames.includes(name) || textNames.includes(name))) {
    return `The name ${name} is already taken`;
  }
  return null;
}

/**
 * Renames a field, and the field wherever a setting uses it: as a name in an
 * expression, between percent signs in a text, or as a whole `%name%`.
 */
export function renameField(template: Template, from: string, to: string): void {
  const field = template.fields.find((f) => f.key === from);
  if (!field) return;
  field.key = to;
  const escaped = from.replace(/[$]/g, '\\$&');
  // A name in an expression: not part of a longer name.
  const asName = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_(])`, 'g');
  const asVariable = new RegExp(`%${escaped}%`, 'g');
  for (const layer of template.layers) {
    const spec = LAYER_TYPES[layer.type];
    if (!spec) continue;
    const all = settingsOf(spec);
    for (const [key, value] of Object.entries(layer.params)) {
      if (typeof value !== 'string' || !all[key]) continue;
      const kind = all[key].kind;
      layer.params[key] = kind === 'number' || kind === 'switch' || kind === 'colour' ? value.replace(asName, to) : value.replace(asVariable, `%${to}%`);
    }
  }
}

/** A resolved colour as a hex code, for drawing with a 2D canvas. */
export const hexOf = (colour: Colour | null) => (colour ? toHex(colour) : 'transparent');
