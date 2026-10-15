// Takes site/screenshot.png, the picture on the website and in the README,
// with the app's check mode: `node scripts/screenshot.mjs <recording>`.
//
// The recording should be about an hour of music; it is shown under the
// neutral name "Saturday night.wav". The state in the picture is set up by
// screenshot/setup.js, and its tracks are made-up names, so that no real
// artist or track ends up on the website. The app is built first.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const recording = process.argv[2];
if (!recording || !existsSync(recording)) {
  console.error('Usage: node scripts/screenshot.mjs <recording of about an hour>');
  process.exit(1);
}

const here = resolve(import.meta.dirname, 'screenshot');
const work = mkdtempSync(join(tmpdir(), 'djm-screenshot-'));
const shown = join(work, 'Saturday night.wav');
symlinkSync(resolve(recording), shown);
const picture = join(work, 'screenshot.png');

execFileSync('node', ['scripts/build.mjs'], { stdio: 'inherit' });
const app = spawn('npx', ['electron', '.', shown], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: {
    ...process.env,
    DJMASTER_SHOT: picture,
    DJMASTER_SHOT_SCALE: '2',
    DJMASTER_SHOT_DATA: join(work, 'data'),
    DJMASTER_SHOT_TRACKLIST: join(here, 'tracks.txt'),
    DJMASTER_SHOT_SCRIPT: readFileSync(join(here, 'setup.js'), 'utf8'),
  },
});
app.stdout.on('data', (data) => process.stdout.write(data));
// The first analysis of an hour takes a while; a script that goes wrong must not leave the app running.
const limit = setTimeout(() => app.kill(), 5 * 60_000);
app.on('close', () => {
  clearTimeout(limit);
  if (existsSync(picture)) {
    copyFileSync(picture, 'site/screenshot.png');
    console.log('Saved site/screenshot.png. Look at it before committing.');
  } else {
    console.error('No picture was taken.');
    process.exitCode = 1;
  }
  rmSync(work, { recursive: true, force: true });
});
