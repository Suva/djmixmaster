// Tests of the window with recordings that are videos, and with templates
// that show video. See window.test.ts for how these run.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ffmpeg, probe } from '../src/audio-io.ts';
import { writeSyntheticMix } from './synthetic-mix.ts';
import { dataFolder, electronPath, runApp, workFolder } from './window-app.ts';
import { readZip, readZipEntry } from '../src/app/zip.ts';

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
  // The picture is encoded again, so even the right frame differs a little; it
  // has to match better than the moments either side of it and the one with no delay.
  const right = difference(made, thumbnail(filmed, 31.6));
  for (const other of [31.3, 31.9, 32]) {
    const wrong = difference(made, thumbnail(filmed, other));
    assert.ok(right < wrong * 0.8, `the frame matches the recording at 31.6 s (${right.toFixed(1)}) better than at ${other} s (${wrong.toFixed(1)})`);
  }
});

test('a ping-pong clip plays there and back, and a clip in a codec the window cannot play is shown from a copy', { skip }, async () => {
  const prores = join(work, 'Colours.mov');
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-i', clip, '-c:v', 'prores_ks', prores]);
  const half = (x: number, params: Record<string, unknown>) => ({ type: 'video', params: { fit: 'stretch', width: 50, height: 100, x, ...params } });
  const file = join(work, 'There and back.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1, name: 'There and back', fields: [],
    layers: [half(25, { video: clip, playback: 'ping-pong' }), half(75, { video: prores, playback: 'loop' })],
  }));
  const folder = join(work, 'ping-pong');
  await mkdir(folder);
  const seen = await runApp({ recording: filmed, data: await fresh(), template: file, exportFolder: folder, timeoutMs: 150_000 }, async (page) => {
    page.key('Enter');
    for (let i = 0; i < 2; i++) page.key('ArrowRight');
    await page.wait(100);
    page.key('KeyO');
    page.key('Enter');
    await page.settle();
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'There and back', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const at = (x: number) => [...picture.getContext('2d')!.getImageData(Math.floor(picture.width * x), picture.height / 2, 1, 1).data];
    await page.until(() => at(0.75)[0] > 150 && at(0.75)[1] < 100, 'the ProRes clip to be drawn from its copy', 30_000);
    page.click('export-all');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    document.querySelector<HTMLButtonElement>('[data-format=mp4]')!.click();
    page.click('export-go');
    await page.until(() => /^Export/.test(page.text('export-status')), 'the export to finish', 120_000);
    return page.text('export-status');
  });
  assert.match(seen, /^Exported 1 mix\./, seen);
  const [exported] = await readdir(folder);
  const video = join(folder, exported);
  // Thirds of a picture in halves: the first is the left half, the last the right.
  const halves = (seconds: number) => { const [left, , right] = thirdsAt(video, seconds); return [left, right]; };
  assert.deepEqual(halves(0.5), ['red', 'red']);
  assert.deepEqual(halves(2.5), ['blue', 'blue']);
  assert.deepEqual(halves(3.5), ['blue', 'red'], 'on its way back, and round again');
  assert.deepEqual(halves(4.5), ['green', 'green']);
  assert.deepEqual(halves(5.5), ['red', 'blue']);
  assert.deepEqual(halves(6.5), ['red', 'red'], 'and forwards once more');
});

test('a template is shared with its video packed beside it, and brings it along when added', { skip }, async () => {
  const file = join(work, 'With a clip.json');
  await writeFile(file, JSON.stringify({
    format: 1, name: 'With a clip', fields: [],
    layers: [{ type: 'video', params: { video: 'media:Colours', fit: 'stretch', width: 100, height: 100 } }],
    media: { Colours: { path: clip, bytes: 1 } },
  }));
  const shared = join(work, 'shared');
  await mkdir(shared);
  await runApp({ recording: filmed, data: await fresh(), template: file, exportFolder: shared }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'With a clip', 'the template to be added');
    page.click('template-export');
    await page.until(() => /^Saved/.test(page.text('readout')), 'the template to be saved');
  });
  const packed = join(shared, 'With a clip.djmtemplate');
  const items = await readZip(packed);
  assert.deepEqual(items.map((item) => item.name), ['template.json', 'media/Colours.mp4']);
  assert.equal(items[1].method, 0, 'stored as it is');
  const json = JSON.parse((await readZipEntry(packed, items[0])).toString('utf8'));
  assert.equal(json.media.Colours.path, 'media/Colours.mp4');

  // Somewhere else, with nothing but the file.
  const data = await fresh();
  const seen = await runApp({ recording: filmed, data, template: packed }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'With a clip', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const middle = () => [...picture.getContext('2d')!.getImageData(picture.width / 2, picture.height / 2, 1, 1).data];
    await page.until(() => middle()[0] > 150 && middle()[1] < 100, 'the packed video to be drawn');
    return page.element('media-missing').hidden;
  });
  assert.ok(seen, 'nothing is missing');
  const kept = await readdir(join(data, 'media'));
  assert.equal(kept.length, 1);
  assert.match(kept[0], /^[0-9a-f]{40}\.mp4$/, 'taken out into the media folder, named by what is in it');
});

test('videos of a template that have moved are found again: one located by hand, and the other beside it', { skip }, async () => {
  const moved = join(work, 'moved');
  await mkdir(moved);
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-i', clip, '-c', 'copy', join(moved, 'Colours.mp4')]);
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-i', clip, '-vf', 'negate', '-c:v', 'libx264', join(moved, 'Negative.mp4')]);
  const gone = join(work, 'gone');
  const file = join(work, 'Moved.json');
  await writeFile(file, JSON.stringify({
    format: 1, name: 'Moved', fields: [],
    layers: [
      { type: 'video', params: { video: 'media:Colours', fit: 'stretch', width: 50, height: 100, x: 25 } },
      { type: 'video', params: { video: 'media:Negative', fit: 'stretch', width: 50, height: 100, x: 75 } },
    ],
    media: { Colours: { path: join(gone, 'Colours.mp4'), bytes: 1 }, Negative: { path: join(gone, 'Negative.mp4'), bytes: 1 } },
  }));
  const data = await fresh();
  const seen = await runApp({ recording: filmed, data, template: file, video: join(moved, 'Colours.mp4') }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Moved', 'the template to be added');
    const notice = page.element('media-missing');
    await page.until(() => !notice.hidden, 'the missing videos to be said');
    const said = notice.querySelector('p')!.textContent;
    const buttons = [...notice.querySelectorAll('button')].map((button) => button.textContent);
    notice.querySelector('button')!.click();
    await page.until(() => notice.hidden, 'both videos to be found');
    const picture = page.element<HTMLCanvasElement>('picture');
    const at = (x: number) => [...picture.getContext('2d')!.getImageData(Math.floor(picture.width * x), picture.height / 2, 1, 1).data];
    // Red on the left; the negative of red, cyan, on the right.
    await page.until(() => at(0.25)[0] > 150 && at(0.75)[0] < 100 && at(0.75)[1] > 150, 'both videos to be drawn');
    await page.settle();
    return { said, buttons };
  });
  assert.match(seen.said, /2 videos of this template are not where it says they are: Colours, Negative/);
  assert.deepEqual(seen.buttons, ['Locate Colours…', 'Locate Negative…']);
  const [stored] = await readdir(join(data, 'templates'));
  const saved = JSON.parse(readFileSync(join(data, 'templates', stored), 'utf8'));
  assert.ok(saved.media.Colours.path.startsWith(join(data, 'media')), 'the one located, small, kept in the media folder');
  assert.equal(saved.media.Negative.path, join(moved, 'Negative.mp4'), 'the other found beside it');
});

test('a clip made on green or on black has that keyed out, and a clip that starts again on every beat never gets far', { skip }, async () => {
  const green = join(work, 'Green.mp4');
  const black = join(work, 'Black.mp4');
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=160x90:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', green]);
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', black]);
  // A quarter of a second red, a quarter green, then blue: played from its start on every beat, it is never blue.
  const quick = join(work, 'Quick.mp4');
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=25:d=0.24', '-f', 'lavfi', '-i', 'color=c=lime:s=160x90:r=25:d=0.24',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=2', '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', quick,
  ]);
  const file = join(work, 'Keyed.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1, name: 'Keyed', fields: [],
    layers: [
      { type: 'gradient', params: { colour1: '#ff00ff', colour2: '#ff00ff' } },
      { type: 'video', params: { video: green, fit: 'stretch', width: 33.4, height: 100, x: 16.7, key: 'colour', keyColour: '#00ff00' } },
      { type: 'video', params: { video: black, fit: 'stretch', width: 33.4, height: 100, x: 50, key: 'dark' } },
      { type: 'video', params: { video: quick, fit: 'stretch', width: 33.4, height: 100, x: 83.3, restart: 'each beat' } },
    ],
  }));
  const folder = join(work, 'keyed');
  await mkdir(folder);
  const seen = await runApp({ recording: filmed, data: await fresh(), template: file, exportFolder: folder, timeoutMs: 150_000 }, async (page) => {
    page.key('Enter');
    for (let i = 0; i < 2; i++) page.key('ArrowRight');
    await page.wait(100);
    page.key('KeyO');
    page.key('Enter');
    await page.settle();
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Keyed', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const at = (x: number) => [...picture.getContext('2d')!.getImageData(Math.floor(picture.width * x), picture.height / 2, 1, 1).data].slice(0, 3);
    // Wait for the clip on the right, which is not keyed, to be drawn: the others are then too.
    await page.until(() => at(5 / 6)[0] > 150 && at(5 / 6)[2] < 100, 'the clips to be drawn');
    const shown = [at(1 / 6), at(1 / 2)];
    page.click('export-all');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    document.querySelector<HTMLButtonElement>('[data-format=mp4]')!.click();
    page.click('export-go');
    await page.until(() => /^Export/.test(page.text('export-status')), 'the export to finish', 120_000);
    return { shown, status: page.text('export-status') };
  });
  // Magenta shows through where green and black were keyed out.
  for (const [r, g, b] of seen.shown) assert.ok(r > 200 && g < 60 && b > 200, `the background shows through: ${[r, g, b]}`);
  assert.match(seen.status, /^Exported 1 mix\./, seen.status);
  const [exported] = await readdir(folder);
  const video = join(folder, exported);
  const colours = [];
  // Past the first beat, which the analysis finds a little after the start.
  for (let seconds = 1; seconds < 9.5; seconds += 0.37) colours.push(thirdsAt(video, seconds)[2]);
  assert.ok(!colours.includes('blue'), `restarted on every beat, the clip never reaches its blue: ${colours.join(' ')}`);
  assert.ok(colours.includes('red') && colours.includes('green'), colours.join(' '));
});

test('a video opens with its own picture as the template, and a recording without one with the first template', { skip }, async () => {
  const chosen = async (recording: string) => runApp({ recording, data: await dataFolder(work) }, async (page) => {
    page.click('view-video');
    await page.wait(100);
    return page.element<HTMLSelectElement>('template').value;
  });
  assert.equal(await chosen(filmed), 'original');
  assert.equal(await chosen(join(work, 'sound.wav')), 'glitter');
});
