// The grid layer's patterns and the mosaic effect's cells, drawn on the
// graphics card: each pixel works out which cells of cells.ts lie under it
// and how much of it each covers, so a frame costs the same whatever the
// size of the cells. Drawn as paths on a canvas, as a computer without
// WebGL 2 still draws them, tens of thousands of small cells took the canvas
// longer than a frame has.
//
// The cells are laid out as cells.ts lays them out, and each is shaped and
// coloured as the canvas would draw it: the colours of a grid filled in the
// order of their paths, a mosaic's cells in the order they are drawn. Edges
// are smoothed by how far each pixel's middle is from them. A change to how
// cells.ts lays out cells, or to how draw.ts draws them as paths, must be
// made here too.
//
// Kept free of Node imports: the window draws with it.

/**
 * The grid kinds drawn here, by their number in the shader. Lines, stripes
 * and a floor stay paths in draw.ts: a path for each row and column of cells
 * costs little at any size, where one for each cell does not.
 */
export const GRID_PATTERNS = ['checkerboard', 'hex grid', 'hex cells', 'dots'] as const;

/** The mosaic's cell shapes, by their number in the shader. */
export const MOSAIC_SHAPES = ['squares', 'hexagons', 'circles', 'halftone', 'triangles'] as const;

/** Distances to the edges of cells, and how much of a pixel a shape covers. */
const SHAPES_GLSL = `
const float SQRT3 = 1.7320508;
// How much of a pixel (px across) a shape covers, given how far the pixel's middle is from its edge: below zero, inside.
float covers(float sd, float px) {
  return clamp(0.5 - sd / px, 0.0, 1.0);
}
// How much of a pixel lies within w of a line, its middle d from the line: exact for a line along the pixels.
float within(float d, float w, float px) {
  return clamp((w - d) / px + 0.5, 0.0, 1.0) - clamp((-w - d) / px + 0.5, 0.0, 1.0);
}
// Distance to a hexagon standing on a point, its flat sides apothem from the middle at left and right.
float hexagon(vec2 p, float apothem) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p.yx);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * apothem, k.z * apothem), apothem);
  return length(p) * sign(p.y);
}
// Distance to a rectangle reaching halves.x across and halves.y down from its middle, with corners of this radius.
float roundedBox(vec2 p, vec2 halves, float radius) {
  vec2 q = abs(p) - halves + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}
// Distance to a triangle of side 2r, its middle (its centroid) at the origin, pointing up the picture: towards smaller y,
// as the canvas counts.
float triangle(vec2 p, float r) {
  const float k = SQRT3;
  p = vec2(abs(p.x) - r, -p.y + r / k);
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}
// Adds to how much of the pixel colour 0, 1 or 2 covers.
void add(inout vec3 cover, float which, float amount) {
  if (which < 0.5) cover.x += amount;
  else if (which < 1.5) cover.y += amount;
  else cover.z += amount;
}
// A colour, premultiplied, laid over another so much.
vec4 over(vec4 top, float amount, vec4 under) {
  return top * amount + under * (1.0 - top.a * amount);
}
`;

/**
 * The grid layer's patterns. Uniforms: the canvas's `size`; `toLayer`, from
 * the canvas's pixels to the layer's own units, as the drawing's transform
 * after #place has them; `px`, a pixel in those units; `kind`, of
 * GRID_PATTERNS; `cell`, the cell size, and `origin`, where the grid starts,
 * scrolled; `line`, the line width; a checkerboard's `inset` and corner
 * `radius`; the dots' `dotRadius`; the hex cells' `apothem` and how many
 * colours they `use`; the three `fills` and `lineColour`, premultiplied,
 * none see-through.
 */
export const GRID_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 size;
uniform mat3 toLayer;
uniform float px;
uniform int kind;
uniform float cell;
uniform vec2 origin;
uniform float line;
uniform float inset;
uniform float radius;
uniform float dotRadius;
uniform float apothem;
uniform float use;
uniform vec4 fills[3];
uniform vec4 lineColour;
out vec4 colour;
${SHAPES_GLSL}
vec4 pattern(vec2 p, float px) {
  vec2 q = p - origin;
  // How much of the pixel each colour's cells cover, added up as the canvas fills a path of them. Each cell's shape
  // lies within its cell, so a pixel well inside its own cell is covered by that cell's shape alone.
  vec3 cover = vec3(0.0);
  if (kind == 0 || kind == 3) {
    vec2 c0 = floor(q / cell);
    vec2 own = q - (c0 + 0.5) * cell;
    // The cells beside it on the side the pixel is, when it is within a pixel of them.
    ivec2 toward = ivec2(sign(own) * step(cell / 2.0 - px, abs(own)));
    for (int dj = min(0, toward.y); dj <= max(0, toward.y); dj++) {
      for (int di = min(0, toward.x); di <= max(0, toward.x); di++) {
        vec2 c = c0 + vec2(di, dj);
        vec2 local = q - (c + 0.5) * cell;
        if (kind == 0) add(cover, mod(c.x + c.y, 2.0), covers(roundedBox(local, vec2(cell / 2.0 - inset), radius), px));
        else if (dotRadius > 0.0) cover.x += covers(length(local) - dotRadius, px);
      }
    }
  } else {
    // Hexagons in rows, every other row half a cell along. The pixel's own is the nearest of the nearest in each of the
    // three nearest rows; near its edge, the nearest three of each row are taken.
    float row = cell * SQRT3 / 2.0;
    float j0 = round(q.y / row);
    vec2 nearest = vec2(1e9);
    for (int dj = -1; dj <= 1; dj++) {
      float j = j0 + float(dj);
      float shift = mod(j, 2.0) * cell / 2.0;
      vec2 local = q - vec2(shift + round((q.x - shift) / cell) * cell, j * row);
      if (dot(local, local) < dot(nearest, nearest)) nearest = local;
    }
    // How far in from the edges of the hexagon the pixel is in.
    vec2 a = abs(nearest);
    float inward = cell / 2.0 - max(a.x, dot(a, vec2(0.5, 0.8660254)));
    if (kind == 1) return lineColour * within(inward, line / 2.0, px);
    if (apothem <= 0.0) return vec4(0.0);
    int reach = inward < px ? 1 : 0;
    vec2 middle = q - nearest;
    for (int dj = -reach; dj <= reach; dj++) {
      float j = round(middle.y / row) + float(dj);
      float shift = mod(j, 2.0) * cell / 2.0;
      float i0 = round((middle.x - shift) / cell);
      for (int di = -reach; di <= reach; di++) {
        float i = i0 + float(di);
        // Coloured as hexColour in cells.ts does, so that no two that touch share a colour.
        add(cover, mod(mod(i - floor(j / 2.0) - j, 3.0), use), covers(hexagon(q - vec2(shift + i * cell, j * row), apothem), px));
      }
    }
  }
  return over(fills[2], min(1.0, cover.z), over(fills[1], min(1.0, cover.y), over(fills[0], min(1.0, cover.x), vec4(0.0))));
}
void main() {
  // The canvas counts down from the top; the card, up from the bottom.
  vec2 pixel = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
  // Cells smaller than a few pixels: several points of each pixel, averaged, as the canvas adds up what covers it.
  int n = cell / px < 3.0 ? 3 : 1;
  vec4 sum = vec4(0.0);
  for (int y = 0; y < n; y++) {
    for (int x = 0; x < n; x++) {
      vec2 at = pixel + (vec2(x, y) + 0.5) / float(n) - 0.5;
      sum += pattern((toLayer * vec3(at, 1.0)).xy, px / float(n));
    }
  }
  colour = sum / float(n * n);
}
`;

/**
 * The average of the picture over each cell of the square grid from
 * `corner`, `cell` pixels across, for the mosaic: each pixel counting for as
 * much of it as lies in the cell. The card's own way of making a picture
 * small reads only a few of a cell's pixels. Worked out one way at a time:
 * across, `picture` is the picture and each pixel of the result a row of a
 * cell; down, `picture` is what across made and each pixel a cell. What
 * lies past the picture's edges, `size`, counts as see-through.
 * Premultiplied, in and out; rows counted from the top, as the canvas counts
 * them, which suits reading them back by number.
 */
export const AVERAGE_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D picture;
uniform vec2 size;
uniform vec2 corner;
uniform float cell;
uniform int down;
out vec4 colour;
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  int k = down == 1 ? 1 : 0;
  float start = corner[k] + float(at[k]) * cell;
  float from = max(0.0, start), to = min(size[k], start + cell);
  vec4 sum = vec4(0.0);
  // Each pixel the cell reaches, as much of it as lies within the cell.
  for (int p = int(floor(from)); float(p) < to; p++) {
    ivec2 read = at;
    read[k] = p;
    sum += texelFetch(picture, read, 0) * (min(float(p + 1), to) - max(float(p), from));
  }
  colour = sum / cell;
}
`;

/**
 * The mosaic's cells, coloured from `small`, the averages of AVERAGE_SHADER,
 * a pixel to a cell of the square grid from `corner`. Uniforms besides: the
 * canvas's `size`; `cell`, the cell size in pixels; `origin`, where the
 * cells are laid out from, and
 * `turn`, the cosine and sine of their turn; `shape`, of MOSAIC_SHAPES;
 * `gap` and `rounding`, fractions of a cell; `levels` of fewer colours, 0
 * for as they are; `gapColour`, premultiplied; `on`, the first and last
 * columns and rows of `small` mostly on the picture, whose averages those
 * past them take; `sharp`, 1 for squares neither turned, apart nor rounded,
 * which are the small picture made large, a block to a pixel, unsmoothed.
 */
export const MOSAIC_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D small;
uniform vec2 size;
uniform vec2 corner;
uniform float cell;
uniform vec2 origin;
uniform vec2 turn;
uniform int shape;
uniform float gap;
uniform float rounding;
uniform float levels;
uniform vec4 gapColour;
uniform ivec4 on;
uniform int sharp;
out vec4 colour;
${SHAPES_GLSL}
// How much of a cell starting here, along a side this long, lies on the picture.
float inside(float start, float side) {
  return clamp((min(side, start + cell) - max(0.0, start)) / cell, 0.0, 1.0);
}
// The average under a cell of the small picture, as draw.ts puts right those over the picture's edges:
// partly see-through for lying partly past them, or taking the average of a neighbour further in.
vec4 average(ivec2 at) {
  at = clamp(at, on.xy, max(on.xy, on.zw));
  // As the processor reads it: a colour, and how much of it there is.
  vec4 c = texelFetch(small, at, 0);
  if (c.a > 0.0) c.rgb /= c.a;
  float across = inside(corner.x + float(at.x) * cell, size.x);
  if (across >= 0.5) c.a = min(1.0, c.a / across);
  float down = inside(corner.y + float(at.y) * cell, size.y);
  if (down >= 0.5 && down < 1.0) c.a = min(1.0, c.a / down);
  if (levels > 0.0) {
    float steps = max(1.0, round(levels) - 1.0);
    c.rgb = round(clamp(c.rgb, 0.0, 1.0) * steps) / steps;
  }
  return c;
}
// The colour of the cell whose middle is at m in the cells' own turned frame: the average under that point of the
// picture, or for a middle past its edge, the nearest on it.
vec4 colourOf(vec2 m) {
  vec2 p = origin + vec2(turn.x * m.x - turn.y * m.y, turn.y * m.x + turn.x * m.y);
  p = clamp(p, vec2(0.5), size - 0.5);
  // Hexagons' and triangles' middles can lie exactly on the border between two averages: the one after it, as the
  // processor rounds, however the card's arithmetic falls.
  return average(ivec2(floor((p - corner) / cell + 1e-3)));
}
// Triangle i of row j, as triangleCells lays them, pointing up when i + j is even: its middle, and how far q is from it,
// made smaller about its middle.
vec2 triangleMiddle(float i, float j) {
  float row = cell * SQRT3 / 2.0;
  return vec2(i * cell / 2.0 + cell / 2.0, j * row + (mod(i + j, 2.0) == 0.0 ? row * 2.0 / 3.0 : row / 3.0));
}
float triangleCell(vec2 q, float i, float j, float shrink) {
  vec2 p = q - triangleMiddle(i, j);
  return triangle(mod(i + j, 2.0) == 0.0 ? p : vec2(p.x, -p.y), cell / 2.0 * shrink);
}
vec4 result;
// Lays a cell over what is drawn so far, as the canvas draws one: cells that touch are each outlined in their own colour
// too, half a pixel out, so that nothing shows between them.
void lay(vec4 c, float sd) {
  if (c.a <= 0.0) return;
  float amount = gap == 0.0 && shape != 2 && shape != 3 ? clamp(1.0 - sd, 0.0, 1.0) : covers(sd, 1.0);
  result = over(vec4(c.rgb * c.a, c.a), amount, result);
}
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
  vec2 d = pixel - origin;
  vec2 q = vec2(turn.x * d.x + turn.y * d.y, -turn.y * d.x + turn.x * d.y);
  if (sharp == 1) {
    vec4 c = colourOf((floor(q / cell) + 0.5) * cell);
    colour = vec4(c.rgb * c.a, c.a);
    return;
  }
  result = gapColour;
  float shrink = 1.0 - gap;
  // A pixel more than a pixel inside its own cell is covered by that cell alone: those around it, outlined half a pixel
  // out at most, do not reach it. Elsewhere the cells around it are laid in the order the processor draws them.
  if (shape == 1) {
    // Hexagons, laid out as hexCells in cells.ts lays them, row by row; the pixel's own is the nearest.
    float row = cell * SQRT3 / 2.0;
    float j0 = round(q.y / row);
    vec2 own = vec2(1e9);
    for (int dj = -1; dj <= 1; dj++) {
      float j = j0 + float(dj);
      float shift = mod(j, 2.0) * cell / 2.0;
      vec2 m = vec2(shift + round((q.x - shift) / cell) * cell, j * row);
      if (dot(q - m, q - m) < dot(q - own, q - own)) own = m;
    }
    vec2 a = abs(q - own);
    int reach = cell / 2.0 - max(a.x, dot(a, vec2(0.5, 0.8660254))) > 1.0 ? 0 : 1;
    for (int dj = -reach; dj <= reach; dj++) {
      float j = round(own.y / row) + float(dj);
      float shift = mod(j, 2.0) * cell / 2.0;
      float i0 = round((own.x - shift) / cell);
      for (int di = -reach; di <= reach; di++) {
        vec2 m = vec2(shift + (i0 + float(di)) * cell, j * row);
        lay(colourOf(m), hexagon(q - m, cell / 2.0 * shrink));
      }
    }
  } else if (shape == 4) {
    // Triangles, as triangleCells lays them: rows of them pointing up and down by turns, each half a cell along. Of
    // the two that reach across where the pixel is in its row, its own is the one whose slanting side it is inside.
    float row = cell * SQRT3 / 2.0;
    float j0 = floor(q.y / row);
    float along = q.x / (cell / 2.0), i0 = floor(along);
    float down = q.y / row - j0;
    bool up = mod(i0 + j0, 2.0) == 0.0;
    float i = fract(along) >= (up ? 1.0 - down : down) ? i0 : i0 - 1.0;
    // How near it is to the lines the triangles' sides lie on, across and slanting either way: no nearer than to its
    // own sides. The slanting lines, like the rows, are a row apart.
    vec2 slant = vec2(SQRT3 / 2.0, 0.5);
    float lines = row * min(min(down, 1.0 - down), min(
      abs(fract(dot(q, slant) / row) - 0.5),
      abs(fract(dot(q, vec2(-slant.x, slant.y)) / row) - 0.5)));
    if (lines > 1.0) {
      lay(colourOf(triangleMiddle(i, j0)), triangleCell(q, i, j0, shrink));
    } else {
      // The rows above and below only when it is near them.
      int from = row * down < 1.0 ? -1 : 0, to = row * (1.0 - down) < 1.0 ? 1 : 0;
      for (int dj = from; dj <= to; dj++) {
        for (int di = -2; di <= 1; di++) {
          float i = i0 + float(di), j = j0 + float(dj);
          lay(colourOf(triangleMiddle(i, j)), triangleCell(q, i, j, shrink));
        }
      }
    }
  } else {
    // Squares, circles and halftone dots, on the square grid.
    vec2 c0 = floor(q / cell);
    vec2 own = q - (c0 + 0.5) * cell;
    // The cells beside it on the side the pixel is, when it is within a pixel of them.
    ivec2 toward = ivec2(sign(own) * step(cell / 2.0 - 1.0, abs(own)));
    for (int dj = min(0, toward.y); dj <= max(0, toward.y); dj++) {
      for (int di = min(0, toward.x); di <= max(0, toward.x); di++) {
        vec2 m = (c0 + vec2(di, dj) + 0.5) * cell;
        vec4 c = colourOf(m);
        if (shape == 0) {
          float side = cell * shrink;
          lay(c, roundedBox(q - m, vec2(side / 2.0), rounding * side));
        } else {
          // A halftone dot's area follows the brightness under it.
          float bright = shape == 3 ? sqrt(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722))) : 1.0;
          float r = cell / 2.0 * shrink * bright;
          if (r >= 0.3) lay(c, length(q - m) - r);
        }
      }
    }
  }
  colour = result;
}
`;
