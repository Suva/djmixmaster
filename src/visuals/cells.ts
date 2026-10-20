// The cells that tile a picture: squares, hexagons and triangles, laid out
// from an origin and covering a region, for the grid layer's patterns and the
// mosaic effect's cells. Positions are in whatever units the caller draws in;
// a cell size `s` is the distance from one cell to the next across.
//
// The graphics card lays out the same cells for itself (cell-shaders.ts): a
// change to how they are laid out or coloured must be made there too.
//
// Kept free of Node imports: the window draws with it.

export interface Cell {
  /** The cell's middle. */
  x: number;
  y: number;
  /** Its place in the tiling, for colouring by turns. */
  i: number;
  j: number;
  /** For a triangle: pointing up rather than down. */
  up?: boolean;
}

/** The region to cover: left, top, right and bottom. */
export type Region = [number, number, number, number];

const SQRT3 = Math.sqrt(3);

/** Squares of side `s`, their corners on the lines s apart through (ox, oy). */
export function squareCells(s: number, ox: number, oy: number, [left, top, right, bottom]: Region): Cell[] {
  const cells: Cell[] = [];
  for (let j = Math.floor((top - oy) / s); j * s + oy < bottom; j++) {
    for (let i = Math.floor((left - ox) / s); i * s + ox < right; i++) cells.push({ x: ox + (i + 0.5) * s, y: oy + (j + 0.5) * s, i, j });
  }
  return cells;
}

/** How far a hexagon's corners are from its middle, when hexagons are `s` apart across. */
export const hexRadius = (s: number) => s / SQRT3;

/**
 * Hexagons standing on a point, `s` apart across, rows s·√3/2 apart, every
 * other row half a hexagon along; the one numbered 0, 0 has its middle at
 * (ox, oy). Numbered so that `hexColour` gives neighbours different colours.
 */
export function hexCells(s: number, ox: number, oy: number, [left, top, right, bottom]: Region): Cell[] {
  const cells: Cell[] = [];
  const row = (s * SQRT3) / 2;
  const reach = hexRadius(s);
  for (let j = Math.floor((top - reach - oy) / row); j * row + oy < bottom + reach; j++) {
    const shift = (((j % 2) + 2) % 2) * (s / 2);
    for (let i = Math.floor((left - s - ox - shift) / s); i * s + ox + shift < right + s; i++) {
      cells.push({ x: ox + shift + i * s, y: oy + j * row, i, j });
    }
  }
  return cells;
}

/** Which of three colours a hexagon of hexCells takes, so that no two that touch share one. */
export function hexColour(cell: Cell): number {
  // In axial numbering, neighbours differ in q − r by 1 or 2, never by 3.
  const q = cell.i - Math.floor(cell.j / 2);
  return (((q - cell.j) % 3) + 3) % 3;
}

/** A hexagon's corners, standing on a point, round its middle. */
export function hexagonAt(x: number, y: number, radius: number): number[] {
  const points: number[] = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3;
    points.push(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
  }
  return points;
}

/**
 * Triangles of side `s`, in rows s·√3/2 tall, pointing up and down by turns;
 * a row's lines run through (ox, oy). Each cell's middle is its centroid.
 */
export function triangleCells(s: number, ox: number, oy: number, [left, top, right, bottom]: Region): Cell[] {
  const cells: Cell[] = [];
  const row = (s * SQRT3) / 2;
  for (let j = Math.floor((top - oy) / row); j * row + oy < bottom; j++) {
    for (let i = Math.floor((left - ox) / (s / 2)) - 1; (i * s) / 2 + ox < right + s; i++) {
      const up = (((i + j) % 2) + 2) % 2 === 0;
      cells.push({ x: ox + (i * s) / 2 + s / 2, y: oy + j * row + (up ? (row * 2) / 3 : row / 3), i, j, up });
    }
  }
  return cells;
}

/** A triangle's corners, for a cell of triangleCells. */
export function triangleAt(cell: Cell, s: number): number[] {
  const row = (s * SQRT3) / 2;
  const top = cell.y - (cell.up ? (row * 2) / 3 : row / 3);
  return cell.up
    ? [cell.x, top, cell.x + s / 2, top + row, cell.x - s / 2, top + row]
    : [cell.x - s / 2, top, cell.x + s / 2, top, cell.x, top + row];
}

/** A colour channel, 0 to 1, cut to so many levels: the posterised, few-colour look. */
export function fewer(value: number, levels: number): number {
  const steps = Math.max(1, Math.round(levels) - 1);
  return Math.round(Math.min(1, Math.max(0, value)) * steps) / steps;
}
