// The outlines of a shape layer's shapes, as points. Curves are given as many
// short straight pieces, so that every shape can be rounded, drawn in part
// and traced along its outline in the same way, and the length of an outline
// is simply added up.
//
// Kept free of Node imports and of the canvas: the drawer turns these into
// paths, and the tests read them as numbers.

/** A closed outline, as x, y, x, y… */
export type Contour = number[];

export interface OutlineOptions {
  /** For a polygon: how many sides; for a star, how many points. */
  sides: number;
  /** A star's inner points, as a fraction of the way out to its outer ones. */
  inner: number;
  /** A ring's band, a cross's arms, an arrow's shaft: a fraction of the shape's short side (a ring's, of its radius). */
  thickness: number;
  /** Corners rounded by this fraction of the shape's short side; half rounds a rectangle into a pill. */
  rounding: number;
}

const SIDES: Record<string, number> = { pentagon: 5, hexagon: 6, octagon: 8 };

/** Points round an ellipse, clockwise on the picture from the top. */
function ellipse(rx: number, ry: number): Contour {
  // Enough pieces that even a circle filling a 4K picture shows no corners.
  const n = 160;
  const out: Contour = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    out.push(Math.cos(a) * rx, Math.sin(a) * ry);
  }
  return out;
}

/**
 * Points round a regular polygon fitted in the ellipse of the box, the first
 * at the top. One whose sides come in fours (a square, an octagon) is turned
 * half a side, so that it stands on a side, as a stop sign does, rather than
 * on a point.
 */
function regular(n: number, rx: number, ry: number, inner = 1): Contour {
  const turn = n % 4 === 0 && inner === 1 ? Math.PI / n : 0;
  const points = inner === 1 ? n : n * 2;
  const out: Contour = [];
  for (let i = 0; i < points; i++) {
    const a = -Math.PI / 2 + turn + (i / points) * Math.PI * 2;
    const r = i % 2 === 1 && inner !== 1 ? inner : 1;
    out.push(Math.cos(a) * rx * r, Math.sin(a) * ry * r);
  }
  return out;
}

/** The heart curve, stretched to fill the box. */
function heart(w: number, h: number): Contour {
  const n = 160;
  const raw: Contour = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    raw.push(16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)));
  }
  let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < raw.length; i += 2) {
    minX = Math.min(minX, raw[i]); maxX = Math.max(maxX, raw[i]);
    minY = Math.min(minY, raw[i + 1]); maxY = Math.max(maxY, raw[i + 1]);
  }
  return raw.map((v, i) => (i % 2 === 0 ? ((v - minX) / (maxX - minX) - 0.5) * w : ((v - minY) / (maxY - minY) - 0.5) * h));
}

/**
 * Each corner replaced by an arc of radius `radius`, or less where the sides
 * beside it are too short for that: no arc takes more than half a side.
 */
export function rounded(contour: Contour, radius: number): Contour {
  const n = contour.length / 2;
  if (radius <= 0 || n < 3) return contour;
  const out: Contour = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = [contour[i * 2], contour[i * 2 + 1]];
    const a = ((i + n - 1) % n) * 2;
    const b = ((i + 1) % n) * 2;
    const [ux, uy, ul] = unit(contour[a] - px, contour[a + 1] - py);
    const [vx, vy, vl] = unit(contour[b] - px, contour[b + 1] - py);
    // The angle at the corner; one that is almost straight needs no arc.
    const angle = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
    if (angle > Math.PI - 1e-3 || angle < 1e-3) {
      out.push(px, py);
      continue;
    }
    const half = angle / 2;
    const reach = Math.min(radius / Math.tan(half), ul / 2, vl / 2);
    const r = reach * Math.tan(half);
    const [bx, by] = unit(ux + vx, uy + vy);
    const cx = px + (bx * r) / Math.sin(half);
    const cy = py + (by * r) / Math.sin(half);
    const from = Math.atan2(py + uy * reach - cy, px + ux * reach - cx);
    let sweep = Math.atan2(py + vy * reach - cy, px + vx * reach - cx) - from;
    if (sweep > Math.PI) sweep -= Math.PI * 2;
    if (sweep < -Math.PI) sweep += Math.PI * 2;
    // A piece every couple of pixels of the arc, so that large corners stay smooth.
    const pieces = Math.max(2, Math.min(48, Math.ceil((Math.abs(sweep) * r) / 2)));
    for (let k = 0; k <= pieces; k++) {
      const t = from + (sweep * k) / pieces;
      out.push(cx + Math.cos(t) * r, cy + Math.sin(t) * r);
    }
  }
  return out;
}

function unit(x: number, y: number): [number, number, number] {
  const length = Math.hypot(x, y);
  return length > 0 ? [x / length, y / length, length] : [0, 0, 0];
}

/**
 * The outline of a shape `w` by `h`, centred on (0, 0): one closed contour,
 * or for a ring two, the second its hole (to be filled even-odd). Each goes
 * round clockwise on the picture, from the top or the top left.
 */
export function shapeOutline(shape: string, w: number, h: number, options: OutlineOptions): Contour[] {
  const [rx, ry] = [w / 2, h / 2];
  const short = Math.min(w, h);
  const thickness = Math.max(0, Math.min(1, options.thickness));
  let contour: Contour;
  switch (shape) {
    case 'ellipse': return [ellipse(rx, ry)];
    case 'heart': return [heart(w, h)];
    case 'ring': {
      const band = thickness * Math.min(rx, ry);
      return band >= Math.min(rx, ry) ? [ellipse(rx, ry)] : [ellipse(rx, ry), ellipse(rx - band, ry - band)];
    }
    case 'triangle': contour = [0, -ry, rx, ry, -rx, ry]; break;
    case 'diamond': contour = [0, -ry, rx, 0, 0, ry, -rx, 0]; break;
    case 'pentagon': case 'hexagon': case 'octagon': contour = regular(SIDES[shape], rx, ry); break;
    case 'polygon': contour = regular(Math.max(3, Math.min(64, Math.round(options.sides))), rx, ry); break;
    case 'star': contour = regular(Math.max(3, Math.min(64, Math.round(options.sides))), rx, ry, Math.max(0.01, Math.min(1, options.inner))); break;
    case 'cross': {
      const a = (thickness * short) / 2;
      contour = [-a, -ry, a, -ry, a, -a, rx, -a, rx, a, a, a, a, ry, -a, ry, -a, a, -rx, a, -rx, -a, -a, -a];
      break;
    }
    case 'arrow': {
      // Pointing right; the head as long as the arrow is tall, but never more than half its length.
      const s = (thickness * h) / 2;
      const neck = rx - Math.min(w / 2, h);
      contour = [-rx, -s, neck, -s, neck, -ry, rx, 0, neck, ry, neck, s, -rx, s];
      break;
    }
    default: contour = [-rx, -ry, rx, -ry, rx, ry, -rx, ry];
  }
  // The curved shapes were given above as they are; rounding is for corners.
  return [rounded(contour, Math.max(0, options.rounding) * short)];
}

/** How long a closed outline is, all the way round. */
export function lengthOf(contour: Contour): number {
  let length = 0;
  const n = contour.length / 2;
  for (let i = 0; i < n; i++) {
    const j = ((i + 1) % n) * 2;
    length += Math.hypot(contour[j] - contour[i * 2], contour[j + 1] - contour[i * 2 + 1]);
  }
  return length;
}
