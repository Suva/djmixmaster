// Fonts for a video's text. A template names a font by its family: one that
// comes with the app (bundled, so it looks the same on every computer), one
// of the plain system faces in FONTS, or any font installed on this computer.
// The bundled files live in assets/fonts and are served to the window as
// fonts/<file>; each comes with its licence (all SIL Open Font License).
//
// A canvas draws text in a fallback font, without a word, if the font asked
// for has not finished loading. So whatever draws a template loads its fonts
// first (`loadFonts`), and the export does not start before they are in.

import { FONTS } from './template.ts';

export interface BundledFont {
  family: string;
  file: string;
  /** The weights it has: a range for a variable font, one weight otherwise. */
  weights: [number, number];
  /** What it is like, to group the list by. */
  kind: 'Clean' | 'Headline' | 'Techno' | 'Display' | 'Mono' | 'Serif';
}

/** From github.com/google/fonts; each family's licence is beside it as <folder>-OFL.txt. */
export const BUNDLED_FONTS: BundledFont[] = [
  { family: 'Inter', file: 'Inter[opsz,wght].ttf', weights: [100, 900], kind: 'Clean' },
  { family: 'Space Grotesk', file: 'SpaceGrotesk[wght].ttf', weights: [300, 700], kind: 'Clean' },
  { family: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', weights: [400, 400], kind: 'Headline' },
  { family: 'Oswald', file: 'Oswald[wght].ttf', weights: [200, 700], kind: 'Headline' },
  { family: 'Anton', file: 'Anton-Regular.ttf', weights: [400, 400], kind: 'Headline' },
  { family: 'Orbitron', file: 'Orbitron[wght].ttf', weights: [400, 900], kind: 'Techno' },
  { family: 'Audiowide', file: 'Audiowide-Regular.ttf', weights: [400, 400], kind: 'Techno' },
  { family: 'Unbounded', file: 'Unbounded[wght].ttf', weights: [200, 900], kind: 'Techno' },
  { family: 'Bungee', file: 'Bungee-Regular.ttf', weights: [400, 400], kind: 'Display' },
  { family: 'Rubik Mono One', file: 'RubikMonoOne-Regular.ttf', weights: [400, 400], kind: 'Display' },
  { family: 'Monoton', file: 'Monoton-Regular.ttf', weights: [400, 400], kind: 'Display' },
  { family: 'Righteous', file: 'Righteous-Regular.ttf', weights: [400, 400], kind: 'Display' },
  { family: 'Space Mono', file: 'SpaceMono-Regular.ttf', weights: [400, 400], kind: 'Mono' },
  { family: 'Space Mono', file: 'SpaceMono-Bold.ttf', weights: [700, 700], kind: 'Mono' },
  { family: 'Playfair Display', file: 'PlayfairDisplay[wght].ttf', weights: [400, 900], kind: 'Serif' },
];

/** The families that come with the app, each once, in the order above. */
export const BUNDLED_FAMILIES = [...new Set(BUNDLED_FONTS.map((font) => font.family))];

/** What to give a canvas for a font named in a template: its family, with a plain fallback. */
export function fontStack(name: string): string {
  if (name in FONTS) return FONTS[name];
  return `"${name.replace(/["\\]/g, '')}", ${FONTS.Sans}`;
}

const registered = new Set<string>();

/**
 * Makes sure these fonts are ready to draw with. Bundled ones are added to the
 * page from their files the first time; installed ones only need asking for.
 * A font that cannot be had is left out: its text is drawn in the fallback.
 */
export async function loadFonts(names: Iterable<string>): Promise<void> {
  const loads: Promise<unknown>[] = [];
  for (const name of new Set(names)) {
    if (!name || name in FONTS) continue;
    const bundled = BUNDLED_FONTS.filter((font) => font.family === name);
    for (const font of bundled) {
      if (registered.has(font.file)) continue;
      registered.add(font.file);
      const face = new FontFace(font.family, `url("fonts/${encodeURIComponent(font.file)}")`, {
        weight: font.weights[0] === font.weights[1] ? String(font.weights[0]) : `${font.weights[0]} ${font.weights[1]}`,
      });
      document.fonts.add(face);
      loads.push(face.load().catch(() => {}));
    }
    if (bundled.length === 0) loads.push(document.fonts.load(`400 32px ${fontStack(name)}`).catch(() => {}));
  }
  await Promise.all(loads);
}

let installed: Promise<string[]> | null = null;

/**
 * The font families installed on this computer, through the browser's Local
 * Font Access, once. Empty where that is not offered.
 */
export function installedFamilies(): Promise<string[]> {
  installed ??= (async () => {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
    if (!query) return [];
    try {
      const fonts = await query();
      return [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  })();
  return installed;
}
