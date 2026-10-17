// Tests of the window with recordings that are videos, and with templates
// that show video. See window.test.ts for how these run.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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
/** Three seconds of a clip: a second red, a second green, a second blue. */
let clip: string;
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
  clip = join(work, 'Colours.mp4');
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=lime:s=160x90:r=25:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=1', '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip,
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

/** Which of red, green and blue is strongest in each third of a picture, given as RGB bytes of three pixels. */
function thirds(rgb: Uint8Array | number[]): string[] {
  return [0, 1, 2].map((third) => {
    const [r, g, b] = [rgb[third * 3], rgb[third * 3 + 1], rgb[third * 3 + 2]];
    if (Math.max(r, g, b) < 60) return 'black';
    return r > g && r > b ? 'red' : g > b ? 'green' : 'blue';
  });
}

/** The colours of the thirds of a video's frame at a moment, each averaged. */
function thirdsAt(file: string, seconds: number): string[] {
  const rgb = execFileSync(ffmpeg(), [
    '-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=3:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  return thirds(rgb);
}

test('a video layer plays its clip with the music, looped, once, and at twice the speed, in the view and in the export', { skip }, async () => {
  // The clip three times side by side: looped, played once and hidden, and looped at twice the speed.
  const third = (x: number, params: Record<string, unknown>) => ({
    type: 'video', params: { video: clip, fit: 'stretch', width: 33.4, height: 100, x, ...params },
  });
  const file = join(work, 'Colours.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1,
    name: 'Colours',
    fields: [],
    layers: [third(16.7, { playback: 'loop' }), third(50, { playback: 'once, then hide' }), third(83.3, { playback: 'loop', speed: 200 })],
  }));
  const folder = join(work, 'clips');
  await mkdir(folder);
  const seen = await runApp({ recording: filmed, data: await fresh(), template: file, exportFolder: folder, timeoutMs: 150_000 }, async (page) => {
    // A mix of the first ten seconds.
    page.key('Enter');
    for (let i = 0; i < 2; i++) page.key('ArrowRight');
    await page.wait(100);
    page.key('KeyO');
    page.key('Enter');
    await page.settle();
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Colours', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const row = () => {
      const y = Math.floor(picture.height / 2);
      const context = picture.getContext('2d')!;
      return [1, 3, 5].flatMap((sixth) => [...context.getImageData(Math.floor((picture.width * sixth) / 6), y, 1, 1).data].slice(0, 3));
    };
    // At the start of the mix, paused: the first frame of each.
    await page.until(() => row()[0] > 150 && row()[3] > 150 && row()[6] > 150, 'the clips to be drawn at their start');
    const atStart = row();
    // Five seconds on: two seconds into the second round, gone, and ten seconds' worth in, at twice the speed.
    page.key('ArrowRight');
    const colour = (rgb: number[], third: number) => {
      const [r, g, b] = rgb.slice(third * 3, third * 3 + 3);
      return Math.max(r, g, b) < 60 ? 'black' : r > g && r > b ? 'red' : g > b ? 'green' : 'blue';
    };
    await page.until(() => [0, 1, 2].map((third) => colour(row(), third)).join() === 'blue,black,green', 'the clips to follow the playhead');
    const later = row();
    page.click('export-all');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    document.querySelector<HTMLButtonElement>('[data-format=mp4]')!.click();
    page.click('export-go');
    await page.until(() => /^Export/.test(page.text('export-status')), 'the export to finish', 120_000);
    return { atStart, later, status: page.text('export-status'), length: page.region().length };
  });
  assert.deepEqual(thirds(seen.atStart), ['red', 'red', 'red']);
  assert.deepEqual(thirds(seen.later), ['blue', 'black', 'green']);
  assert.match(seen.status, /^Exported 1 mix\./, seen.status);
  assert.equal(seen.length, '0:00:10');
  const [exported] = await readdir(folder);
  const video = join(folder, exported);
  assert.deepEqual(thirdsAt(video, 0.5), ['red', 'red', 'green']);
  assert.deepEqual(thirdsAt(video, 1.5), ['green', 'green', 'red']);
  assert.deepEqual(thirdsAt(video, 2.5), ['blue', 'blue', 'blue']);
  assert.deepEqual(thirdsAt(video, 3.5), ['red', 'black', 'green'], 'looped, gone, and round again');
  assert.deepEqual(thirdsAt(video, 4.5), ['green', 'black', 'red']);
});

test('a small video is kept in the app\'s media folder, and stays where it is', { skip }, async () => {
  const data = await fresh();
  const kept = await runApp({ recording: filmed, data, given: clip }, async (_page, path) => window.api.addMedia(path));
  assert.ok(kept.path.startsWith(join(data, 'media')), `kept at ${kept.path}`);
  assert.ok(kept.bytes > 0 && kept.fingerprint);
  assert.deepEqual(await readdir(join(data, 'media')), [kept.path.split(/[\\/]/).pop()]);
});

/** A frame of a video at a moment, as 16 × 9 shades of grey. */
function thumbnail(file: string, seconds: number): Uint8Array {
  return execFileSync(ffmpeg(), [
    '-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=16:9:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ]);
}
const difference = (a: Uint8Array, b: Uint8Array) => a.reduce((total, value, i) => total + Math.abs(value - b[i]), 0) / a.length;

test('a template shows the recording\'s own picture in step with the mix, as late as the picture is delayed', { skip }, async () => {
  const file = join(work, 'Picture.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1, name: 'Picture', fields: [],
    layers: [{ type: 'video', params: { video: 'recording:video', fit: 'stretch', width: 100, height: 100 } }],
  }));
  const folder = join(work, 'picture');
  await mkdir(folder);
  const seen = await runApp({ recording: filmed, data: await fresh(), template: file, exportFolder: folder, timeoutMs: 150_000 }, async (page) => {
    // A mix from half a minute in, ten seconds long.
    page.key('Enter');
    page.key('ArrowRight', { shift: true });
    page.key('KeyI');
    for (let i = 0; i < 2; i++) page.key('ArrowRight');
    await page.wait(100);
    page.key('KeyO');
    await page.settle();
    page.click('view-video');
    const offered = !page.element('picture-delay-row').hidden;
    const builtIn = [...page.element<HTMLSelectElement>('template').options].map((option) => option.text);
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Picture', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const middle = () => [...picture.getContext('2d')!.getImageData(picture.width / 2, picture.height / 2, 1, 1).data];
    await page.until(() => Math.max(...middle().slice(0, 3)) > 40, 'the recording\'s picture to be drawn');
    page.type('picture-delay', '400');
    await page.settle();
    page.click('export-all');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    document.querySelector<HTMLButtonElement>('[data-format=mp4]')!.click();
    page.click('export-go');
    await page.until(() => /^Export/.test(page.text('export-status')), 'the export to finish', 120_000);
    return { offered, builtIn, status: page.text('export-status'), region: page.region() };
  });
  assert.ok(seen.offered, 'the picture delay is offered for a video');
  assert.ok(seen.builtIn.includes('Original video'));
  assert.match(seen.status, /^Exported 1 mix\./, seen.status);
  assert.equal(seen.region.length, '0:00:10');
  const [exported] = await readdir(folder);
  const made = thumbnail(join(folder, exported), 2);
  // Two seconds in, 0.4 s late: the recording at 31.6 s, not 32 s.
  const right = difference(made, thumbnail(filmed, 31.6));
  const wrong = difference(made, thumbnail(filmed, 32));
  assert.ok(right < wrong / 2, `the frame matches the recording 0.4 s earlier (${right.toFixed(1)}) better than at the same moment (${wrong.toFixed(1)})`);
});
