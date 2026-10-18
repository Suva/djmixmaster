// The small language a template's number parameters are written in, such as
// `1 + 0.5 * smooth(bass, 0.01, 0.25)`. It is ours rather than JavaScript on
// purpose: templates are shared, and an expression can only ever work out a
// number from the values it is given. Knobs in an editor write expressions in
// it too, so there is one way for a parameter to move.
//
//   numbers      0.5, 2, .25
//   colours      #3ddc97, #3ddc9780 (with alpha), #fff
//   names        bass, beats, time, a field of the template ...
//   operators    + - * / % ^ (power), comparisons < <= > >= == != giving 1 or 0,
//                and `condition ? then : else`
//   functions    see FUNCTIONS below
//
// An expression gives either a number or a colour, and which it is follows
// from what it is made of, as in a shader: `colour1 * 0.5` is a colour,
// `lightness(colour1)` a number. Colours do arithmetic part by part (red with
// red, and so on); colour.ts holds what works on hue and lightness.
//
// Kept free of Node imports: the window compiles and runs these every frame.

import {
  fromHsl, fromLch, isColour, lighten, mixColours, parseHex, saturate, toLch, turnHue, type Colour,
} from './colour.ts';

export interface Problem {
  message: string;
  /** Where in the text, as character offsets, for underlining. */
  start: number;
  end: number;
}

export type Kind = 'number' | 'colour';
export type Value = number | Colour;

/** The values a frame provides, by name. `dt`, the seconds since the frame before, is always there. */
export type Values = Record<string, Value>;

export interface Compiled {
  /** Whether it gives a number or a colour. */
  kind: Kind;
  /** The value for this frame. A number is never NaN or infinite: that comes out as 0. */
  evaluate(values: Values): Value;
  /** Forgets what stateful functions such as `smooth` remember, as after a jump in time. */
  reset(): void;
  /** The names the expression uses. */
  names: string[];
}

export type Compilation = { ok: true; compiled: Compiled } | { ok: false; problem: Problem };

type Node =
  | { kind: 'number'; value: number; start: number; end: number }
  | { kind: 'colour'; value: Colour; start: number; end: number }
  | { kind: 'name'; name: string; start: number; end: number }
  | { kind: 'unary'; operator: '-'; operand: Node; start: number; end: number }
  | { kind: 'binary'; operator: string; left: Node; right: Node; start: number; end: number }
  | { kind: 'choice'; condition: Node; then: Node; otherwise: Node; start: number; end: number }
  | { kind: 'call'; name: string; args: Node[]; start: number; end: number };

interface Token {
  kind: 'number' | 'colour' | 'name' | 'symbol' | 'end';
  text: string;
  start: number;
  end: number;
}

const fail = (message: string, start: number, end: number): never => {
  throw Object.assign(new Error(message), { problem: { message, start, end } satisfies Problem });
};

const SYMBOLS = ['<=', '>=', '==', '!=', '+', '-', '*', '/', '%', '^', '(', ')', ',', '<', '>', '?', ':'];

function tokens(text: string): Token[] {
  const found: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    const number = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(rest);
    if (number) {
      found.push({ kind: 'number', text: number[0], start: at, end: at + number[0].length });
      at += number[0].length;
      continue;
    }
    const hex = /^#[0-9A-Za-z]*/.exec(rest);
    if (hex) {
      if (!parseHex(hex[0])) fail(`${hex[0]} is not a colour; write it as #rrggbb`, at, at + hex[0].length);
      found.push({ kind: 'colour', text: hex[0], start: at, end: at + hex[0].length });
      at += hex[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (name) {
      found.push({ kind: 'name', text: name[0], start: at, end: at + name[0].length });
      at += name[0].length;
      continue;
    }
    const symbol = SYMBOLS.find((s) => rest.startsWith(s));
    if (!symbol) fail(`"${rest[0]}" has no meaning here`, at, at + 1);
    found.push({ kind: 'symbol', text: symbol!, start: at, end: at + symbol!.length });
    at += symbol!.length;
  }
  found.push({ kind: 'end', text: '', start: text.length, end: text.length });
  return found;
}

function parse(text: string): Node {
  const list = tokens(text);
  let at = 0;
  const peek = () => list[at];
  const take = () => list[at++];
  const isSymbol = (...symbols: string[]) => peek().kind === 'symbol' && symbols.includes(peek().text);
  const expect = (symbol: string, what: string) => {
    if (!isSymbol(symbol)) fail(`Expected ${what}`, peek().start, Math.max(peek().end, peek().start + 1));
    return take();
  };

  const expression = (): Node => {
    const condition = comparison();
    if (!isSymbol('?')) return condition;
    take();
    const then = expression();
    expect(':', '":" and what to use otherwise');
    const otherwise = expression();
    return { kind: 'choice', condition, then, otherwise, start: condition.start, end: otherwise.end };
  };
  const comparison = (): Node => {
    const left = sum();
    if (!isSymbol('<', '<=', '>', '>=', '==', '!=')) return left;
    const operator = take().text;
    const right = sum();
    return { kind: 'binary', operator, left, right, start: left.start, end: right.end };
  };
  const sum = (): Node => {
    let left = product();
    while (isSymbol('+', '-')) {
      const operator = take().text;
      const right = product();
      left = { kind: 'binary', operator, left, right, start: left.start, end: right.end };
    }
    return left;
  };
  const product = (): Node => {
    let left = negation();
    while (isSymbol('*', '/', '%')) {
      const operator = take().text;
      const right = negation();
      left = { kind: 'binary', operator, left, right, start: left.start, end: right.end };
    }
    return left;
  };
  const negation = (): Node => {
    if (!isSymbol('-')) return power();
    const minus = take();
    const operand = negation();
    return { kind: 'unary', operator: '-', operand, start: minus.start, end: operand.end };
  };
  const power = (): Node => {
    const base = primary();
    if (!isSymbol('^')) return base;
    take();
    // Right to left, and above negation on the left: -2^2 is -4, 2^-1 is 0.5.
    const exponent = negation();
    return { kind: 'binary', operator: '^', left: base, right: exponent, start: base.start, end: exponent.end };
  };
  const primary = (): Node => {
    const token = take();
    if (token.kind === 'number') return { kind: 'number', value: Number(token.text), start: token.start, end: token.end };
    if (token.kind === 'colour') return { kind: 'colour', value: parseHex(token.text)!, start: token.start, end: token.end };
    if (token.kind === 'name') {
      if (!isSymbol('(')) return { kind: 'name', name: token.text, start: token.start, end: token.end };
      take();
      const args: Node[] = [];
      if (!isSymbol(')')) {
        args.push(expression());
        while (isSymbol(',')) {
          take();
          args.push(expression());
        }
      }
      const close = expect(')', `")" to close ${token.text}(`);
      return { kind: 'call', name: token.text, args, start: token.start, end: close.end };
    }
    if (token.kind === 'symbol' && token.text === '(') {
      const inner = expression();
      expect(')', 'a closing ")"');
      return inner;
    }
    if (token.kind === 'end') return fail('Something is missing at the end', token.start, token.start + 1);
    return fail(`"${token.text}" is not expected here`, token.start, token.end);
  };

  if (peek().kind === 'end') fail('Empty: write a number or an expression', 0, 1);
  const tree = expression();
  if (peek().kind !== 'end') fail(`"${peek().text}" is not expected here`, peek().start, peek().end);
  return tree;
}

// ---------------------------------------------------------------------------
// Functions. Waves take a phase in cycles and give 0 to 1, so a slow sway is
// `sine(time / 8)` and one that keeps to the music is `saw(beats / 4)`.

const fract = (x: number) => x - Math.floor(x);
const clamp = (x: number, low: number, high: number) => Math.min(high, Math.max(low, x));

/** The same pseudo-random value for the same whole number, 0 to 1, so a render can be repeated exactly. */
function hash(n: number): number {
  let x = Math.imul(n | 0, 0x27d4eb2d) ^ 0x165667b1;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Smooth wandering between 0 and 1: random values at whole numbers, eased between. */
function noise(x: number): number {
  const i = Math.floor(x);
  const t = x - i;
  const eased = t * t * (3 - 2 * t);
  return hash(i) + (hash(i + 1) - hash(i)) * eased;
}

interface Builtin {
  usage: string;
  /** The kind it gives for arguments of these kinds, or why they will not do. */
  check(args: Kind[]): Kind | string;
  /** Functions that remember something from frame to frame get a fresh memory per place they are written. */
  stateful?: boolean;
  apply(args: Value[], memory: { value?: Value }, values: Values): Value;
}

const kinds = (args: Kind[]) => args.join(', ');

/** A function of numbers only, giving a number. */
function numeric(usage: string, count: number, apply: (args: number[]) => number): Builtin {
  return {
    usage,
    check: (args) =>
      args.length !== count ? `takes ${count} value${count === 1 ? '' : 's'}: ${usage}`
      : args.some((kind) => kind !== 'number') ? `works on numbers: ${usage}`
      : 'number',
    apply: (args) => apply(args as number[]),
  };
}

/** A function of one colour and `extra` numbers, giving `gives`. */
function ofColour(usage: string, extra: number, gives: Kind, apply: (colour: Colour, args: number[]) => Value): Builtin {
  return {
    usage,
    check: (args) =>
      args.length !== extra + 1 ? `takes ${extra + 1} value${extra ? 's' : ''}: ${usage}`
      : args[0] !== 'colour' ? `needs a colour first: ${usage}`
      : args.slice(1).some((kind) => kind !== 'number') ? `needs numbers after the colour: ${usage}`
      : gives,
    apply: ([colour, ...rest]) => apply(colour as Colour, rest as number[]),
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const FUNCTIONS: Record<string, Builtin> = {
  sine: numeric('sine(phase)', 1, ([p]) => 0.5 - 0.5 * Math.cos(2 * Math.PI * p)),
  triangle: numeric('triangle(phase)', 1, ([p]) => 1 - Math.abs(2 * fract(p) - 1)),
  saw: numeric('saw(phase)', 1, ([p]) => fract(p)),
  square: numeric('square(phase)', 1, ([p]) => (fract(p) < 0.5 ? 1 : 0)),
  noise: numeric('noise(x)', 1, ([x]) => noise(x)),
  random: numeric('random(n)', 1, ([n]) => hash(Math.floor(n))),
  /**
   * Follows a number or a colour, taking `rise` seconds to go most of the way
   * up and `fall` seconds most of the way down: an envelope follower, as on a
   * synth. A colour counts as rising when it gets lighter.
   */
  smooth: {
    usage: 'smooth(value, rise, fall)',
    stateful: true,
    check: (args) =>
      args.length !== 3 ? 'takes 3 values: smooth(value, rise, fall)'
      : args[1] !== 'number' || args[2] !== 'number' ? 'needs rise and fall in seconds: smooth(value, rise, fall)'
      : args[0],
    apply: ([x, rise, fall], memory, values) => {
      const previous = memory.value;
      if (previous === undefined) return (memory.value = x);
      const up = isColour(x) ? toLch(x).l > toLch(previous as Colour).l : (x as number) > (previous as number);
      const seconds = (up ? rise : fall) as number;
      const dt = typeof values.dt === 'number' ? values.dt : 0;
      const keep = seconds > 0 ? Math.exp(-dt / seconds) : 0;
      const next = isColour(x)
        ? { r: lerp(x.r, (previous as Colour).r, keep), g: lerp(x.g, (previous as Colour).g, keep), b: lerp(x.b, (previous as Colour).b, keep), a: lerp(x.a, (previous as Colour).a, keep) }
        : lerp(x as number, previous as number, keep);
      return (memory.value = isColour(next) || Number.isFinite(next) ? next : x);
    },
  },
  /** Between two numbers, or two colours blended so the steps look even. */
  mix: {
    usage: 'mix(a, b, amount)',
    check: (args) =>
      args.length !== 3 ? 'takes 3 values: mix(a, b, amount)'
      : args[0] !== args[1] ? 'mixes two numbers or two colours, not one of each: mix(a, b, amount)'
      : args[2] !== 'number' ? 'needs the amount as a number: mix(a, b, amount)'
      : args[0],
    apply: ([a, b, t]) => (isColour(a) ? mixColours(a, b as Colour, t as number) : lerp(a, b as number, t as number)),
  },
  min: numeric('min(a, b)', 2, ([a, b]) => Math.min(a, b)),
  max: numeric('max(a, b)', 2, ([a, b]) => Math.max(a, b)),
  clamp: numeric('clamp(value, low, high)', 3, ([x, low, high]) => clamp(x, low, high)),
  step: numeric('step(edge, value)', 2, ([edge, x]) => (x >= edge ? 1 : 0)),
  smoothstep: numeric('smoothstep(low, high, value)', 3, ([low, high, x]) => {
    const t = clamp((x - low) / (high - low || 1), 0, 1);
    return t * t * (3 - 2 * t);
  }),
  abs: numeric('abs(x)', 1, ([x]) => Math.abs(x)),
  floor: numeric('floor(x)', 1, ([x]) => Math.floor(x)),
  ceil: numeric('ceil(x)', 1, ([x]) => Math.ceil(x)),
  round: numeric('round(x)', 1, ([x]) => Math.round(x)),
  fract: numeric('fract(x)', 1, ([x]) => fract(x)),
  sqrt: numeric('sqrt(x)', 1, ([x]) => Math.sqrt(Math.max(0, x))),
  pow: numeric('pow(x, y)', 2, ([x, y]) => Math.pow(x, y)),
  exp: numeric('exp(x)', 1, ([x]) => Math.exp(x)),
  log: numeric('log(x)', 1, ([x]) => Math.log(x)),
  sin: numeric('sin(radians)', 1, ([x]) => Math.sin(x)),
  cos: numeric('cos(radians)', 1, ([x]) => Math.cos(x)),

  // Making colours. Red, green and blue go from 0 to 1, as in a shader.
  rgb: {
    usage: 'rgb(red, green, blue)',
    check: (args) =>
      args.length !== 3 && args.length !== 4 ? 'takes 3 values, each 0 to 1: rgb(red, green, blue)'
      : args.some((kind) => kind !== 'number') ? 'works on numbers, each 0 to 1: rgb(red, green, blue)'
      : 'colour',
    apply: ([r, g, b, a]) => ({ r: r as number, g: g as number, b: b as number, a: (a as number | undefined) ?? 1 }),
  },
  hsl: { usage: 'hsl(hue, saturation, lightness)', check: (args) => (args.length === 3 && args.every((k) => k === 'number') ? 'colour' : 'takes 3 numbers: hsl(hue in degrees, saturation 0 to 1, lightness 0 to 1)'), apply: ([h, s, l]) => fromHsl(h as number, s as number, l as number) },
  oklch: { usage: 'oklch(lightness, chroma, hue)', check: (args) => (args.length === 3 && args.every((k) => k === 'number') ? 'colour' : 'takes 3 numbers: oklch(lightness 0 to 1, chroma, hue in degrees)'), apply: ([l, c, h]) => fromLch({ l: l as number, c: c as number, h: h as number }) },

  // Changing colours, keeping how light they look.
  hue: ofColour('hue(colour, degrees)', 1, 'colour', (c, [degrees]) => turnHue(c, degrees)),
  complement: ofColour('complement(colour)', 0, 'colour', (c) => turnHue(c, 180)),
  lighten: ofColour('lighten(colour, amount)', 1, 'colour', (c, [amount]) => lighten(c, amount)),
  darken: ofColour('darken(colour, amount)', 1, 'colour', (c, [amount]) => lighten(c, -amount)),
  saturate: ofColour('saturate(colour, amount)', 1, 'colour', (c, [amount]) => saturate(c, amount)),
  desaturate: ofColour('desaturate(colour, amount)', 1, 'colour', (c, [amount]) => saturate(c, -amount)),
  gray: ofColour('gray(colour)', 0, 'colour', (c) => saturate(c, -1)),
  alpha: ofColour('alpha(colour, alpha)', 1, 'colour', (c, [a]) => ({ ...c, a: clamp(a, 0, 1) })),

  // Reading colours, as numbers.
  lightness: ofColour('lightness(colour)', 0, 'number', (c) => toLch(c).l),
  chroma: ofColour('chroma(colour)', 0, 'number', (c) => toLch(c).c),
  hueOf: ofColour('hueOf(colour)', 0, 'number', (c) => toLch(c).h),
  red: ofColour('red(colour)', 0, 'number', (c) => c.r),
  green: ofColour('green(colour)', 0, 'number', (c) => c.g),
  blue: ofColour('blue(colour)', 0, 'number', (c) => c.b),
  alphaOf: ofColour('alphaOf(colour)', 0, 'number', (c) => c.a),
};

/** What each function does, in a sentence, for the manual. */
export const FUNCTION_ABOUT: Record<keyof typeof FUNCTIONS, string> = {
  sine: 'A smooth wave from 0 up to 1 and back as the phase goes from 0 to 1; sine(beats) swells once a beat.',
  triangle: 'Straight up from 0 to 1 and straight back down as the phase goes from 0 to 1.',
  saw: 'Climbs from 0 to 1 as the phase goes from 0 to 1, then drops back to 0.',
  square: '1 for the first half of each phase, 0 for the second: an on-off blink.',
  noise: 'Wanders smoothly between 0 and 1 as x grows; noise(time) drifts, noise(time * 5) jitters.',
  random: 'A number between 0 and 1 that stays the same for each whole number n and jumps at the next; random(beats) changes once a beat.',
  smooth: 'Follows a value, taking rise seconds to go up and fall seconds to come down, as a synth envelope does: smooth(bass, 0.02, 0.4) jumps with the kick and settles slowly. Works on colours too.',
  mix: 'Partway from a to b: 0 gives a, 1 gives b. Works on two numbers or two colours.',
  min: 'The smaller of two numbers.',
  max: 'The larger of two numbers.',
  clamp: 'The value, kept between low and high.',
  step: '0 below the edge, 1 at it and above.',
  smoothstep: 'Rises smoothly from 0 to 1 as the value goes from low to high.',
  abs: 'The number without its sign.',
  floor: 'Rounded down to a whole number.',
  ceil: 'Rounded up to a whole number.',
  round: 'Rounded to the nearest whole number.',
  fract: 'What is after the decimal point: fract(2.25) is 0.25.',
  sqrt: 'The square root.',
  pow: 'x to the power y.',
  exp: 'e to the power x.',
  log: 'The natural logarithm.',
  sin: 'The sine of an angle in radians; pi is there to use.',
  cos: 'The cosine of an angle in radians.',
  rgb: 'A colour from red, green and blue, each 0 to 1, with an optional fourth for how opaque it is.',
  hsl: 'A colour from a hue in degrees, and saturation and lightness, each 0 to 1.',
  oklch: 'A colour from lightness (0 to 1), chroma (0 for grey, up to about 0.37 for the richest) and a hue in degrees, in a space where equal steps look equal.',
  hue: 'The colour turned round the colour wheel by so many degrees, as light as before.',
  complement: 'The colour on the other side of the colour wheel.',
  lighten: 'The colour made lighter by an amount from 0 to 1.',
  darken: 'The colour made darker by an amount from 0 to 1.',
  saturate: 'The colour made richer by an amount from 0 to 1.',
  desaturate: 'The colour made greyer by an amount from 0 to 1.',
  gray: 'The colour as a grey of the same lightness.',
  alpha: 'The colour made see-through: 0 invisible, 1 solid.',
  lightness: 'How light the colour looks, 0 to 1.',
  chroma: 'How rich the colour is, from 0 for grey.',
  hueOf: 'Where the colour is on the colour wheel, in degrees.',
  red: 'The red of the colour, 0 to 1.',
  green: 'The green of the colour, 0 to 1.',
  blue: 'The blue of the colour, 0 to 1.',
  alphaOf: 'How solid the colour is, 0 to 1.',
};

const CONSTANTS: Record<string, number> = { pi: Math.PI };

/** How many single-letter changes turn one word into the other. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** The known word closest to `word`, if one is close enough to be what was meant. */
export function suggestion(word: string, known: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = distance(word, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best !== null && bestDistance <= Math.max(1, Math.floor(word.length / 3)) ? best : null;
}

type Evaluator = (values: Values) => Value;
interface Built {
  kind: Kind;
  run: Evaluator;
}

const each = (a: Colour, b: Colour | number, f: (x: number, y: number) => number): Colour =>
  typeof b === 'number'
    ? { r: f(a.r, b), g: f(a.g, b), b: f(a.b, b), a: a.a }
    : { r: f(a.r, b.r), g: f(a.g, b.g), b: f(a.b, b.b), a: a.a };

const ARITHMETIC: Record<string, (x: number, y: number) => number> = {
  '+': (x, y) => x + y,
  '-': (x, y) => x - y,
  '*': (x, y) => x * y,
  '/': (x, y) => x / y,
  '%': (x, y) => (y === 0 ? 0 : x - y * Math.floor(x / y)),
  '^': (x, y) => Math.pow(x, y),
  '<': (x, y) => (x < y ? 1 : 0),
  '<=': (x, y) => (x <= y ? 1 : 0),
  '>': (x, y) => (x > y ? 1 : 0),
  '>=': (x, y) => (x >= y ? 1 : 0),
  '==': (x, y) => (x === y ? 1 : 0),
  '!=': (x, y) => (x !== y ? 1 : 0),
};
const VERBS: Record<string, string> = { '+': 'add', '-': 'take', '*': 'multiply', '/': 'divide', '%': 'take the remainder of', '^': 'raise' };

/**
 * Turns an expression into something that works out its value each frame.
 * `known` gives the names a frame will provide and whether each is a number
 * or a colour (a plain list means numbers). With `expect`, an expression that
 * gives the other kind is a problem, as anything else wrong is: reported with
 * where it is, and a guess at what was meant.
 */
export function compile(text: string, known: Iterable<string> | Record<string, Kind>, expect?: Kind): Compilation {
  const names: Record<string, Kind> = Symbol.iterator in Object(known)
    ? Object.fromEntries([...(known as Iterable<string>)].map((name) => [name, 'number' as Kind]))
    : (known as Record<string, Kind>);
  const used = new Set<string>();
  const memories: { value?: Value }[] = [];
  try {
    const tree = parse(text);
    const build = (node: Node): Built => {
      switch (node.kind) {
        case 'number':
          return { kind: 'number', run: () => node.value };
        case 'colour':
          return { kind: 'colour', run: () => node.value };
        case 'name': {
          if (node.name in CONSTANTS) {
            const value = CONSTANTS[node.name];
            return { kind: 'number', run: () => value };
          }
          if (!(node.name in names)) {
            const near = suggestion(node.name, [...Object.keys(names), ...Object.keys(CONSTANTS)]);
            const hint = node.name in FUNCTIONS ? `; it is a function: ${FUNCTIONS[node.name].usage}` : near ? `; did you mean ${near}?` : '';
            fail(`Unknown name ${node.name}${hint}`, node.start, node.end);
          }
          used.add(node.name);
          const name = node.name;
          const kind = names[name];
          const fallback: Value = kind === 'colour' ? { r: 0, g: 0, b: 0, a: 1 } : 0;
          return { kind, run: (values) => values[name] ?? fallback };
        }
        case 'unary': {
          const operand = build(node.operand);
          if (operand.kind === 'colour') return { kind: 'colour', run: (values) => each(operand.run(values) as Colour, -1, (x, y) => x * y) };
          return { kind: 'number', run: (values) => -(operand.run(values) as number) };
        }
        case 'binary': {
          const left = build(node.left);
          const right = build(node.right);
          const op = ARITHMETIC[node.operator];
          if (left.kind === 'number' && right.kind === 'number') {
            return { kind: 'number', run: (v) => op(left.run(v) as number, right.run(v) as number) };
          }
          const comparing = ['<', '<=', '>', '>=', '==', '!='].includes(node.operator);
          if (comparing || node.operator === '%' || node.operator === '^') {
            fail(`Colours cannot be compared or ${node.operator === '^' ? 'raised to a power' : 'divided with remainder'}; compare lightness(colour) instead`, node.start, node.end);
          }
          if (left.kind === 'colour' && right.kind === 'colour') {
            return { kind: 'colour', run: (v) => each(left.run(v) as Colour, right.run(v) as Colour, op) };
          }
          // One colour, one number: the number goes to each of red, green and blue.
          if (node.operator === '+' || node.operator === '-') {
            const colour = left.kind === 'colour' ? node.left : node.right;
            const shown = text.slice(colour.start, colour.end);
            fail(`Cannot ${VERBS[node.operator]} a number ${node.operator === '+' ? 'to' : 'from'} a colour; to make it lighter or darker, multiply (${shown} * 1.2) or use lighten(${shown}, 0.1)`, node.start, node.end);
          }
          if (left.kind === 'number' && node.operator === '/') fail('Cannot divide a number by a colour', node.start, node.end);
          if (left.kind === 'colour') return { kind: 'colour', run: (v) => each(left.run(v) as Colour, right.run(v) as number, op) };
          return { kind: 'colour', run: (v) => each(right.run(v) as Colour, left.run(v) as number, op) };
        }
        case 'choice': {
          const condition = build(node.condition);
          const then = build(node.then);
          const otherwise = build(node.otherwise);
          if (condition.kind !== 'number') fail('The condition before "?" has to be a number, as from a comparison', node.condition.start, node.condition.end);
          if (then.kind !== otherwise.kind) fail('Both sides of ":" have to be numbers, or both colours', node.start, node.end);
          return { kind: then.kind, run: (values) => ((condition.run(values) as number) !== 0 ? then.run(values) : otherwise.run(values)) };
        }
        case 'call': {
          const builtin = FUNCTIONS[node.name];
          if (!builtin) {
            const near = suggestion(node.name, Object.keys(FUNCTIONS));
            fail(`Unknown function ${node.name}${near ? `; did you mean ${near}?` : ''}`, node.start, node.start + node.name.length);
          }
          const args = node.args.map(build);
          const kind = builtin.check(args.map((arg) => arg.kind));
          if (kind !== 'number' && kind !== 'colour') fail(`${node.name} ${kind}`, node.start, node.end);
          const memory: { value?: Value } = {};
          if (builtin.stateful) memories.push(memory);
          const scratch = new Array<Value>(args.length);
          return {
            kind: kind as Kind,
            run: (values) => {
              for (let i = 0; i < args.length; i++) scratch[i] = args[i].run(values);
              return builtin.apply(scratch, memory, values);
            },
          };
        }
      }
    };
    const built = build(tree);
    if (expect && built.kind !== expect) {
      fail(expect === 'colour' ? 'This gives a number; a colour is needed here' : 'This gives a colour; a number is needed here', 0, text.length);
    }
    return {
      ok: true,
      compiled: {
        kind: built.kind,
        evaluate: (values) => {
          const value = built.run(values);
          if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
          const safe = (x: number) => (Number.isFinite(x) ? x : 0);
          return { r: safe(value.r), g: safe(value.g), b: safe(value.b), a: safe(value.a) };
        },
        reset: () => {
          for (const memory of memories) delete memory.value;
        },
        names: [...used],
      },
    };
  } catch (error) {
    const problem = (error as { problem?: Problem }).problem;
    if (problem) return { ok: false, problem };
    throw error;
  }
}
