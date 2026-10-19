// Makes the Microsoft Store package's tiles in build/appx/ from build/icon.png:
// `node scripts/make-store-tiles.mjs`. electron-builder takes them from there
// by these names. The icon sits in the middle of each, on nothing: Windows
// shows the package's background colour (`appx.backgroundColor`) around it.
// Run again when the icon changes, and commit what it makes.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = join(root, 'build', 'appx');
mkdirSync(out, { recursive: true });
const ffmpeg = process.env.DJMASTER_FFMPEG ?? 'ffmpeg';

// Name, width and height of the tile, and how large the icon is in it.
const TILES = [
  ['StoreLogo.png', 50, 50, 50],
  ['Square44x44Logo.png', 44, 44, 44],
  ['SmallTile.png', 71, 71, 52],
  ['Square150x150Logo.png', 150, 150, 104],
  ['Wide310x150Logo.png', 310, 150, 104],
  ['LargeTile.png', 310, 310, 214],
];
for (const [name, width, height, icon] of TILES) {
  execFileSync(ffmpeg, [
    '-v', 'error', '-y', '-i', join(root, 'build', 'icon.png'),
    '-vf', `format=rgba,scale=${icon}:${icon}:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    '-frames:v', '1', join(out, name),
  ]);
}
console.log(`Made ${TILES.length} tiles in build/appx/.`);
