// Tests of the window with recordings that are videos, and with templates
// that show video. See window.test.ts for how these run.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ffmpeg, probe } from '../src/audio-io.ts';
import { writeSyntheticMix } from './synthetic-mix.ts';
import { dataFolder, electronPath, runApp, workFolder } from './window-app.ts';

const skip = process.env.DJMASTER_SKIP_WINDOW_TESTS
  ? 'DJMASTER_SKIP_WINDOW_TESTS is set'
  : electronPath() ? false : 'Electron is not installed here';

let work: string;
/** A minute of a test picture, with a keyframe every two seconds, and the sound of the synthetic mix. */
let filmed: string;
/** A data folder holding its analysis, to start the other runs from. */
let analysed: string;

const fresh = () => dataFolder(work, analysed);

/** What ffmpeg says about a file it is given nothing to do with. */
function described(file: string): string {
  try {
    execFileSync(ffmpeg(), ['-hide_banner', '-i', file], { stdio: 'pipe' });
  } catch (error) {
    return String((error as { stderr: Buffer }).stderr);
  }
  return '';
}

/** A checksum of each of the first `count` frames of a file's picture, from `seconds` on. */
function frames(file: string, count: number, seconds?: number): string[] {
  const output = execFileSync(ffmpeg(), [
    '-v', 'error', ...(seconds === undefined ? [] : ['-ss', String(seconds)]), '-i', file,
    '-map', '0:v', '-frames:v', String(count), '-f', 'framemd5', '-',
  ]).toString();
  return output.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split(',').pop()!.trim());
}

before(async () => {
  if (skip) return;
  work = await workFolder();
  const sound = join(work, 'sound.wav');
  await writeSyntheticMix(sound);
  filmed = join(work, 'Filmed set.mp4');
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25', '-i', sound, '-t', '60',
    '-c:v', 'libx264', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', filmed,
  ]);
  analysed = await dataFolder(work);
  await runApp({ recording: filmed, data: analysed }, () => null);
});

after(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

test('a video opens as a recording, and exports with its own picture, copied, from the frame the mix starts on', { skip }, async () => {
  const folder = join(work, 'original');
  await mkdir(folder);
  const seen = await runApp({ recording: filmed, data: await fresh(), exportFolder: folder, timeoutMs: 120_000 }, async (page) => {
    await page.until(() => page.text('stat-out') !== '–', 'the levelling to be worked out');
    const playing = () => page.element('play').classList.contains('playing');
    // Half a minute in, and on a little, so that the cut falls between two frames.
    page.key('Enter');
    page.key('ArrowRight', { shift: true });
    page.key('Space');
    await page.until(playing, 'playback to start');
    await page.wait(350);
    page.key('Space');
    await page.until(() => !playing(), 'playback to stop');
    page.click('split-here');
    await page.settle();
    document.querySelectorAll<HTMLElement>('.mix-tab')[1].click();
    await page.wait(100);
    const second = page.region().start;
    page.click('export-all');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    const offered = !page.element('export-original').hidden;
    page.click('export-original');
    const note = page.text('export-note');
    page.click('export-go');
    await page.until(() => /^Export/.test(page.text('export-status')), 'the export to finish', 100_000);
    return { name: page.text('file-name'), second, offered, note, status: page.text('export-status') };
  });
  assert.equal(seen.name, 'Filmed set.mp4');
  assert.ok(seen.offered, 'the original picture is offered for a video');
  assert.match(seen.note, /own 320 × 180 picture.*as MP4/);
  assert.match(seen.status, /^Exported 2 mixes\./);

  const files = (await readdir(folder)).sort();
  assert.deepEqual(files, ['Filmed set - 01 Mix 1.mp4', 'Filmed set - 02 Mix 2.mp4']);
  const start = seen.second.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  assert.ok(start > 30 && start < 32, `the second mix starts at ${start} s, between keyframes`);
  for (const file of files) {
    const about = described(join(folder, file));
    assert.match(about, /Video: h264.*320x180.*25 fps/, `${file} has the recording's picture, as it was`);
    assert.match(about, /Audio: aac/, `${file} has its sound`);
    assert.match(about, /title\s*: Filmed set - Mix/, `${file} keeps its tags`);
  }
  // The picture starts on the frame the mix starts on, though no keyframe is there,
  // and runs as long as the sound, give or take the few frames after the last keyframe.
  const second = join(folder, files[1]);
  assert.deepEqual(frames(second, 3), frames(filmed, 3, start));
  const sound = (await probe(second)).duration;
  assert.ok(Math.abs(sound - (60 - start)) < 0.25, `the second file is ${sound} s long, not ${60 - start}`);
});

test('a recording that is not a video is not offered its own picture', { skip }, async () => {
  const sound = join(work, 'sound.wav');
  const offered = await runApp({ recording: sound, data: await dataFolder(work) }, async (page) => {
    page.click('export');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    return !page.element('export-original').hidden;
  });
  assert.equal(offered, false);
});
