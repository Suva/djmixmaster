// The shapes a video can be made in: landscape for YouTube and the like,
// vertical for phones (Shorts, Reels, TikTok), square for feeds that crop to
// it. A template is drawn in any of them: positions are parts of the width
// and the height, sizes parts of the short side (see `draw.ts`), and an
// expression can ask `portrait` or `aspect` to lay things out otherwise.
//
// Kept free of Node imports: the window and the export page use it.

export const SHAPES = {
  landscape: { label: 'Landscape', width: 1920, height: 1080 },
  vertical: { label: 'Vertical', width: 1080, height: 1920 },
  square: { label: 'Square', width: 1080, height: 1080 },
} as const;

export type Shape = keyof typeof SHAPES;

/** A shape from what was saved or asked for; landscape, as videos always were, for anything else. */
export const shapeOf = (value: unknown): Shape => (typeof value === 'string' && value in SHAPES ? (value as Shape) : 'landscape');
