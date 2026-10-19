// Tests of the window: each starts the real app, drives it as a user would
// and looks at what it shows or writes. See window-app.ts for how, and
// AGENTS.md for the check mode this rests on. They need the app built
// (`npm test` does that first) and are skipped where Electron is not installed.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ffmpeg, probe } from '../src/audio-io.ts';
import { HOP_SECONDS } from '../src/loudness.ts';
import { measure } from '../src/master.ts';
import { TRACK_LEVELS_DB, TRACK_SECONDS, writeSyntheticMix } from './synthetic-mix.ts';
import { dataFolder, electronPath, runApp, workFolder } from './window-app.ts';
import { readZip, readZipEntry } from '../src/app/zip.ts';

const skip = process.env.DJMASTER_SKIP_WINDOW_TESTS
  ? 'DJMASTER_SKIP_WINDOW_TESTS is set'
  : electronPath() ? false : 'Electron is not installed here';

let work: string;
/** Three tracks at uneven levels, nine minutes in all. */
let mix: string;
/** The same twice over with twenty seconds of silence between: two sets in one recording. */
let night: string;
/** A data folder holding the analyses of both, to start the other runs from. */
let analysed: string;

const fresh = () => dataFolder(work, analysed);

/** The template in a template file to share: a ZIP, with the JSON as template.json. */
async function sharedTemplate(file: string): Promise<{ name: string }> {
  const json = (await readZip(file)).find((item) => item.name === 'template.json')!;
  return JSON.parse((await readZipEntry(file, json)).toString('utf8'));
}
const MIX_SECONDS = TRACK_LEVELS_DB.length * TRACK_SECONDS;

before(async () => {
  if (skip) return;
  work = await workFolder();
  mix = join(work, 'Test mix.wav');
  night = join(work, 'Two sets.wav');
  await writeSyntheticMix(mix);
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-i', mix, '-f', 'lavfi', '-t', '20', '-i', 'anullsrc=r=44100:cl=stereo', '-i', mix,
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1', '-c:a', 'pcm_s16le', night,
  ]);
  analysed = await dataFolder(work);
  await runApp({ recording: mix, data: analysed }, () => null);
  await runApp({ recording: night, data: analysed }, () => null);
});

after(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

test('a recording opens as one mix over all of it', { skip }, async () => {
  const shown = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    await page.until(() => page.text('stat-out') !== '–', 'the levelling to be worked out');
    return {
      name: page.text('file-name'),
      tabs: page.tabs(),
      length: page.region().length,
      loudnessNow: page.text('stat-in'),
      afterLevelling: page.text('stat-out'),
      checkup: page.text('checkup'),
      canExport: !page.element<HTMLButtonElement>('export').disabled,
      settingsUsable: !page.element('settings').inert,
      startScreen: !page.element('empty').hidden,
    };
  });
  assert.equal(shown.name, 'Test mix.wav');
  assert.equal(shown.tabs.length, 1);
  assert.match(shown.tabs[0], /Mix 1/);
  assert.equal(shown.length, '0:09:00');
  assert.match(shown.loudnessNow, /LUFS$/);
  assert.match(shown.afterLevelling, /LUFS$/);
  assert.notEqual(shown.checkup, '');
  assert.ok(shown.canExport && shown.settingsUsable && !shown.startScreen);
});

test('settings change the levelling', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    await page.until(() => page.text('stat-out') !== '–', 'the levelling to be worked out');
    const gainBefore = page.text('stat-gain');
    page.slide('boost', 0);
    await page.until(() => page.text('stat-gain') !== gainBefore, 'the gain range to follow the boost limit');
    const gainWithoutBoost = page.text('stat-gain');
    page.choose('loudness', 'streaming');
    await page.until(() => Math.abs(parseFloat(page.text('stat-out')) + 14) < 0.5, 'the Streaming preset to land near -14 LUFS');
    return { gainBefore, gainWithoutBoost, note: page.text('loudness-note'), after: page.text('stat-out') };
  });
  // The tracks are up to 10 dB apart. With no boost allowed the quiet ones stay
  // behind, so the gain moves over a smaller range than before.
  const span = (range: string) => {
    const [low, high] = range.split(' to ').map(parseFloat);
    return high - low;
  };
  assert.ok(span(seen.gainBefore) > 6, `gain range was ${seen.gainBefore}`);
  assert.ok(span(seen.gainWithoutBoost) < span(seen.gainBefore) - 1, `${seen.gainBefore} became ${seen.gainWithoutBoost}`);
  assert.notEqual(seen.note, '');
});

test('a fixed gain in place of levelling, set by hand and carried back', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    await page.until(() => page.text('stat-out') !== '–', 'the levelling to be worked out');
    const levelled = page.text('stat-gain');
    page.click('fixed-gain');
    await page.until(() => page.text('stat-gain') !== levelled, 'the gain to stop following the tracks');
    const fits = page.text('stat-gain');
    const hidden = document.getElementById('track-levelling')!.hidden;
    page.choose('loudness', 'custom');
    page.slide('gain', 3);
    await page.until(() => page.text('stat-gain').startsWith('+3.0 dB'), 'the gain set by hand');
    const byHand = { gain: page.text('stat-gain'), shown: page.text('target-value') };
    page.click('level-tracks');
    await page.until(() => page.text('stat-gain') !== byHand.gain, 'the levelling to come back');
    await page.settle();
    return { levelled, fits, hidden, byHand, back: page.text('stat-gain'), choice: (document.getElementById('loudness') as HTMLSelectElement).value };
  });
  const [low, high] = seen.fits.split(' to ');
  assert.equal(low, high, `a fixed gain moved: ${seen.fits}`);
  assert.ok(seen.hidden, 'the settings for levelling tracks are put away');
  assert.deepEqual(seen.byHand, { gain: '+3.0 dB to +3.0 dB', shown: '+3.0 dB' });
  assert.equal(seen.back.split(' to ')[0] === seen.back.split(' to ')[1], false, `levelling back: ${seen.back}`);
  assert.equal(seen.choice, 'custom', 'a level set by hand stays set by hand');
});

test('a mix can be split, deleted with Backspace, and both undone', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    await page.settle();
    // Deleting the only mix takes away what was marked: it covers everything again.
    page.key('Enter');
    for (let i = 0; i < 2; i++) page.key('ArrowRight', { shift: true });
    await page.wait(100);
    page.key('KeyI');
    await page.wait(100);
    const trimmed = page.region().length;
    page.key('Backspace');
    await page.wait(100);
    const afterDeletingTheOnlyMix = { tabs: page.tabs().length, length: page.region().length, trimmed };

    page.key('Enter');
    for (let i = 0; i < 6; i++) page.key('ArrowRight', { shift: true });
    await page.wait(100);
    // Control+E, as on Windows; the app takes Command the same way.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', ctrlKey: true, bubbles: true }));
    await page.settle();
    const afterSplit = page.tabs();
    // The piece before the cut stays selected, with the playhead resting at its end.
    const selected = document.querySelector('.mix-tab.on')!.textContent!.trim();
    const playheadAfterSplit = page.playhead();

    // Playing from a little before the end plays from there and comes to rest at the end.
    const playing = () => page.element('play').classList.contains('playing');
    for (let i = 0; i < 2; i++) page.key('ArrowLeft');
    await page.wait(100);
    page.key('Space');
    await page.until(playing, 'playback to start');
    const playedFrom = page.playhead();
    for (let i = 0; i < 3; i++) page.key('KeyL');
    await page.until(() => !playing(), 'playback to reach the end of the mix');
    await page.wait(200);
    const restedAt = page.playhead();
    // Playing again from the end starts the mix over.
    page.key('Space');
    await page.until(playing, 'playback to start again');
    const startedOverAt = page.playhead();
    page.key('Space');
    await page.until(() => !playing(), 'playback to stop');
    page.key('Enter');
    for (let i = 0; i < 6; i++) page.key('ArrowRight', { shift: true });
    await page.wait(100);

    page.key('Backspace');
    await page.settle();
    const afterDelete = page.tabs();
    const message = page.text('export-status');

    page.click('undo');
    await page.settle();
    const afterUndo = page.tabs();
    page.click('undo');
    await page.settle();
    const afterSecondUndo = page.tabs();
    page.click('redo');
    await page.settle();
    return { afterDeletingTheOnlyMix, afterSplit, selected, playheadAfterSplit, playedFrom, restedAt, startedOverAt, afterDelete, message, afterUndo, afterSecondUndo, afterRedo: page.tabs() };
  });
  assert.deepEqual(seen.afterDeletingTheOnlyMix, { tabs: 1, length: '0:09:00', trimmed: '0:08:00' });
  assert.equal(seen.afterSplit.length, 2);
  assert.match(seen.afterSplit[0], /0:03:00/);
  assert.match(seen.afterSplit[1], /0:06:00/);
  assert.equal(seen.afterDelete.length, 1);
  assert.equal(seen.selected, seen.afterSplit[0]);
  assert.equal(seen.playheadAfterSplit, 180);
  assert.ok(seen.playedFrom >= 170 && seen.playedFrom <= 173, `played from ${seen.playedFrom}`);
  assert.equal(seen.restedAt, 180);
  assert.ok(seen.startedOverAt <= 2, `started over at ${seen.startedOverAt}`);
  assert.match(seen.message, /^Deleted Mix 1\./);
  assert.deepEqual(seen.afterUndo, seen.afterSplit);
  assert.equal(seen.afterSecondUndo.length, 1);
  assert.deepEqual(seen.afterRedo, seen.afterSplit);
});

test('Split at gaps cuts a night into its sets', { skip }, async () => {
  const seen = await runApp({ recording: night, data: await fresh() }, async (page) => {
    await page.until(() => !page.element<HTMLButtonElement>('split-gaps').disabled, 'Split at gaps to be offered');
    page.click('split-gaps');
    await page.settle();
    return { tabs: page.tabs(), exportAll: !page.element('export-all-group').hidden, label: page.text('export-all') };
  });
  assert.equal(seen.tabs.length, 2);
  // Each set is the nine minutes of music with a little air left around it.
  for (const tab of seen.tabs) assert.match(tab, /0:09:0\d$/);
  assert.ok(seen.exportAll);
  assert.match(seen.label, /Export all 2/);
});

test('work is remembered, and the last recording comes back by itself', { skip }, async () => {
  const data = await fresh();
  await runApp({ recording: mix, data }, async (page) => {
    page.type('mix-name', 'Warm-up');
    page.slide('cut', 6);
    page.key('Enter');
    for (let i = 0; i < 6; i++) page.key('ArrowRight', { shift: true });
    await page.wait(100);
    page.click('split-here');
    await page.settle();
    // The last change, and the app quits straight after: saved as the window closes, and written before it is gone.
    page.type('mix-artist', 'Suva');
  });
  // No recording is named this time: the app is started as from the Dock.
  const back = await runApp({ data }, (page) => ({
    name: page.text('file-name'),
    tabs: page.tabs(),
    artist: page.element<HTMLInputElement>('mix-artist').value,
    cut: page.text('cut-value'),
    message: page.text('export-status'),
    undo: !page.element<HTMLButtonElement>('undo').disabled,
  }));
  assert.equal(back.name, 'Test mix.wav');
  assert.equal(back.tabs.length, 2);
  assert.match(back.tabs[0], /Warm-up/);
  assert.equal(back.artist, 'Suva');
  assert.match(back.cut, /6\.0 dB/);
  assert.equal(back.message, 'Picked up where you left off.');
  assert.ok(!back.undo, 'undo does not reach into an earlier session');
});

test('a recording that has been moved and renamed keeps its mixes and its analysis', { skip }, async () => {
  const data = await fresh();
  const folder = join(work, 'moved');
  await mkdir(join(folder, 'elsewhere'), { recursive: true });
  const original = join(folder, 'Friday.wav');
  const moved = join(folder, 'elsewhere', 'Friday, renamed.wav');
  await copyFile(mix, original);

  await runApp({ recording: original, data }, async (page) => {
    page.type('mix-name', 'Warm-up');
    page.key('Enter');
    for (let i = 0; i < 6; i++) page.key('ArrowRight', { shift: true });
    await page.wait(100);
    page.click('split-here');
    await page.settle();
  });
  const analyses = (await readdir(join(data, 'analyses'))).length;

  await rename(original, moved);
  const back = await runApp({ recording: moved, data }, (page) => ({
    name: page.text('file-name'),
    tabs: page.tabs(),
    message: page.text('export-status'),
  }));
  assert.equal(back.name, 'Friday, renamed.wav');
  assert.equal(back.tabs.length, 2);
  assert.match(back.tabs[0], /Warm-up/);
  assert.equal(back.message, 'Picked up where you left off.');
  assert.equal((await readdir(join(data, 'analyses'))).length, analyses, 'it was not analysed a second time');
});

test('a recording in several files opens, plays and is remembered as one', { skip }, async () => {
  const folder = join(work, 'parts');
  await mkdir(folder);
  // Cut into parts of a little over three minutes, as a recorder would at its file size limit.
  execFileSync(ffmpeg(), [
    '-v', 'error', '-i', mix, '-f', 'segment', '-segment_time', '200', '-segment_start_number', '1', '-c', 'copy',
    join(folder, 'Night part %d.wav'),
  ]);
  const parts = (await readdir(folder)).map((name) => join(folder, name));
  assert.equal(parts.length, 3);

  const whole = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    await page.until(() => page.text('stat-out') !== '–', 'the levelling to be worked out');
    return [page.text('stat-in'), page.text('stat-out'), page.text('stat-gain')];
  });
  const data = await dataFolder(work);
  // Handed over out of order: they are put in order by name.
  const joined = await runApp({ recording: [parts[2], parts[0], parts[1]], data, timeoutMs: 90_000 }, async (page) => {
    await page.until(() => page.text('stat-out') !== '–', 'the levelling to be worked out');
    const stats = [page.text('stat-in'), page.text('stat-out'), page.text('stat-gain')];
    // Playback, and the close-up wave across the first join, at 3:20.
    page.key('Space');
    await page.until(() => page.playhead() >= 1, 'playback to move on');
    page.key('Space');
    page.key('Enter');
    for (let i = 0; i < 6; i++) page.key('ArrowRight', { shift: true });
    for (let i = 0; i < 4; i++) page.key('ArrowRight');
    await page.wait(100);
    for (let i = 0; i < 14; i++) page.click('zoom-in');
    await page.wait(150);
    await page.until(() => page.element('detail').dataset.wave === 'fine', 'the wave across the join');
    return { name: page.text('file-name'), length: page.region().length, stats };
  });
  assert.equal(joined.name, 'Night part *.wav (3 files)');
  assert.equal(joined.length, '0:09:00');
  assert.deepEqual(joined.stats, whole, 'the parts measure exactly as the whole');
  // The analysis noted how long each part is, which lets playback jump straight into a later one.
  const [list] = await readdir(join(data, 'recordings'));
  const lengths = [...readFileSync(join(data, 'recordings', list), 'utf8').matchAll(/^duration (\S+)$/gm)].map((m) => Number(m[1]));
  assert.equal(lengths.length, 3);
  assert.ok(Math.abs(lengths.reduce((a, b) => a + b) - MIX_SECONDS) < 0.001, `the parts add up to ${lengths}`);

  const listed = await runApp({ data, menu: 'close' }, async (page) => {
    await page.until(() => !page.element('recent').hidden, 'the recent recordings to be listed');
    return [...document.querySelectorAll('.recent-item .name')].map((item) => item.textContent);
  });
  assert.deepEqual(listed, ['Night part *.wav (3 files)'], 'one entry for the three files');
});

test('what the visuals move to is worked out on request, and kept', { skip }, async () => {
  const data = await fresh();
  const seen = await runApp({ recording: mix, data, given: mix }, async (page, path) => {
    const fractions: number[] = [];
    window.api.onListening((_path, fraction) => fractions.push(fraction));
    let start = performance.now();
    const first = await window.api.features(path);
    const firstMs = performance.now() - start;
    start = performance.now();
    const again = await window.api.features(path);
    return {
      steps: first.level.length,
      beats: first.beats.length,
      same: again.beats.length === first.beats.length,
      againMs: performance.now() - start,
      firstMs,
      progressed: fractions.length > 0 && fractions.at(-1)! > 0.9,
      // Asking for them never stopped the window from working.
      name: page.text('file-name'),
    };
  });
  assert.equal(seen.steps, MIX_SECONDS * 30);
  assert.ok(Math.abs(seen.beats - MIX_SECONDS / 0.48) <= 3, `${seen.beats} beats`);
  assert.ok(seen.same && seen.progressed);
  assert.ok(seen.againMs < seen.firstMs / 2, 'the second time they come from storage');
  assert.equal(seen.name, 'Test mix.wav');
  assert.equal((await readdir(join(data, 'visual-features'))).length, 1);
});

test('the Video view draws the selected mix, and the mix keeps its template', { skip }, async () => {
  const data = await fresh();
  const first = await runApp({ recording: mix, data, timeoutMs: 90_000 }, async (page) => {
    const picture = page.element<HTMLCanvasElement>('picture');
    const mastering = { pictureShown: picture.offsetWidth > 0, curvesShown: page.element('detail').offsetWidth > 0 };
    page.key('Tab');
    await page.until(() => picture.dataset.music === 'true', 'the picture to be drawn from the music');
    const video = {
      pictureShown: picture.offsetWidth > 0,
      curvesShown: page.element('detail').offsetWidth > 0,
      templateShown: page.element('template').offsetWidth > 0,
      levellingShown: page.element('loudness').offsetWidth > 0,
    };
    const template = page.element<HTMLSelectElement>('template');
    const options = [...template.options].map((option) => option.value);
    template.value = 'ring';
    template.dispatchEvent(new Event('change'));
    await page.wait(100);
    page.type('mix-artist', 'Suva');
    await page.settle();
    await page.wait(300);
    const pixels = picture.getContext('2d')!.getImageData(0, 0, picture.width, picture.height).data;
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4 * 97) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 60) lit++;
    page.click('view-mastering');
    return { mastering, video, options, lit, back: page.element('detail').offsetWidth > 0 };
  });
  assert.deepEqual(first.mastering, { pictureShown: false, curvesShown: true });
  assert.deepEqual(first.video, { pictureShown: true, curvesShown: false, templateShown: true, levellingShown: false });
  assert.deepEqual(first.options, ['glitter', 'ring', 'waveform', 'photo', 'original']);
  assert.ok(first.lit > 50, 'the picture is not blank');
  assert.ok(first.back, 'the bar at the bottom switches back');

  const again = await runApp({ recording: mix, data, timeoutMs: 90_000 }, (page) => {
    page.click('view-video');
    return {
      template: page.element<HTMLSelectElement>('template').value,
      fields: [...page.element('video-fields').querySelectorAll('label')].map((label) => label.textContent),
    };
  });
  assert.deepEqual(again, { template: 'ring', fields: ['Colour', 'Font', 'Logo'] }, 'kept with the mix and back on the next start');
});

test('while the music is listened to, the picture says so, and the count goes on in the Mastering view', { skip }, async () => {
  const file = join(work, 'Said.djmtemplate');
  await writeFile(file, JSON.stringify({ format: 1, name: 'Said', fields: [], layers: [{ type: 'solid', params: {} }] }));
  const seen = await runApp({ recording: mix, data: await fresh(), template: file, timeoutMs: 90_000 }, async (page) => {
    const notice = page.element('picture-notice');
    page.click('view-video');
    const shown = !notice.hidden && notice.offsetWidth > 0 ? notice.textContent : null;
    // In the Video view the count is over the picture: what else the status line says stays there meanwhile.
    page.click('template-import');
    await page.until(() => page.text('readout') === 'Added Said.', 'the template to be added');
    await page.wait(700);
    const kept = notice.hidden ? 'done too soon to tell' : page.text('readout');
    page.click('view-mastering');
    const counts: string[] = [];
    new MutationObserver(() => counts.push(page.text('readout'))).observe(page.element('readout'), { childList: true, characterData: true, subtree: true });
    await page.until(() => notice.hidden, 'the listening to be done');
    return { shown, kept, counted: counts.filter((text) => /Listening .*\d+%/.test(text)).length, last: page.text('readout').trim() };
  });
  assert.match(seen.shown ?? '', /Listening to the recording for the video/);
  assert.equal(seen.kept, 'Added Said.', 'the count over the picture leaves the status line alone');
  assert.ok(seen.counted > 0, 'the count went on after switching views');
  assert.equal(seen.last, '');
});

test('the Photo template fills the picture with a chosen photo', { skip }, async () => {
  const photo = join(work, 'Photo.png');
  // Bright red, so that it is told apart from any background a template draws.
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff2020:s=640x400', '-frames:v', '1', photo]);
  const seen = await runApp({ recording: mix, data: await fresh(), image: photo, timeoutMs: 90_000 }, async (page) => {
    page.click('view-video');
    const template = page.element<HTMLSelectElement>('template');
    template.value = 'photo';
    template.dispatchEvent(new Event('change'));
    await page.wait(100);
    const fields = [...page.element('video-fields').querySelectorAll('label')].map((label) => label.textContent);
    [...page.element('video-fields').querySelectorAll('button')].find((button) => button.textContent === 'Choose…')!.click();
    const picture = page.element<HTMLCanvasElement>('picture');
    const middle = () => [...picture.getContext('2d')!.getImageData(picture.width / 2, picture.height / 2, 1, 1).data];
    await page.until(() => middle()[0] > 150 && middle()[1] < 80, 'the photo to be drawn');
    return { fields, middle: middle() };
  });
  assert.deepEqual(seen.fields, ['Photo', 'Colour', 'Font']);
  assert.ok(seen.middle[0] > 150, `the middle of the picture is ${seen.middle}`);
});

test('the picture fades in from black with the mix', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh(), timeoutMs: 90_000 }, async (page) => {
    // Drag the fade-in handle, in the top left corner of the mix, a quarter of the way in.
    const detail = page.element('detail');
    const box = detail.getBoundingClientRect();
    const gutter = 48;
    const at = (share: number) => box.left + gutter + share * (box.width - gutter);
    detail.dispatchEvent(new MouseEvent('mousedown', { clientX: box.left + gutter + 5, clientY: box.top + 28, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: at(0.1), clientY: box.top + 28, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: at(0.25), clientY: box.top + 28, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const fade = page.text('readout');

    page.click('view-video');
    const strip = page.element<HTMLCanvasElement>('mix-strip');
    const picture = page.element<HTMLCanvasElement>('picture');
    const brightness = async (share: number) => {
      const s = strip.getBoundingClientRect();
      strip.dispatchEvent(new MouseEvent('mousedown', { clientX: s.left + share * s.width, clientY: s.top + 10, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await page.wait(300);
      const pixels = picture.getContext('2d')!.getImageData(0, 0, picture.width, picture.height).data;
      let sum = 0;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4 * 101) {
        sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
        count++;
      }
      return sum / count;
    };
    return { fade, start: await brightness(0), halfway: await brightness(0.125), middle: await brightness(0.5) };
  });
  assert.match(seen.fade, /^Fade in \d+\.\d s/);
  assert.ok(seen.start < 1, `black at the start: ${seen.start}`);
  assert.ok(seen.halfway > seen.start && seen.halfway < seen.middle * 0.8, `dimmer halfway through the fade: ${JSON.stringify(seen)}`);
});

test('tracks are marked with M, named, moved and removed on the mix, undone, and kept', { skip }, async () => {
  const data = await fresh();
  const seen = await runApp({ recording: mix, data, timeoutMs: 60_000 }, async (page) => {
    const detail = page.element('detail');
    const tracks = () => JSON.parse(detail.dataset.tracks ?? '[]') as [number, string, boolean][];
    page.key('Enter');
    for (let i = 0; i < 6; i++) page.key('ArrowRight');
    page.key('KeyM');
    for (let i = 0; i < 6; i++) page.key('ArrowRight');
    page.key('KeyM');
    await page.wait(200);
    const marked = { tracks: tracks(), button: page.text('tracks-button') };

    // The second marker's name tab, at the foot of the waveform lane, with the whole mix in view.
    const box = detail.getBoundingClientRect();
    const length = Number(page.element('play-time').dataset.length!.split(':').reduce((sum, part) => sum * 60 + Number(part), 0));
    const x = box.left + 48 + (60 / length) * (box.width - 48) + 6;
    const y = box.top + Math.round((box.height - 18) * 0.38) - 8;
    detail.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true }));
    const field = page.element<HTMLInputElement>('track-name-edit');
    field.value = 'Six Ou Sept - Big Brother is Raving You';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await page.wait(100);
    const named = tracks()[1][1];

    // Dragged 30 seconds later.
    detail.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + 20, clientY: y, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + (30 / length) * (box.width - 48), clientY: y, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    detail.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
    await page.settle();
    const moved = tracks()[1][0];

    // The marker last clicked goes with Backspace, and comes back with undo.
    page.key('Backspace');
    await page.settle();
    const removed = tracks().length;
    page.click('undo');
    await page.wait(200);
    const back = tracks().length;
    const mixes = page.tabs().length;
    await page.settle();
    return { marked, named, moved, removed, back, mixes };
  });
  assert.deepEqual(seen.marked, { tracks: [[30, '', false], [60, '', false]], button: '2 tracks' });
  assert.equal(seen.named, 'Six Ou Sept - Big Brother is Raving You');
  assert.ok(Math.abs(seen.moved - 90) < 1, `moved to ${seen.moved}`);
  assert.equal(seen.removed, 1, 'Backspace removed the track, not the mix');
  assert.equal(seen.back, 2);
  assert.equal(seen.mixes, 1);

  const again = await runApp({ recording: mix, data }, (page) => page.element('detail').dataset.tracks);
  assert.equal(again, JSON.stringify([[30, '', false], [seen.moved, 'Six Ou Sept - Big Brother is Raving You', false]]), 'kept for the next time');
});

test('a track list from DJ software is spread over the mix, to be dragged into place', { skip }, async () => {
  // As Rekordbox writes its history as text: UTF-16 with a byte-order mark, a column per field.
  const list = join(work, 'History.txt');
  const rows = ['#\tArtwork\tArtist\tTrack Title\tBPM', '1\t\tSix Ou Sept\tBig Brother is Raving You\t170.00', '2\t\tChôKô\tPower Portal\t170.00', '3\t\tEnko\tVariscan\t155.00'];
  await writeFile(list, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rows.join('\r\n'), 'utf16le')]));
  const seen = await runApp({ recording: mix, data: await fresh(), tracklist: list }, async (page) => {
    page.click('tracks-button');
    page.click('tracks-import');
    await page.until(() => page.text('tracks-status') !== '', 'the list to be read');
    const names = [...document.querySelectorAll<HTMLInputElement>('.track-name')].map((input) => input.value);
    const times = [...document.querySelectorAll<HTMLInputElement>('.track-time')].map((input) => input.value);
    page.click('tracks-close');
    await page.wait(100);
    return { names, times, status: page.text('tracks-status'), button: page.text('tracks-button'), drawn: page.element('detail').dataset.tracks };
  });
  const third = MIX_SECONDS / 3;
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  assert.deepEqual(seen.names, ['Six Ou Sept - Big Brother is Raving You', 'ChôKô - Power Portal', 'Enko - Variscan']);
  assert.deepEqual(seen.times, ['0:00', clock(third), clock(2 * third)]);
  assert.match(seen.status, /^3 tracks read\. .*spread evenly/);
  assert.equal(seen.button, '3 tracks');
  assert.ok(JSON.parse(seen.drawn!).every((track: [number, string, boolean]) => track[2]), 'all marked as guesses');
});

test('a template of your own: duplicated, renamed, kept, shared and deleted', { skip }, async () => {
  const data = await fresh();
  const shared = join(work, 'shared templates');
  await mkdir(shared);
  const first = await runApp({ recording: mix, data, exportFolder: shared, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    await page.wait(300);
    page.click('template-duplicate');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.value.startsWith('user:'), 'the copy to be chosen');
    const groups = [...select.querySelectorAll('optgroup')].map((group) => [group.label, [...group.querySelectorAll('option')].map((o) => o.text)]);
    // Renamed in the editor, where all of a template's making is; not in the panel.
    const nameHidden = page.element('template-name-row').hidden;
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const name = page.element<HTMLInputElement>('template-name');
    name.value = 'My glitter';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    name.dispatchEvent(new Event('change', { bubbles: true }));
    await page.wait(600);
    page.click('editor-done');
    const shownName = document.querySelector('#template-about .about-name')!.textContent;
    page.click('template-export');
    await page.wait(500);
    return { groups, chosen: select.selectedOptions[0].text, deletable: !page.element<HTMLButtonElement>('template-delete').disabled, nameHidden, shownName };
  });
  assert.ok(first.nameHidden, 'no name field outside the editor');
  assert.equal(first.shownName, 'My glitter', 'the name shown under the list');
  assert.deepEqual(first.groups, [['Comes with the app', ['Glitter', 'Spectrum ring', 'Waveform', 'Photo', 'Original video']], ['Yours', ['Glitter copy']]]);
  assert.equal(first.chosen, 'My glitter');
  assert.ok(first.deletable);
  const stored = await readdir(join(data, 'templates'));
  assert.equal(stored.length, 1);
  assert.equal(JSON.parse(readFileSync(join(data, 'templates', stored[0]), 'utf8')).name, 'My glitter');
  assert.equal((await sharedTemplate(join(shared, 'My glitter.djmtemplate'))).name, 'My glitter');

  // Kept with the mix, and gone with Delete.
  const second = await runApp({ recording: mix, data }, async (page) => {
    page.click('view-video');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'My glitter', 'the template to come back');
    page.click('template-delete');
    await page.until(() => select.value === 'glitter', 'the mix to go back to the first template');
    return [...select.querySelectorAll('optgroup')].length;
  });
  assert.equal(second, 1);
  assert.deepEqual(await readdir(join(data, 'templates')), []);
});

test('a template from a file brings the pictures packed into it', { skip }, async () => {
  const red = join(work, 'red.png');
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff2020:s=64x64', '-frames:v', '1', red]);
  const file = join(work, 'Red wall.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1,
    name: 'Red wall',
    fields: [],
    layers: [{ type: 'image', params: { image: 'asset:wall', fit: 'stretch', width: 100, height: 100 } }],
    assets: { wall: `data:image/png;base64,${readFileSync(red).toString('base64')}` },
  }));
  const seen = await runApp({ recording: mix, data: await fresh(), template: file }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Red wall', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    const middle = () => [...picture.getContext('2d')!.getImageData(picture.width / 2, picture.height / 2, 1, 1).data];
    await page.until(() => middle()[0] > 200 && middle()[1] < 80, 'the packed picture to be drawn');
    return { middle: middle(), said: page.text('readout') };
  });
  assert.ok(seen.middle[0] > 200);
  assert.equal(seen.said, 'Added Red wall.');
});

test('the template editor: layers shown and hidden, added, reordered, renamed, deleted and undone', { skip }, async () => {
  const data = await fresh();
  const seen = await runApp({ recording: mix, data, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    await page.wait(100);
    const panel = page.element('settings');
    const narrow = panel.offsetWidth;
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const names = () => [...document.querySelectorAll('.layer-row .layer-name')].map((name) => name.textContent);
    const row = (name: string) => [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === name)!;
    const opened = { copy: page.element<HTMLSelectElement>('template').value.startsWith('user:'), wider: panel.offsetWidth > narrow, layers: names() };

    // Hide the ring, add a text in front of the selected (top) layer.
    row('Ring').querySelector<HTMLButtonElement>('.layer-eye')!.click();
    page.click('editor-add');
    document.querySelector<HTMLButtonElement>('#editor-add-menu button[data-type="text"]')!.click();
    await page.wait(50);
    const added = names()[0];

    // Drag the background from the bottom to the top.
    const from = row('Background').getBoundingClientRect();
    const to = row(names()[0]!).getBoundingClientRect();
    row('Background').dispatchEvent(new MouseEvent('mousedown', { clientX: from.left + 40, clientY: from.top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: from.left + 40, clientY: from.top - 20, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: from.left + 40, clientY: to.top + 2, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await page.wait(50);
    const dragged = names()[0];

    // Rename the logo, then delete it with Backspace, which must not delete the mix.
    row('Logo').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const field = document.querySelector<HTMLInputElement>('.layer-rename')!;
    field.value = 'Badge';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await page.wait(50);
    const renamed = names().includes('Badge');
    const badge = row('Badge');
    badge.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: badge.getBoundingClientRect().top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    badge.focus();
    badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true }));
    await page.wait(50);
    const deleted = !names().includes('Badge');
    const mixes = page.tabs().length;

    // Undo brings the layer back; the undo button works on the template while editing.
    page.click('undo');
    await page.wait(50);
    const undone = names().includes('Badge');
    await page.wait(600);
    page.click('editor-done');
    return { opened, added, dragged, renamed, deleted, mixes, undone, closed: !document.body.classList.contains('editing'), narrowAgain: panel.offsetWidth === narrow };
  });
  assert.deepEqual(seen.opened, { copy: true, wider: true, layers: ['Glow', 'Now playing', 'Mix and time', 'Artist', 'Logo', 'Ring', 'Background'] });
  assert.equal(seen.added, 'Text');
  assert.equal(seen.dragged, 'Background');
  assert.ok(seen.renamed && seen.deleted && seen.undone);
  assert.equal(seen.mixes, 1, 'Backspace on a layer leaves the mix alone');
  assert.ok(seen.closed && seen.narrowAgain);

  const [file] = await readdir(join(data, 'templates'));
  const saved = JSON.parse(readFileSync(join(data, 'templates', file), 'utf8'));
  assert.deepEqual(saved.layers.map((layer: { name?: string; type: string }) => layer.name ?? layer.type).reverse(),
    ['Background', 'text', 'glow', 'Now playing', 'Mix and time', 'Artist', 'Badge', 'Ring']);
  assert.equal(saved.layers.find((layer: { name?: string }) => layer.name === 'Ring').params.visible, false);
});

test('a layer\'s settings in the editor: numbers, colours, packed pictures and expressions, checked as typed', { skip }, async () => {
  const data = await fresh();
  const red = join(work, 'Red dot.png');
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff2020:s=32x32', '-frames:v', '1', red]);
  const seen = await runApp({ recording: mix, data, image: red, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const select = (name: string) => {
      const row = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === name)!;
      row.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: row.getBoundingClientRect().top + 5, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };
    const setting = (key: string) => document.querySelector<HTMLElement>(`#editor-layer .setting[data-key="${key}"]`)!;
    const type = (input: HTMLInputElement, value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    select('Ring');
    const title = document.querySelector('#editor-layer .editor-section')!.textContent;
    type(setting('bars').querySelector<HTMLInputElement>('input[type="number"]')!, '60');
    await page.wait(1100);
    await page.wait(1100);

    // An expression: wrong, then right.
    setting('radius').querySelector<HTMLButtonElement>('.fx')!.click();
    const expression = () => setting('radius').querySelector<HTMLInputElement>('.expr-input')!;
    type(expression(), '20 + 0 * bas');
    await page.wait(200);
    const wrong = { problem: setting('radius').querySelector('.setting-problem')!.textContent, marked: setting('radius').querySelector('mark')?.textContent, live: setting('radius').querySelector('.live')!.textContent };
    type(expression(), '20 + 0 * bass');
    await page.wait(300);
    const right = { problem: setting('radius').querySelector('.setting-problem')!.textContent, live: setting('radius').querySelector('.live')!.textContent };
    await page.wait(1100);

    select('Artist');
    type(setting('colour').querySelector<HTMLInputElement>('input[type="color"]')!, '#ff0000');
    await page.wait(1100);
    // A colour as an expression, and back: plain #ff0000 is an expression too, so the button decides.
    setting('colour').querySelector<HTMLButtonElement>('.fx')!.click();
    const colourExpression = setting('colour').querySelector<HTMLInputElement>('.expr-input')?.value;
    type(setting('colour').querySelector<HTMLInputElement>('.expr-input')!, 'mix(#ff0000, #0000ff, 0)');
    await page.wait(300);
    const colourLive = setting('colour').querySelector('.live .swatch') !== null;
    setting('colour').querySelector<HTMLButtonElement>('.fx')!.click();
    const colourBack = setting('colour').querySelector<HTMLInputElement>('input[type="color"]')?.value;
    await page.wait(1100);

    // A picture, packed into the template.
    select('Logo');
    const image = setting('image').querySelector<HTMLSelectElement>('select')!;
    image.value = '+';
    image.dispatchEvent(new Event('change', { bubbles: true }));
    await page.until(() => setting('image').querySelector<HTMLSelectElement>('select')?.value === 'asset:Red dot', 'the picture to be packed');
    await page.wait(1100);

    // Undo takes back the picture, and the template is saved as it then is.
    page.click('undo');
    await page.wait(100);
    const afterUndo = setting('image').querySelector<HTMLSelectElement>('select')!.value;
    page.click('redo');
    await page.wait(100);
    // Left half typed, to be found again next time.
    select('Ring');
    type(setting('radius').querySelector<HTMLInputElement>('.expr-input')!, '20 + 0 * (bass');
    await page.wait(700);
    return { title, wrong, right, afterUndo, colourExpression, colourLive, colourBack };
  });
  assert.equal(seen.title, 'Ring');
  assert.deepEqual([seen.colourExpression, seen.colourLive, seen.colourBack], ['#ff0000', true, '#ff0000']);
  assert.deepEqual(seen.wrong, { problem: 'Unknown name bas; did you mean bass?', marked: 'bas', live: '' });
  assert.deepEqual(seen.right, { problem: '', live: '= 20.0' });
  assert.equal(seen.afterUndo, '%logo%');

  const [file] = await readdir(join(data, 'templates'));
  const saved = JSON.parse(readFileSync(join(data, 'templates', file), 'utf8'));
  const ring = saved.layers.find((layer: { name?: string }) => layer.name === 'Ring').params;
  assert.equal(ring.bars, 60);
  assert.equal(saved.layers.find((layer: { name?: string }) => layer.name === 'Artist').params.colour, '#ff0000');
  assert.equal(ring.radius, '20 + 0 * (bass');
  assert.equal(saved.layers.find((layer: { name?: string }) => layer.name === 'Logo').params.image, 'asset:Red dot');
  assert.match(saved.assets['Red dot'], /^data:image\/png;base64,/);

  const again = await runApp({ recording: mix, data }, async (page) => {
    page.click('view-video');
    await page.until(() => page.element<HTMLSelectElement>('template').value.startsWith('user:'), 'the template to come back');
    page.click('template-edit');
    const row = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === 'Ring')!;
    row.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: row.getBoundingClientRect().top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const radius = document.querySelector<HTMLElement>('#editor-layer .setting[data-key="radius"]')!;
    return { typed: radius.querySelector<HTMLInputElement>('.expr-input')?.value, problem: radius.querySelector('.setting-problem')!.textContent };
  });
  assert.deepEqual(again, { typed: '20 + 0 * (bass', problem: 'Expected a closing ")"' });
});

test('a template\'s fields in the editor: renamed everywhere, added, changed, dragged into another order and removed with Delete', { skip }, async () => {
  const data = await fresh();
  const seen = await runApp({ recording: mix, data, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    await page.wait(200);
    // What the mix filled in, under the field's old name.
    const colour = page.element<HTMLInputElement>('field-colour1');
    colour.value = '#ff0000';
    colour.dispatchEvent(new Event('input', { bubbles: true }));
    await page.settle();
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    page.click('editor-tab-fields');
    const cardOf = (key: string) => document.querySelector<HTMLElement>(`.field-card[data-key="${key}"]`)!;
    const type = (input: HTMLInputElement, value: string, commit = false) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (commit) input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // A name that is taken is refused, with a word why.
    type(cardOf('colour1').querySelector<HTMLInputElement>('.field-key')!, 'bass');
    const refused = cardOf('colour1').querySelector('.setting-problem')!.textContent;
    type(cardOf('colour1').querySelector<HTMLInputElement>('.field-key')!, 'bass', true);
    const kept = !!cardOf('colour1');
    type(cardOf('colour1').querySelector<HTMLInputElement>('.field-key')!, 'accent', true);
    await page.wait(50);
    const usage = cardOf('accent').querySelector('.field-usage')!.textContent;

    // A text field, with its label and default.
    page.choose('editor-add-field', 'text');
    await page.wait(50);
    type(cardOf('text1').querySelector<HTMLInputElement>('.field-label')!, 'Tagline');
    type(cardOf('text1').querySelector<HTMLInputElement>('.field-default input')!, 'Live at the club');
    await page.wait(1100);

    // Sparkle becomes a colour; the logo moves to the end; the font goes.
    const kind = cardOf('sparkle').querySelector<HTMLSelectElement>('.field-kind')!;
    kind.value = 'colour';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    // Dragged by the card into the lower half of the sparkle's, the one after it, so below that.
    const logo = cardOf('logo').getBoundingClientRect();
    const below = cardOf('sparkle').getBoundingClientRect().bottom - 4;
    cardOf('logo').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: logo.left + 4, clientY: logo.top + 4 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: logo.left + 4, clientY: below }));
    const marked = cardOf('text1').classList.contains('drop-above');
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: logo.left + 4, clientY: below }));
    // The moved card has the keys.
    await page.wait(50);
    const focused = (document.activeElement as HTMLElement).dataset.key;
    // Clicked, the font's card has the keys, and Delete removes it rather than a layer.
    const layers = document.querySelectorAll('.layer-row').length;
    cardOf('font').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true }));
    const order = [...document.querySelectorAll<HTMLElement>('.field-card')].map((card) => card.dataset.key);
    const layersLeft = document.querySelectorAll('.layer-row').length;
    await page.wait(600);
    page.click('editor-done');
    await page.wait(100);
    const panel = [...page.element('video-fields').querySelectorAll('label')].map((label) => label.textContent);
    return { refused, kept, usage, order, marked, focused, layers, layersLeft, panel, accent: page.element<HTMLInputElement>('field-accent').value };
  });
  assert.equal(seen.refused, 'The name bass is already taken');
  assert.ok(seen.kept);
  assert.equal(seen.usage, 'in expressions: accent');
  assert.deepEqual(seen.order, ['accent', 'sparkle', 'logo', 'text1']);
  assert.ok(seen.marked, 'a line showed where the card would go');
  assert.equal(seen.focused, 'logo');
  assert.equal(seen.layersLeft, seen.layers, 'Delete on a card left the layers alone');
  assert.deepEqual(seen.panel, ['Colour', 'Sparkle', 'Logo', 'Tagline']);
  assert.equal(seen.accent, '#ff0000', 'what the mix filled in went with the new name');

  const [file] = await readdir(join(data, 'templates'));
  const saved = JSON.parse(readFileSync(join(data, 'templates', file), 'utf8'));
  assert.deepEqual(saved.fields.map((field: { key: string; kind: string }) => `${field.key}:${field.kind}`), ['accent:colour', 'sparkle:colour', 'logo:image', 'text1:text']);
  assert.equal(saved.fields[3].default, 'Live at the club');
  assert.equal(saved.fields[1].default, '#3ddc97');
  const background = saved.layers.find((layer: { name?: string }) => layer.name === 'Background').params;
  assert.match(background.colour1, /^darken\(accent, /);
});

test('"Moves with…" makes a setting follow the music, and is read back from what it wrote', { skip }, async () => {
  const data = await fresh();
  const seen = await runApp({ recording: mix, data, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const select = (name: string) => {
      const row = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === name)!;
      row.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: row.getBoundingClientRect().top + 5, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };
    const radius = () => document.querySelector<HTMLElement>('#editor-layer .setting[data-key="radius"]')!;
    const expression = () => radius().querySelector<HTMLInputElement>('.expr-input')?.value;

    select('Ring');
    radius().querySelector<HTMLButtonElement>('.motion-button')!.click();
    const opened = expression();
    const source = radius().querySelector<HTMLSelectElement>('.motion select')!;
    source.value = 'wave';
    source.dispatchEvent(new Event('change', { bubbles: true }));
    const seconds = radius().querySelector<HTMLInputElement>('.motion-line:not([hidden]) input[type="number"][min]')!;
    seconds.value = '4';
    seconds.dispatchEvent(new Event('input', { bubbles: true }));
    const amount = radius().querySelector<HTMLInputElement>('.motion input[type="range"]')!;
    amount.value = '3';
    amount.dispatchEvent(new Event('input', { bubbles: true }));
    const waving = expression();
    await page.wait(1100);

    // Away and back: the panel reads its choice back from the expression.
    select('Logo');
    select('Ring');
    radius().querySelector<HTMLButtonElement>('.motion-button')!.click();
    const readBack = [radius().querySelector<HTMLSelectElement>('.motion select')!.value, radius().querySelector<HTMLInputElement>('.motion input[type="range"]')!.value];


    // Stop moving, then undo.
    [...radius().querySelectorAll<HTMLButtonElement>('.motion button')].find((b) => b.textContent === 'Stop moving')!.click();
    const stopped = radius().querySelector<HTMLInputElement>('input[type="number"]')?.value;
    await page.wait(1100);
    page.click('undo');
    await page.wait(100);
    const undone = expression();
    await page.wait(600);

    // A formula typed with the panel open: shown in it while it is one the panel could have written; closed when not.
    const typeIn = (text: string) => {
      const input = radius().querySelector<HTMLInputElement>('.expr-input')!;
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    if (radius().querySelector<HTMLElement>('.motion')!.hidden) radius().querySelector<HTMLButtonElement>('.motion-button')!.click();
    typeIn('20 + 5 * smooth(bass, 0.05, 0.5)');
    const typed = [radius().querySelector<HTMLSelectElement>('.motion select')!.value, radius().querySelector<HTMLInputElement>('.motion input[type="range"]')!.value];
    typeIn('20 + bass');
    const closedByTyping = radius().querySelector<HTMLElement>('.motion')!.hidden;
    return { opened, waving, readBack, typed, closedByTyping, stopped, undone };
  });
  assert.deepEqual(seen.typed, ['bass', '5'], 'the open panel follows a formula typed');
  assert.ok(seen.closedByTyping, 'and closes for one it could not have written');
  assert.equal(seen.opened, '17 + 5 * smooth(bass, 0.05, 0.5)');
  assert.equal(seen.waving, '17 + 3 * sine(time / 4)');
  assert.deepEqual(seen.readBack, ['wave', '3']);
  assert.equal(seen.stopped, '17');
  assert.equal(seen.undone, '17 + 3 * sine(time / 4)');
});

test('layers are picked, moved and resized on the picture, each drag one undo step', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh(), timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'waveform');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    await page.wait(200);
    const overlay = page.element('picture-overlay');
    const picture = page.element('picture').getBoundingClientRect();
    const selected = () => document.querySelector('.layer-row.on .layer-name')!.textContent;
    const value = (key: string) => Number(document.querySelector<HTMLInputElement>(`#editor-layer .setting[data-key="${key}"] input[type="number"]`)!.value.replace(',', '.'));
    const drag = (target: Element, x: number, y: number, dx: number, dy: number, shiftKey = false) => {
      target.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + dx / 4, clientY: y + dy / 4, shiftKey }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + dx, clientY: y + dy, shiftKey }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };

    // A click low in the picture picks the spectrum there; dragged up a tenth of the picture.
    drag(overlay, picture.left + picture.width / 2, picture.top + picture.height * 0.92, 0, 0);
    const picked = selected();
    const outline = document.querySelector<HTMLElement>('.layer-outline')!;
    const box = outline.getBoundingClientRect();
    drag(outline, box.left + box.width / 2, box.top + box.height / 2, 0, -picture.height / 10);
    await page.wait(100);
    const moved = value('y');

    // Its top left corner, out with Shift: width and height grow alike.
    const corner = document.querySelector<HTMLElement>('.layer-outline .corner.nw')!.getBoundingClientRect();
    drag(document.querySelector('.layer-outline .corner.nw')!, corner.left + 4, corner.top + 4, -40, -20, true);
    await page.wait(100);
    const grown = { width: value('width'), height: value('height') };

    // Each drag undoes in one step.
    await page.wait(1100);
    page.click('undo');
    await page.wait(100);
    const firstUndo = { width: value('width'), y: value('y') };
    page.click('undo');
    await page.wait(100);
    const secondUndo = value('y');

    // A layer whose size follows an expression is not resized by dragging, and says so.
    const row = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === 'Wave')!;
    row.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: row.getBoundingClientRect().top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await page.wait(100);
    const waveCorner = document.querySelector<HTMLElement>('.layer-outline .corner.se')!;
    const wc = waveCorner.getBoundingClientRect();
    drag(waveCorner, wc.left + 4, wc.top + 4, -30, 0);
    return { picked, moved, grown, firstUndo, secondUndo, said: page.text('readout') };
  });
  assert.equal(seen.picked, 'Bars');
  assert.ok(Math.abs(seen.moved - 86) < 1, `moved to ${seen.moved}`);
  assert.ok(seen.grown.width > 92 && seen.grown.height > 10, JSON.stringify(seen.grown));
  assert.ok(Math.abs(seen.grown.width / 92 - seen.grown.height / 10) < 0.05, 'grown alike');
  assert.deepEqual([seen.firstUndo.width, Math.round(seen.firstUndo.y)], [92, 86]);
  assert.equal(seen.secondUndo, 96);
  assert.match(seen.said, /^Wave: its height follows an expression, so it is set in its settings, not by dragging\.$/);
});

test('a picture packed into a template stays on screen while its layer is dragged', { skip }, async () => {
  const red = join(work, 'Red square.png');
  // As large as a photo: it takes a while to decode, as photos do.
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff2020:s=4000x3000', '-frames:v', '1', red]);
  const seen = await runApp({ recording: mix, data: await fresh(), image: red, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const row = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === 'Logo')!;
    row.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: row.getBoundingClientRect().top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const image = document.querySelector<HTMLSelectElement>('#editor-layer .setting[data-key="image"] select')!;
    image.value = '+';
    image.dispatchEvent(new Event('change', { bubbles: true }));
    const picture = page.element<HTMLCanvasElement>('picture');
    const outline = document.querySelector<HTMLElement>('.layer-outline')!;
    // The colour in the middle of the selected layer, as drawn.
    const middle = () => {
      const box = outline.getBoundingClientRect();
      const rect = picture.getBoundingClientRect();
      const k = picture.width / rect.width;
      return [...picture.getContext('2d')!.getImageData((box.left + box.width / 2 - rect.left) * k, (box.top + box.height / 2 - rect.top) * k, 1, 1).data];
    };
    const isRed = (pixel: number[]) => pixel[0] > 180 && pixel[1] < 90;
    await page.until(() => !outline.hidden && isRed(middle()), 'the packed picture to be drawn');

    // Dragged across the picture in small steps, a frame for each, looking at every frame.
    let frames = 0;
    let missing = 0;
    const box = outline.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    outline.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true }));
    for (let step = 1; step <= 40; step++) {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + step * 3, clientY: y + step }));
      await new Promise((done) => requestAnimationFrame(done));
      frames++;
      if (!isRed(middle())) missing++;
    }
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return { frames, missing };
  });
  assert.equal(seen.frames, 40);
  assert.equal(seen.missing, 0, 'the picture was missing from some frames');
});

test('Delete removes the selected layer while editing, however it was selected, and then the next', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh(), timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    await page.wait(200);
    const names = () => [...document.querySelectorAll('.layer-row .layer-name')].map((name) => name.textContent);
    // Pressed as a keyboard would: on whatever has the keys.
    const press = (code: string) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));

    // Selected on the picture: the ring round its middle.
    const picture = page.element('picture').getBoundingClientRect();
    const overlay = page.element('picture-overlay');
    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: picture.left + picture.width / 2, clientY: picture.top + picture.height * 0.44, button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const picked = document.querySelector('.layer-row.on .layer-name')!.textContent;
    const before = names();
    press('Delete');
    const first = names();
    const next = document.querySelector('.layer-row.on .layer-name')!.textContent;
    press('Backspace');
    const second = names();
    // With nothing focused at all, it still goes to the layer, not the mix.
    (document.activeElement as HTMLElement | null)?.blur();
    press('Backspace');
    const third = names();
    return { picked, before, first, next, second, third, mixes: page.tabs().length };
  });
  assert.equal(seen.picked, 'Ring');
  assert.deepEqual(seen.first, seen.before.filter((name) => name !== 'Ring'));
  assert.equal(seen.next, 'Logo');
  assert.deepEqual(seen.second, seen.first.filter((name) => name !== 'Logo'));
  assert.equal(seen.third.length, seen.second.length - 1);
  assert.equal(seen.mixes, 1, 'the mix is never deleted while editing');
});

test('effects change the picture beneath them: a colour split, shown and hidden', { skip }, async () => {
  const file = join(work, 'Split.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1,
    name: 'Split',
    fields: [],
    layers: [
      { type: 'gradient', params: { colour1: '#202020', colour2: '#202020' } },
      { type: 'text', params: { text: 'SPLIT', size: 20, weight: 900, colour: '#ffffff' } },
      { type: 'split', name: 'Split', params: { amount: 1, angle: 0 } },
    ],
  }));
  const seen = await runApp({ recording: mix, data: await fresh(), template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Split', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    // Pixels of red alone: the fringe a split leaves beside white letters, and nowhere else.
    const red = () => {
      const pixels = picture.getContext('2d')!.getImageData(0, 0, picture.width, picture.height).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 200 && pixels[i + 1] < 80 && pixels[i + 2] < 80) count++;
      return count;
    };
    await page.wait(500);
    const split = red();
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    page.click('editor-add');
    const offered = [...document.querySelectorAll('#editor-add-menu button')].map((button) => button.textContent);
    page.click('editor-add');
    [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === 'Split')!
      .querySelector<HTMLButtonElement>('.layer-eye')!.click();
    await page.wait(300);
    return { split, hidden: red(), offered };
  });
  assert.ok(seen.split > 500, `${seen.split} red pixels with the split`);
  assert.equal(seen.hidden, 0, 'none without it');
  for (const effect of ['Colour split', 'Glitch', 'Brightness and contrast', 'Hue and saturation', 'Blur']) assert.ok(seen.offered.includes(effect), effect);
});

test('a blur reaches the edges of the picture as it does the middle', { skip }, async () => {
  // A fine black and white checkerboard over the whole picture: grey once blurred.
  const stripes = join(work, 'Checks.png');
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', "color=black:s=480x270,geq=lum='255*mod(X+Y,2)':cb=128:cr=128", '-frames:v', '1', stripes]);
  const file = join(work, 'Blurred.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1,
    name: 'Blurred',
    fields: [],
    layers: [
      { type: 'image', params: { image: 'asset:stripes', fit: 'stretch', width: 100, height: 100 } },
      { type: 'blur', params: { radius: 2 } },
    ],
    assets: { stripes: `data:image/png;base64,${readFileSync(stripes).toString('base64')}` },
  }));
  const seen = await runApp({ recording: mix, data: await fresh(), template: file }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    await page.until(() => page.element<HTMLSelectElement>('template').selectedOptions[0]?.text === 'Blurred', 'the template to be added');
    await page.wait(600);
    const picture = page.element<HTMLCanvasElement>('picture');
    const { width, height } = picture;
    const pixels = picture.getContext('2d')!.getImageData(0, 0, width, height).data;
    const light = (x: number, y: number) => pixels[(y * width + x) * 4];
    // How far the brightness swings along a line: little once blurred.
    const swing = (points: [number, number][]) => {
      const values = points.map(([x, y]) => light(x, y));
      return Math.max(...values) - Math.min(...values);
    };
    const across = (y: number) => swing(Array.from({ length: 200 }, (_, i) => [Math.floor(width * (0.2 + 0.6 * (i / 200))), y]));
    const down = (x: number) => swing(Array.from({ length: 200 }, (_, i) => [x, Math.floor(height * (0.2 + 0.6 * (i / 200)))]));
    return { top: across(0), middleRow: across(Math.floor(height / 2)), left: down(0), middleColumn: down(Math.floor(width / 2)) };
  });
  assert.ok(seen.middleRow < 60, `the middle is blurred: ${JSON.stringify(seen)}`);
  assert.ok(seen.top <= seen.middleRow + 25, `the top edge as much as the middle: ${JSON.stringify(seen)}`);
  assert.ok(seen.left <= seen.middleColumn + 25, `the left edge as much as the middle: ${JSON.stringify(seen)}`);
});

test('a kaleidoscope mirrors a slice all the way round, and fills the corners from any centre', { skip }, async () => {
  const file = join(work, 'Kaleidoscope.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1,
    name: 'Kaleidoscope',
    fields: [],
    layers: [
      { type: 'gradient', params: { kind: 'linear', angle: 20, colour1: '#ff5a3d', colour2: '#3ddc97' } },
      { type: 'text', params: { text: 'ONE SIDE', size: 12, weight: 900, colour: '#ffffff', x: 72, y: 35 } },
      { type: 'kaleidoscope', name: 'Kaleidoscope', params: { segments: 2, angle: 0, mirrored: true } },
    ],
  }));
  const seen = await runApp({ recording: mix, data: await fresh(), template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    await page.until(() => page.element<HTMLSelectElement>('template').selectedOptions[0]?.text === 'Kaleidoscope', 'the template to be added');
    await page.wait(500);
    const picture = page.element<HTMLCanvasElement>('picture');
    const pixels = () => picture.getContext('2d')!.getImageData(0, 0, picture.width, picture.height).data;
    // How different the picture is from its mirror image, left to right, on average over a grid of points.
    const asymmetry = (width = picture.width, height = picture.height) => {
      const data = pixels();
      let total = 0;
      let count = 0;
      for (let y = 10; y < height; y += Math.floor(height / 12)) {
        for (let x = 10; x < width / 2; x += Math.floor(width / 24)) {
          const a = (y * width + x) * 4;
          const b = (y * width + (width - 1 - x)) * 4;
          total += Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]);
          count++;
        }
      }
      return total / count;
    };
    const mirrored = asymmetry();
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const row = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === 'Kaleidoscope')!;
    row.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: row.getBoundingClientRect().top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // More segments, round a centre far to one side: the corners are still filled.
    const set = (key: string, value: string) => {
      const input = document.querySelector<HTMLInputElement>(`#editor-layer .setting[data-key="${key}"] input[type="number"]`)!;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('segments', '8');
    set('x', '85');
    set('y', '20');
    await page.wait(300);
    // The editor's wider panel has made the picture smaller since.
    const data = pixels();
    const [w, h] = [picture.width, picture.height];
    const corners = [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2]].map(([x, y]) => {
      const i = (y * w + x) * 4;
      return data[i] + data[i + 1] + data[i + 2];
    });
    row.querySelector<HTMLButtonElement>('.layer-eye')!.click();
    await page.wait(300);
    return { mirrored, plain: asymmetry(picture.width, picture.height), corners };
  });
  assert.ok(seen.plain > 40, `the picture itself is lopsided: ${seen.plain}`);
  assert.ok(seen.mirrored < 6, `mirrored, it is the same both ways: ${seen.mirrored}`);
  for (const corner of seen.corners) assert.ok(corner > 60, `no black corner: ${seen.corners}`);
});

test('blends work out as their formulas say, linear burn included', { skip }, async () => {
  const file = join(work, 'Greys.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1,
    name: 'Greys',
    fields: [],
    layers: [
      { type: 'gradient', params: { colour1: '#808080', colour2: '#808080' } },
      { type: 'gradient', name: 'Top', params: { colour1: '#c0c0c0', colour2: '#c0c0c0' } },
    ],
  }));
  const seen = await runApp({ recording: mix, data: await fresh(), template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    await page.until(() => page.element<HTMLSelectElement>('template').selectedOptions[0]?.text === 'Greys', 'the template to be added');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const row = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === 'Top')!;
    row.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: row.getBoundingClientRect().top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const picture = page.element<HTMLCanvasElement>('picture');
    const middle = () => picture.getContext('2d')!.getImageData(picture.width / 2, picture.height / 2, 1, 1).data[0];
    const levels: Record<string, number> = {};
    for (const blend of ['normal', 'add', 'colour dodge', 'multiply', 'colour burn', 'linear burn']) {
      document.querySelector<HTMLButtonElement>('#editor-layer-top .layer-blend .lut-current')!.click();
      document.querySelector<HTMLButtonElement>(`#editor-layer-top .layer-blend .lut-item[data-value="${blend}"]`)!.click();
      await page.wait(150);
      levels[blend] = middle();
    }
    // Half as much of the layer: half way from the grey beneath to the burnt.
    const opacity = document.querySelector<HTMLInputElement>('#editor-layer-top .setting[data-key="opacity"] input[type="number"]')!;
    opacity.value = '0.5';
    opacity.dispatchEvent(new Event('input', { bubbles: true }));
    await page.wait(150);
    levels['linear burn at half'] = middle();
    return levels;
  });
  const expected: Record<string, number> = { normal: 192, add: 255, 'colour dodge': 255, multiply: 96, 'colour burn': 86, 'linear burn': 65, 'linear burn at half': 96 };
  for (const [blend, level] of Object.entries(expected)) assert.ok(Math.abs(seen[blend] - level) <= 6, `${blend}: ${seen[blend]}, not about ${level}`);
});

test('blend and opacity sit above the layers, for the selected layer, as in an image editor', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh(), timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const select = (name: string) => {
      const row = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === name)!;
      row.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: row.getBoundingClientRect().top + 5, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };
    const opacity = () => document.querySelector<HTMLInputElement>('#editor-layer-top .setting[data-key="opacity"] input[type="number"]')!;
    const box = () => document.querySelector<HTMLButtonElement>('#editor-layer-top .opacity-value')!;
    const popover = () => document.querySelector<HTMLElement>('#editor-layer-top .opacity-popover')!;
    const blendOf = () => ({ get value() { return document.querySelector<HTMLButtonElement>('#editor-layer-top .layer-blend .lut-current')!.dataset.value; } });
    select('Logo');
    // A click opens the full control under the box; Escape closes it.
    box().click();
    const opened = !popover().hidden;
    opacity().value = '0.4';
    opacity().dispatchEvent(new Event('input', { bubbles: true }));
    await page.wait(50);
    const shown = box().textContent;
    opacity().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const closed = popover().hidden;
    // Resting the pointer on it opens it too, and leaving closes it.
    box().parentElement!.dispatchEvent(new MouseEvent('mouseenter'));
    await page.wait(400);
    const hovered = !popover().hidden;
    box().parentElement!.dispatchEvent(new MouseEvent('mouseleave'));
    await page.wait(500);
    const left = popover().hidden;
    // ↓ on the closed list steps to the next blend, and the picture shows it at once: normal, then add, then screen.
    const button = document.querySelector<HTMLButtonElement>('#editor-layer-top .layer-blend .lut-current')!;
    button.focus();
    const frames = () => Number(page.element('picture').dataset.frames ?? 0);
    await page.wait(150);
    const before = frames();
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const stepped = [blendOf().value, document.activeElement === button];
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await page.wait(150);
    const redrawn = frames() > before;
    select('Background');
    const other = [opacity().value, blendOf().value];
    select('Logo');
    const back = [opacity().value, blendOf().value];
    // An expression shows as ƒ and what it comes to.
    box().click();
    document.querySelector<HTMLButtonElement>('#editor-layer-top .setting[data-key="opacity"] .fx:not(.motion-button)')!.click();
    await page.wait(200);
    const expression = box().textContent;
    // The box keeps its size whatever it shows, so nothing beside it moves.
    const widths = new Set<number>();
    const expressionInput = document.querySelector<HTMLInputElement>('#editor-layer-top .expr-input')!;
    for (const text of ['0.05', '0.4', '1', '2.5']) {
      expressionInput.value = text;
      expressionInput.dispatchEvent(new Event('input', { bubbles: true }));
      await page.wait(120);
      widths.add(Math.round(box().getBoundingClientRect().width * 10));
    }
    const atMost = box().textContent;
    const below = document.querySelectorAll('#editor-layer .setting[data-key="opacity"], #editor-layer .setting[data-key="blend"]').length;
    // With every layer gone, nothing is selected: the bar is there, greyed.
    while (document.querySelector('.layer-row')) page.click('editor-delete');
    const empty = page.element('editor-layer-top').querySelector('.empty') !== null;
    return { opened, shown, closed, hovered, left, stepped, redrawn, other, back, expression, widths: widths.size, atMost, below, empty };
  });
  assert.deepEqual([seen.opened, seen.shown, seen.closed, seen.hovered, seen.left], [true, '0.40', true, true, true]);
  assert.equal(seen.expression, 'ƒ 0.40');
  assert.equal(seen.widths, 1, 'the box keeps its width from ƒ 0.05 to ƒ 1.00');
  assert.equal(seen.atMost, 'ƒ 1.00', 'an expression past 1 shows what is drawn');
  assert.deepEqual(seen.stepped, ['add', true], '↓ chose the next blend and the list kept the keys');
  assert.ok(seen.redrawn, 'the picture was drawn again with each blend reached');
  assert.deepEqual(seen.other, ['1', 'normal']);
  assert.deepEqual(seen.back, ['0.4', 'screen']);
  assert.equal(seen.below, 0, 'not repeated below the list');
  assert.ok(seen.empty);
});

test('number boxes change when dragged sideways, and a click is still a click', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh(), timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const row = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === 'Ring')!;
    row.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: row.getBoundingClientRect().top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // A press, a drag sideways by dx, a release, and the click a browser sends after.
    const drag = (target: HTMLElement, dx: number, shiftKey = false) => {
      const box = target.getBoundingClientRect();
      const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
      target.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true }));
      for (const part of [0.25, 0.5, 1]) window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + dx * part, clientY: y, shiftKey }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: x + dx, clientY: y, bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };
    // Looked up each time: once a change settles, the bar above the layers is made anew.
    const box = () => document.querySelector<HTMLButtonElement>('#editor-layer-top .opacity-value')!;
    const popover = () => document.querySelector<HTMLElement>('#editor-layer-top .opacity-popover')!;
    // The box shows the value on the next frame drawn, which on a machine without a graphics card takes a while.
    drag(box(), -40);
    await page.until(() => box().textContent === '0.80', 'the opacity to show 0.80', 3000).catch(() => {});
    // The full control under the box follows, slider and all.
    const slider = popover().querySelector<HTMLInputElement>('input[type="range"]')!.value;
    const lowered = { shown: box().textContent, opened: !popover().hidden, slider };
    drag(box(), 400);
    await page.until(() => box().textContent === '1.00', 'the opacity to show 1.00', 3000).catch(() => {});
    const raised = box().textContent;
    drag(box(), 0);
    const clicked = !popover().hidden;
    box().click();

    const rotation = () => document.querySelector<HTMLInputElement>('#editor-layer .setting[data-key="rotation"] input[type="number"]')!;
    drag(rotation(), 50);
    const turned = Number(rotation().value);
    await page.wait(1100);
    drag(rotation(), -50, true);
    const finer = Number(rotation().value);
    drag(rotation(), 0);
    const typing = document.activeElement === rotation();
    rotation().blur();
    await page.wait(1100);
    page.click('undo');
    await page.wait(100);
    const undone = Number(rotation().value);
    return { lowered, raised, clicked, turned, finer, typing, undone };
  });
  assert.deepEqual(seen.lowered, { shown: '0.80', opened: false, slider: '0.8' }, 'a drag is not a click, and the slider follows');
  assert.equal(seen.raised, '1.00', 'opacity stops at 1');
  assert.ok(seen.clicked, 'a click without a drag opens the full control');
  assert.equal(seen.turned, 60);
  assert.equal(seen.finer, 54, 'with Shift, ten times finer');
  assert.ok(seen.typing, 'a click without a drag is for typing');
  assert.equal(seen.undone, 60, 'each drag one undo step');
});

test('a group draws its layers as one: faded together, effects kept inside it, hidden together', { skip }, async () => {
  const file = join(work, 'Grouped.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1,
    name: 'Grouped',
    fields: [],
    layers: [
      { type: 'gradient', params: { colour1: '#0000ff', colour2: '#0000ff' } },
      { type: 'group', name: 'Half', size: 1, params: { opacity: 50 } },
      { type: 'gradient', params: { colour1: '#ffffff', colour2: '#ffffff', x: 50, y: 50 } },
      { type: 'group', name: 'Turned', size: 2, params: {} },
      { type: 'text', params: { text: 'XXXX', size: 30, weight: 900, colour: '#ff0000', boxColour: '#ff0000', y: 50 } },
      { type: 'hue', params: { hue: 120 } },
    ],
  }));
  const seen = await runApp({ recording: mix, data: await fresh(), template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    await page.until(() => page.element<HTMLSelectElement>('template').selectedOptions[0]?.text === 'Grouped', 'the template to be added');
    await page.wait(500);
    const picture = page.element<HTMLCanvasElement>('picture');
    const at = (x: number, y: number) => [...picture.getContext('2d')!.getImageData(Math.floor(picture.width * x), Math.floor(picture.height * y), 1, 1).data].slice(0, 3);
    // The corner: blue beneath, white at half over it. The middle: the text, red turned green inside its group.
    const corner = at(0.02, 0.02);
    const middle = at(0.5, 0.5);
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const row = (name: string) => [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === name)!;
    const list = [...document.querySelectorAll<HTMLElement>('.layer-row')].map((r) => `${r.style.paddingLeft} ${r.querySelector('.layer-name')!.textContent}`);
    row('Half').querySelector<HTMLButtonElement>('.layer-eye')!.click();
    await page.wait(200);
    const hidden = at(0.02, 0.02);
    return { corner, middle, list, hidden };
  });
  assert.ok(Math.abs(seen.corner[0] - 128) < 8 && Math.abs(seen.corner[2] - 255) < 8, `white at half over blue: ${seen.corner}`);
  assert.ok(seen.middle[1] > 80 && seen.middle[1] > seen.middle[0] * 3 && seen.middle[1] > seen.middle[2] * 3, `the red text turned green: ${seen.middle}`);
  assert.deepEqual(seen.list, ['3px Turned', '19px Hue and saturation', '19px Text', '3px Half', '19px Gradient', '3px Gradient']);
  assert.deepEqual(seen.hidden, [0, 0, 255], 'the hidden group takes its layers with it');
});

test('layers grouped with ⌘G, moved into groups, duplicated with ⌘J, ungrouped and deleted as groups', { skip }, async () => {
  const data = await fresh();
  const seen = await runApp({ recording: mix, data, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const rows = () => [...document.querySelectorAll<HTMLElement>('.layer-row')];
    const row = (name: string) => rows().find((r) => r.querySelector('.layer-name')!.textContent === name)!;
    const list = () => rows().map((r) => `${r.style.paddingLeft === '3px' ? '' : '  '}${r.querySelector('.layer-name')!.textContent}`);
    const select = (name: string) => {
      row(name).dispatchEvent(new MouseEvent('mousedown', { clientX: 60, clientY: row(name).getBoundingClientRect().top + 5, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };
    const shortcut = (code: string, shiftKey = false) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code.slice(3).toLowerCase(), metaKey: true, ctrlKey: true, shiftKey, bubbles: true }));
    const drag = (name: string, onto: string, share: number) => {
      const from = row(name).getBoundingClientRect();
      const to = row(onto).getBoundingClientRect();
      row(name).dispatchEvent(new MouseEvent('mousedown', { clientX: 60, clientY: from.top + 5, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: from.top + 20 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: to.top + to.height * share }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };

    select('Logo');
    shortcut('KeyG');
    const grouped = list();
    drag('Artist', 'Group 1', 0.5);
    const moved = list();
    select('Group 1');
    shortcut('KeyJ');
    const duplicated = list();
    shortcut('KeyG', true);
    const ungrouped = list();
    select('Group 1');
    page.click('editor-delete');
    const deleted = list();
    page.click('undo');
    await page.wait(100);
    const undone = list();
    await page.wait(600);
    return { grouped, moved, duplicated, ungrouped, deleted, undone, mixes: page.tabs().length };
  });
  assert.deepEqual(seen.grouped, ['Glow', 'Now playing', 'Mix and time', 'Artist', 'Group 1', '  Logo', 'Ring', 'Background']);
  assert.deepEqual(seen.moved, ['Glow', 'Now playing', 'Mix and time', 'Group 1', '  Artist', '  Logo', 'Ring', 'Background']);
  // The copy, in front, holds copies of what the group holds; it is the one selected after.
  assert.deepEqual(seen.duplicated, ['Glow', 'Now playing', 'Mix and time', 'Group 1', '  Artist', '  Logo', 'Group 1', '  Artist', '  Logo', 'Ring', 'Background']);
  assert.deepEqual(seen.ungrouped, ['Glow', 'Now playing', 'Mix and time', 'Artist', 'Logo', 'Group 1', '  Artist', '  Logo', 'Ring', 'Background']);
  assert.deepEqual(seen.deleted, ['Glow', 'Now playing', 'Mix and time', 'Artist', 'Logo', 'Ring', 'Background'], 'the group went with all in it');
  assert.deepEqual(seen.undone, seen.ungrouped);
  assert.equal(seen.mixes, 1);

  const [file] = await readdir(join(data, 'templates'));
  const saved = JSON.parse(readFileSync(join(data, 'templates', file), 'utf8'));
  assert.deepEqual(saved.layers.map((layer: { name?: string; type: string; size?: number }) => `${layer.name ?? layer.type}${layer.size === undefined ? '' : `[${layer.size}]`}`),
    ['Background', 'Ring', 'Group 1[2]', 'Logo', 'Artist', 'Logo', 'Artist', 'Mix and time', 'Now playing', 'glow']);
});

test('the + menu opens with Shift+⌘N, fits the window, scrolls, and finds a kind of layer by typing', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh(), timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const listHeight = page.element('editor-layers').offsetHeight;
    const menu = page.element('editor-add-menu');
    const search = menu.querySelector<HTMLInputElement>('.add-menu-search')!;
    const names = () => [...menu.querySelectorAll<HTMLButtonElement>('.add-menu-items button')].map((b) => b.textContent);
    const inside = () => {
      const box = menu.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    };
    // Shift+⌘N opens it, as the + button does.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', key: 'N', shiftKey: true, metaKey: true, ctrlKey: true, bubbles: true }));
    const opened = { fits: inside(), focused: document.activeElement === search, kinds: names().length };
    search.value = 'glit';
    search.dispatchEvent(new Event('input'));
    const found = names();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const added = document.querySelector('.layer-row.on .layer-name')!.textContent;
    page.click('editor-add');
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const closed = menu.hidden;
    // With the button half way down the window (the list made shorter, as its edge can be dragged), neither
    // side has room for all of it: it still fits the window, and what does not fit scrolls.
    const list = page.element('editor-layers');
    const button = () => page.element('editor-add').getBoundingClientRect();
    list.style.height = `${list.offsetHeight + (window.innerHeight / 2 - button().top)}px`;
    await page.wait(100);
    page.click('editor-add');
    const items = menu.querySelector<HTMLElement>('.add-menu-items')!;
    const short = { fits: inside(), scrolls: items.scrollHeight > items.clientHeight };
    return { listHeight, opened, found, added, closed, short };
  });
  assert.ok(seen.listHeight >= 220, `the list starts tall: ${seen.listHeight}`);
  assert.deepEqual(seen.opened, { fits: true, focused: true, kinds: 23 });
  assert.deepEqual(seen.found, ['Glitter', 'Glitch']);
  assert.equal(seen.added, 'Glitter', 'Enter adds the first that matches');
  assert.ok(seen.closed);
  assert.deepEqual(seen.short, { fits: true, scrolls: true }, 'with little room either side, it fits and scrolls');
});

test('a solid colour fills the picture, and a vignette darkens its edges and not its middle', { skip }, async () => {
  const file = join(work, 'Vignette.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1,
    name: 'Vignette',
    fields: [],
    layers: [
      { type: 'solid', params: { colour: '#808080' } },
      { type: 'vignette', params: { colour: '#000000', size: 30, softness: 60 } },
    ],
  }));
  const seen = await runApp({ recording: mix, data: await fresh(), template: file }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    await page.until(() => page.element<HTMLSelectElement>('template').selectedOptions[0]?.text === 'Vignette', 'the template to be added');
    await page.wait(500);
    const picture = page.element<HTMLCanvasElement>('picture');
    const at = (x: number, y: number) => picture.getContext('2d')!.getImageData(Math.floor(picture.width * x), Math.floor(picture.height * y), 1, 1).data[0];
    return { middle: at(0.5, 0.5), side: at(0.97, 0.5), corner: at(0.01, 0.01) };
  });
  assert.equal(seen.middle, 128, 'the middle is the solid colour, untouched');
  assert.ok(seen.side < 110 && seen.side > seen.corner, `darker at the side: ${seen.side}`);
  assert.ok(seen.corner < 15, `darkest in the corner: ${seen.corner}`);
});

test('a transform moves, sizes and flips the picture beneath, with nothing, repeats, mirror images or drawn-out edges past it', { skip }, async () => {
  const file = join(work, 'Transform.djmtemplate');
  // White at the left to black at the right, made half as big round the middle; what is past its edges is chosen by a field.
  await writeFile(file, JSON.stringify({
    format: 1,
    name: 'Transform',
    fields: [
      { key: 'edges', label: 'Edges', kind: 'choice', default: 'none', choices: ['none', 'repeat', 'mirror', 'extend'] },
      { key: 'flip', label: 'Flip', kind: 'number', default: 0, min: 0, max: 1 },
    ],
    layers: [
      { type: 'gradient', params: { colour1: '#ffffff', colour2: '#000000', angle: 0 } },
      { type: 'transform', params: { scale: 50, edges: '%edges%', flipX: 'flip' } },
    ],
  }));
  const seen = await runApp({ recording: mix, data: await fresh(), template: file }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    await page.until(() => page.element<HTMLSelectElement>('template').selectedOptions[0]?.text === 'Transform', 'the template to be added');
    await page.wait(500);
    const picture = page.element<HTMLCanvasElement>('picture');
    const at = (x: number) => picture.getContext('2d')!.getImageData(Math.floor(picture.width * x), Math.floor(picture.height / 2), 1, 1).data[0];
    const set = async (key: string, value: string) => {
      const control = page.element<HTMLInputElement>(`field-${key}`);
      control.value = value;
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
      await page.wait(300);
    };
    const levels: Record<string, number> = {};
    for (const edges of ['none', 'repeat', 'mirror', 'extend']) {
      await set('edges', edges);
      levels[edges] = at(0.02);
    }
    await set('edges', 'none');
    const unflipped = at(0.35);
    await set('flip', '1');
    return { levels, unflipped, flipped: at(0.35) };
  });
  const { none, repeat, mirror, extend } = seen.levels;
  assert.ok(none < 5, `nothing past the edges is black: ${none}`);
  assert.ok(extend > 200, `drawn out, the white left edge goes on: ${extend}`);
  // Just left of the half-size picture: repeated, the picture's right of middle (darker); mirrored, its left of middle.
  assert.ok(repeat > 60 && repeat < mirror && mirror < 200, `repeat ${repeat}, mirror ${mirror}`);
  assert.ok(seen.unflipped > 150 && seen.flipped < 100, `flipped across: ${seen.unflipped} then ${seen.flipped}`);
});

test('layer styles: a drop shadow falls away from the light, a stroke and an outer glow go all round, an inner shadow and an inner glow stay inside', { skip }, async () => {
  const file = join(work, 'Styles.djmtemplate');
  // A white block in the middle, each style switched on by a field, each in a colour of its own to be found by.
  await writeFile(file, JSON.stringify({
    format: 1,
    name: 'Styles',
    fields: [
      // 0 none, 1 the shadow, 2 the stroke, 3 the glow, 4 the inner shadow, 5 the inner glow; up to 100 so that the slider's steps are whole.
      { key: 'style', label: 'Style', kind: 'number', default: 0, min: 0, max: 100 },
    ],
    layers: [
      { type: 'solid', params: { colour: '#000000' } },
      {
        type: 'text',
        params: {
          text: 'I', size: 10, colour: '#ffffff', boxColour: '#ffffff', boxPadding: 3,
          dropShadow: 'style == 1', dropColour: '#00ff00', dropOpacity: 100, dropDistance: 3, dropSize: 0, dropAngle: 135,
          stroke: 'style == 2', strokeColour: '#ff0000', strokeWidth: 1,
          outerGlow: 'style == 3', glowColour: '#0000ff', glowSize: 3, glowSpread: 50,
          innerShadow: 'style == 4', innerShadowColour: '#00ff00', innerShadowOpacity: 100, innerShadowDistance: 1, innerShadowSize: 0, innerShadowAngle: 135,
          innerGlow: 'style == 5', innerGlowColour: '#0000ff', innerGlowOpacity: 100, innerGlowSize: 1, innerGlowChoke: 50,
        },
      },
    ],
  }));
  const seen = await runApp({ recording: mix, data: await fresh(), template: file }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    await page.until(() => page.element<HTMLSelectElement>('template').selectedOptions[0]?.text === 'Styles', 'the template to be added');
    await page.wait(500);
    const picture = page.element<HTMLCanvasElement>('picture');
    /** Where each colour is: how many pixels, and the middle of them, in parts of the picture. */
    const find = () => {
      const { width, height } = picture;
      const data = picture.getContext('2d')!.getImageData(0, 0, width, height).data;
      const found: Record<string, { n: number; x: number; y: number; left: number; right: number }> = {};
      for (const name of ['white', 'red', 'green', 'blue']) found[name] = { n: 0, x: 0, y: 0, left: 1, right: 0 };
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        const name = r > 200 && g > 200 && b > 200 ? 'white' : r > 200 && g < 60 && b < 60 ? 'red' : g > 200 && r < 60 && b < 60 ? 'green' : b > 120 && r < 60 && g < 60 ? 'blue' : '';
        if (!name) continue;
        const x = ((i / 4) % width) / width;
        const y = Math.floor(i / 4 / width) / height;
        const f = found[name];
        f.n++;
        f.x += x;
        f.y += y;
        f.left = Math.min(f.left, x);
        f.right = Math.max(f.right, x);
      }
      for (const f of Object.values(found)) if (f.n) [f.x, f.y] = [f.x / f.n, f.y / f.n];
      return found;
    };
    const results: Record<string, ReturnType<typeof find>> = {};
    for (const [n, style] of ['none', 'shadow', 'stroke', 'glow', 'innerShadow', 'innerGlow'].entries()) {
      const control = page.element<HTMLInputElement>('field-style');
      control.value = String(n);
      control.dispatchEvent(new Event('input', { bubbles: true }));
      await page.wait(300);
      results[style] = find();
    }
    return results;
  });
  const { none, shadow, stroke, glow, innerShadow, innerGlow } = seen;
  assert.ok(none.white.n > 1000 && !none.red.n && !none.green.n && !none.blue.n, 'without a style, the block alone');
  // Light from 135°, up and to the left: the shadow falls down and to the right.
  assert.ok(shadow.green.n > 100 && shadow.green.x > shadow.white.x && shadow.green.y > shadow.white.y, `the shadow: ${JSON.stringify(shadow.green)}`);
  assert.ok(Math.abs(shadow.white.n - none.white.n) < none.white.n * 0.02, 'the layer is drawn over its shadow');
  // All round: past the block on both sides, centred on it.
  for (const [name, found, colour] of [['stroke', stroke, 'red'], ['glow', glow, 'blue']] as const) {
    const ring = found[colour];
    assert.ok(ring.n > 100 && ring.left < found.white.left && ring.right > found.white.right, `the ${name} goes round: ${JSON.stringify(ring)}`);
    assert.ok(Math.abs(ring.x - found.white.x) < 0.01 && Math.abs(ring.y - found.white.y) < 0.02, `the ${name} is centred on the layer`);
  }
  // Inside the block: the inner shadow along the edges nearest the light, up and to the left; the inner glow along all of them.
  const block = none.white;
  const inside = (f: { left: number; right: number }) => f.left >= block.left - 0.002 && f.right <= block.right + 0.002;
  const shade = innerShadow.green;
  assert.ok(shade.n > 100 && inside(shade) && shade.x < block.x && shade.y < block.y, `the inner shadow: ${JSON.stringify(shade)}`);
  const lit = innerGlow.blue;
  assert.ok(lit.n > 100 && inside(lit) && Math.abs(lit.x - block.x) < 0.01 && Math.abs(lit.y - block.y) < 0.02, `the inner glow: ${JSON.stringify(lit)}`);
  assert.ok(innerGlow.white.n > 0 && innerGlow.white.n < block.n, 'the middle of the block still shows');
});

test('trails leave what moves behind while playing, and nothing while paused', { skip }, async () => {
  const file = join(work, 'Trails.djmtemplate');
  // A word swinging from side to side; trails switched on by a field.
  await writeFile(file, JSON.stringify({
    format: 1,
    name: 'Trails',
    fields: [{ key: 'on', label: 'On', kind: 'number', default: 0, min: 0, max: 100 }],
    layers: [
      { type: 'solid', params: { colour: '#000000' } },
      { type: 'text', params: { text: 'I', size: 20, colour: '#ffffff', x: '50 + 35 * sin(time * 8)' } },
      { type: 'trails', params: { visible: 'on > 50', length: 2, mode: 'bright parts' } },
    ],
  }));
  const seen = await runApp({ recording: mix, data: await fresh(), template: file, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    await page.until(() => page.element<HTMLSelectElement>('template').selectedOptions[0]?.text === 'Trails', 'the template to be added');
    const picture = page.element<HTMLCanvasElement>('picture');
    /** The share of the picture that is lit. */
    const lit = () => {
      const data = picture.getContext('2d')!.getImageData(0, 0, picture.width, picture.height).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 16) if (data[i] > 40) n++;
      return n / (data.length / 16);
    };
    const on = async (value: number) => {
      const control = page.element<HTMLInputElement>('field-on');
      control.value = String(value);
      control.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const playing = () => page.element('play').classList.contains('playing');
    page.key('Space');
    await page.until(playing, 'playback to start');
    await page.wait(1500);
    const without = lit();
    await on(100);
    await page.wait(1500);
    const withTrails = lit();
    page.key('Space');
    await page.until(() => !playing(), 'playback to stop');
    // Paused, a change draws the picture again, without its past.
    await on(99);
    await page.wait(300);
    return { without, withTrails, paused: lit() };
  });
  assert.ok(seen.withTrails > seen.without * 3, `trails light up much more: ${seen.withTrails} against ${seen.without}`);
  assert.ok(seen.paused < seen.without * 1.5, `paused, only the word: ${seen.paused} against ${seen.without}`);
});

test('an effect in a group replaces the group\'s layers, rather than leaving them showing through', { skip }, async () => {
  const file = join(work, 'Grouped kaleidoscope.djmtemplate');
  await writeFile(file, JSON.stringify({
    format: 1,
    name: 'Grouped kaleidoscope',
    fields: [],
    layers: [
      { type: 'gradient', params: { colour1: '#000000', colour2: '#000000' } },
      { type: 'group', name: 'G', size: 2, params: {} },
      // On the left; the kaleidoscope takes its slice from the right, where there is nothing.
      { type: 'text', params: { text: 'XX', size: 20, colour: '#ff0000', boxColour: '#ff0000', x: 20, y: 50 } },
      { type: 'kaleidoscope', params: { segments: 4, angle: 0, mirrored: false } },
    ],
  }));
  const seen = await runApp({ recording: mix, data: await fresh(), template: file }, async (page) => {
    page.click('view-video');
    page.click('template-import');
    await page.until(() => page.element<HTMLSelectElement>('template').selectedOptions[0]?.text === 'Grouped kaleidoscope', 'the template to be added');
    await page.wait(500);
    const picture = page.element<HTMLCanvasElement>('picture');
    return [...picture.getContext('2d')!.getImageData(Math.floor(picture.width * 0.2), Math.floor(picture.height * 0.5), 1, 1).data].slice(0, 3);
  });
  assert.deepEqual(seen, [0, 0, 0], 'the text the pattern was made from does not show through it');
});

test('paused, the picture is drawn only when something changes; playing, all the time', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh(), timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    const picture = page.element<HTMLCanvasElement>('picture');
    const frames = () => Number(picture.dataset.frames ?? 0);
    // Once the music has been listened to: its coming in draws the picture again, as it should.
    await page.until(() => picture.dataset.music === 'true', 'the picture to be drawn from the music', 60_000);
    await page.wait(500);
    // How many frames are drawn while `during` runs and a moment after.
    const count = async (during: () => void | Promise<void>, ms: number) => {
      const before = frames();
      await during();
      await page.wait(ms);
      return frames() - before;
    };
    const paused = await count(() => {}, 1000);
    // A name typed in fades in over a moment, drawn frame by frame; then drawing stops.
    const typed = await count(() => page.type('mix-artist', 'Suva'), 1200);
    const after = await count(() => {}, 1000);
    const moved = await count(() => page.key('ArrowRight'), 300);
    page.key('Space');
    await page.until(() => page.element('play').classList.contains('playing'), 'playback to start');
    const playing = await count(() => {}, 1000);
    page.key('Space');
    return { paused, typed, after, moved, playing };
  });
  assert.equal(seen.paused, 0, 'nothing drawn while nothing changes');
  assert.ok(seen.typed >= 5, `drawn again for a change, through its fade: ${seen.typed}`);
  assert.equal(seen.after, 0, 'and still again after it');
  assert.ok(seen.moved >= 1, 'drawn again when the playhead moves');
  assert.ok(seen.playing >= 10, `drawn all the time while playing: ${seen.playing}`);
});

test('several layers selected with ⌘-click and Shift-click are grouped, deleted, duplicated and dragged together', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh(), timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const rows = () => [...document.querySelectorAll<HTMLElement>('.layer-row')];
    const row = (name: string) => rows().find((r) => r.querySelector('.layer-name')!.textContent === name)!;
    const list = () => rows().map((r) => `${r.style.paddingLeft === '3px' ? '' : '  '}${r.querySelector('.layer-name')!.textContent}`);
    const picked = () => rows().filter((r) => r.classList.contains('on')).map((r) => r.querySelector('.layer-name')!.textContent);
    const click = (name: string, keys: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) => {
      row(name).dispatchEvent(new MouseEvent('mousedown', { clientX: 60, clientY: row(name).getBoundingClientRect().top + 5, bubbles: true, ...keys }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };
    const shortcut = (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code.slice(3).toLowerCase(), metaKey: true, ctrlKey: true, bubbles: true }));

    click('Artist');
    click('Logo', { metaKey: true, ctrlKey: true });
    const two = { picked: picked(), title: document.getElementById('editor-layer-title')!.textContent };
    shortcut('KeyG');
    const grouped = list();

    click('Glow');
    click('Mix and time', { shiftKey: true });
    const run = picked();
    page.click('editor-delete');
    const deleted = list();

    click('Ring');
    click('Background', { metaKey: true, ctrlKey: true });
    shortcut('KeyJ');
    const duplicated = { list: list(), picked: picked() };

    // The two copies, dragged together onto the group.
    const from = row('Ring').getBoundingClientRect();
    const onto = row('Group 1').getBoundingClientRect();
    row('Ring').dispatchEvent(new MouseEvent('mousedown', { clientX: 60, clientY: from.top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: from.top - 20 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: onto.top + onto.height / 2 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const dragged = list();
    page.click('undo');
    await page.wait(100);
    return { two, grouped, run, deleted, duplicated, dragged, undone: list(), mixes: page.tabs().length };
  });
  assert.deepEqual(seen.two, { picked: ['Artist', 'Logo'], title: 'Logo and 1 more selected' });
  assert.deepEqual(seen.grouped, ['Glow', 'Now playing', 'Mix and time', 'Group 1', '  Artist', '  Logo', 'Ring', 'Background']);
  assert.deepEqual(seen.run, ['Glow', 'Now playing', 'Mix and time']);
  assert.deepEqual(seen.deleted, ['Group 1', '  Artist', '  Logo', 'Ring', 'Background']);
  assert.equal(seen.mixes, 1);
  assert.deepEqual(seen.duplicated, { list: ['Group 1', '  Artist', '  Logo', 'Ring', 'Ring', 'Background', 'Background'], picked: ['Ring', 'Background'] });
  assert.deepEqual(seen.dragged, ['Group 1', '  Ring', '  Background', '  Artist', '  Logo', 'Ring', 'Background']);
  assert.deepEqual(seen.undone, seen.duplicated.list);
});

test('a layer not selected is renamed with a double-click, as a real one arrives', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh(), timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const row = [...document.querySelectorAll<HTMLElement>('.layer-row')].find((r) => r.querySelector('.layer-name')!.textContent === 'Logo')!;
    const box = row.getBoundingClientRect();
    const [x, y] = [box.left + 80, box.top + box.height / 2];
    // Each event goes to whatever is under the pointer then; the browser sends a double-click
    // only when both presses landed on the same element.
    const press = () => {
      const target = document.elementFromPoint(x, y)!;
      target.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true }));
      document.elementFromPoint(x, y)!.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, button: 0, bubbles: true }));
      document.elementFromPoint(x, y)!.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, button: 0, bubbles: true }));
      return target;
    };
    const first = press();
    const second = press();
    const same = first === second;
    if (same) second.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true }));
    const field = document.querySelector<HTMLInputElement>('.layer-rename');
    if (field) {
      field.value = 'Badge';
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    return { same, field: !!field, names: [...document.querySelectorAll('.layer-row .layer-name')].map((name) => name.textContent) };
  });
  assert.ok(seen.same, 'both presses landed on the same row');
  assert.ok(seen.field, 'the name opened for typing');
  assert.ok(seen.names.includes('Badge'));
});

test('a template says who made it, in the About tab and under the list of templates', { skip }, async () => {
  const data = await fresh();
  const seen = await runApp({ recording: mix, data, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    const builtIn = page.text('template-about');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    page.click('editor-tab-about');
    const set = (key: string, value: string) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`.about-input[data-key="${key}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.parentElement!.querySelector('.setting-problem')!.textContent;
    };
    const kept = document.querySelector<HTMLTextAreaElement>('.about-input[data-key="description"]')!.value;
    set('author', 'Suva');
    const wrong = set('email', 'suva');
    set('email', 'suva@example.com');
    set('website', 'https://example.com/suva/');
    set('description', 'A ring for the late hours.');
    await page.wait(600);
    page.click('editor-done');
    const about = page.element('template-about');
    return {
      builtIn,
      kept,
      wrong,
      shown: about.textContent,
      links: [...about.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    };
  });
  assert.match(seen.builtIn, /^Spectrum ringBy DJ Mix MasterThe spectrum as a ring/);
  assert.match(seen.kept, /^The spectrum as a ring/, 'a copy keeps what the original said, to change');
  assert.equal(seen.wrong, 'An email address, such as name@example.com');
  assert.equal(seen.shown, 'Spectrum ring copyBy Suva · example.com/suva · suva@example.comA ring for the late hours.');
  assert.deepEqual(seen.links, ['https://example.com/suva/', 'mailto:suva@example.com']);
  const [file] = await readdir(join(data, 'templates'));
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'templates', file), 'utf8')).about, {
    author: 'Suva', email: 'suva@example.com', website: 'https://example.com/suva/', description: 'A ring for the late hours.',
  });
});

test('the ⋯ menu beside the templates opens, closes, and leaves Delete for templates of your own', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    page.click('view-video');
    const menu = page.element('template-menu');
    page.element('template-more').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const opened = !menu.hidden;
    const items = [...menu.querySelectorAll('button')].map((b) => `${b.textContent}${(b as HTMLButtonElement).disabled ? ' (off)' : ''}`);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const escaped = menu.hidden;
    page.element('template-more').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const outside = menu.hidden;
    return { opened, items, escaped, outside, pencil: page.element('template-edit').getAttribute('aria-label') };
  });
  assert.deepEqual(seen, {
    opened: true,
    items: ['Duplicate', 'Import…', 'Export…', 'Delete (off)'],
    escaped: true,
    outside: true,
    pencil: 'Edit a copy of the template',
  });
});

test('the window opens in the view it was left in: mastering, video, or the template editor', { skip }, async () => {
  const data = await fresh();
  // Left editing a template.
  await runApp({ recording: mix, data, timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    await page.settle();
  });
  const editing = await runApp({ recording: mix, data, timeoutMs: 60_000 }, async (page) => {
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open again');
    const seen = { video: document.body.classList.contains('video'), editing: document.body.classList.contains('editing') };
    // Left in the Video view, the editor closed.
    page.click('editor-done');
    await page.wait(200);
    return seen;
  });
  const video = await runApp({ recording: mix, data, timeoutMs: 60_000 }, async (page) => {
    await page.until(() => document.body.classList.contains('video'), 'the Video view');
    await page.wait(500);
    const seen = { video: document.body.classList.contains('video'), editing: document.body.classList.contains('editing') };
    page.click('view-mastering');
    await page.wait(200);
    return seen;
  });
  const mastering = await runApp({ recording: mix, data, timeoutMs: 60_000 }, async (page) => {
    await page.wait(1000);
    return { video: document.body.classList.contains('video'), editing: document.body.classList.contains('editing') };
  });
  assert.deepEqual(editing, { video: true, editing: true });
  assert.deepEqual(video, { video: true, editing: false });
  assert.deepEqual(mastering, { video: false, editing: false });
});

test('the Settings dialog shows the folders and the update check, and changes them', { skip }, async () => {
  const data = await fresh();
  const chosen = join(work, 'chosen folder');
  await mkdir(chosen, { recursive: true });
  const seen = await runApp({ recording: mix, data, exportFolder: chosen, timeoutMs: 60_000 }, async (page) => {
    page.click('open-settings');
    await page.until(() => page.element<HTMLDialogElement>('settings-dialog').open, 'the dialog to open');
    await page.wait(100);
    const state = () => ({
      media: page.element('settings-media-folder').dataset.path,
      mediaOwn: page.element<HTMLButtonElement>('settings-media-default').disabled,
      luts: page.element('settings-lut-folder').dataset.path,
      updates: page.element<HTMLInputElement>('settings-updates').checked,
    });
    const before = state();
    // The folder dialog is answered with the chosen folder in check mode.
    page.click('settings-lut-change');
    await page.wait(300);
    const changed = state();
    const updates = page.element<HTMLInputElement>('settings-updates');
    updates.checked = false;
    updates.dispatchEvent(new Event('change', { bubbles: true }));
    await page.wait(300);
    const off = state();
    page.click('settings-lut-default');
    await page.wait(300);
    const back = state();
    // Keys belong to the dialog while it is open: Space does not start the music.
    page.key('Space');
    await page.wait(200);
    const playing = page.element('play').classList.contains('playing');
    page.click('settings-close');
    return { before, changed, off, back, playing, closed: !page.element<HTMLDialogElement>('settings-dialog').open };
  });
  assert.ok(seen.before.media!.startsWith(data) && seen.before.media!.endsWith('media'), `the app's own media folder: ${seen.before.media}`);
  assert.ok(seen.before.mediaOwn, 'nothing to go back to');
  assert.ok(seen.before.luts!.endsWith('luts'));
  assert.equal(seen.before.updates, true);
  assert.equal(seen.changed.luts, chosen);
  assert.equal(seen.off.updates, false);
  assert.ok(seen.back.luts!.startsWith(data) && seen.back.luts!.endsWith('luts'), `back to the app's own: ${seen.back.luts}`);
  assert.equal(seen.playing, false);
  assert.ok(seen.closed);
  const preferences = JSON.parse(readFileSync(join(data, 'preferences.json'), 'utf8'));
  assert.equal(preferences.lutFolder, undefined);
  const updates = JSON.parse(readFileSync(join(data, 'updates.json'), 'utf8'));
  assert.equal(updates.automatic, false);
});

test('a copy from the Microsoft Store leaves its updates to the Store', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh(), env: { DJMASTER_STORE: '1' } }, async (page) => {
    page.click('open-settings');
    await page.until(() => page.element<HTMLDialogElement>('settings-dialog').open, 'the dialog to open');
    await page.wait(100);
    return { own: !page.element('settings-updates-own').hidden, store: page.text('settings-updates-store'), shown: !page.element('settings-updates-store').hidden };
  });
  assert.deepEqual(seen, { own: false, store: 'This copy came from the Microsoft Store, which keeps it up to date.', shown: true });
});

test('a template file opened with the app is added, shown, and exported again from the editor', { skip }, async () => {
  const file = join(work, 'Opened.djmtemplate');
  await writeFile(file, JSON.stringify({ format: 1, name: 'Opened', fields: [], layers: [{ type: 'gradient', params: { colour1: '#ff0000', colour2: '#ff0000' } }] }));
  const out = join(work, 'exported again');
  await mkdir(out);
  const data = await fresh();
  // As from Finder or Explorer: the recording and the template named together.
  const seen = await runApp({ recording: [mix, file], data, exportFolder: out, timeoutMs: 60_000 }, async (page) => {
    const select = page.element<HTMLSelectElement>('template');
    await page.until(() => select.selectedOptions[0]?.text === 'Opened', 'the template to be added');
    const video = document.body.classList.contains('video');
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    const shown = !page.element('editor-export').hidden;
    page.click('editor-export');
    await page.wait(400);
    return { video, shown, file: page.text('file-name') };
  });
  assert.deepEqual({ video: seen.video, shown: seen.shown, file: seen.file }, { video: true, shown: true, file: 'Test mix.wav' });
  assert.equal((await sharedTemplate(join(out, 'Opened.djmtemplate'))).name, 'Opened');
});

test('a recording\'s channels put right from the check-up: heard, levelled, exported, undone and kept', { skip }, async () => {
  // The test mix with its right channel upside down and 6 dB down: out of phase, and quieter.
  const faulty = join(work, 'Wired wrong.wav');
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-i', mix, '-af', 'pan=stereo|c0=c0|c1=-0.5*c1', '-c:a', 'pcm_s16le', faulty]);
  const out = join(work, 'put right');
  await mkdir(out);
  const data = await fresh();
  const seen = await runApp({ recording: faulty, data, exportFolder: out, timeoutMs: 90_000 }, async (page) => {
    const findings = () => [...document.querySelectorAll<HTMLElement>('#checkup-findings .finding')];
    const offered = findings().map((f) => [f.querySelector('b')!.textContent, f.querySelector<HTMLButtonElement>('[data-fix]')?.textContent ?? null]);
    const loudness = () => page.text('stat-in');
    const before = loudness();
    for (const id of ['out-of-phase', 'quieter-channel']) document.querySelector<HTMLButtonElement>(`[data-fix="${id}"]`)!.click();
    await page.settle();
    await page.wait(300);
    const after = loudness();
    const fixed = findings().filter((f) => f.classList.contains('fixed')).length;
    page.click('export-all');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    document.querySelector<HTMLButtonElement>('[data-format=wav]')!.click();
    page.click('export-go');
    await page.until(() => /^Export/.test(page.text('export-status')), 'the export to finish', 60_000);
    // Undo takes the fixes back, one change at a time.
    page.click('undo');
    await page.wait(200);
    const undone = findings().filter((f) => f.classList.contains('fixed')).length;
    page.click('redo');
    await page.settle();
    return { offered, before, after, fixed, undone };
  });
  assert.deepEqual(seen.offered, [
    ['One channel is out of phase with the other', 'Flip one channel'],
    ['The right channel is 6.0 dB quieter throughout', 'Even them out'],
  ]);
  assert.equal(seen.fixed, 2);
  assert.ok(seen.undone < 2, 'undone');
  // Raising the quieter side by 6 dB adds 2 dB to the loudness: the energy from 1.25 to 2.
  const lufs = (text: string) => Number(text.replace('−', '-').match(/-?[\d.]+/)![0]);
  assert.ok(Math.abs(lufs(seen.after) - lufs(seen.before) - 2.04) < 0.2, `${seen.before} became ${seen.after}`);

  // The export: both channels alike, and in step again.
  const [file] = await readdir(out);
  // The phase a second at a time: per block of the decoder, an older ffmpeg (the bundled 6.0) prints megabytes,
  // past what spawnSync keeps, and the channels' levels at the end were lost.
  const report = spawnSync(ffmpeg(), ['-hide_banner', '-nostats', '-i', join(out, file), '-af', 'astats=measure_overall=none:measure_perchannel=RMS_level,asetnsamples=n=44100,aphasemeter=video=0,ametadata=print:key=lavfi.aphasemeter.phase', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).stderr;
  const rms = [...report.matchAll(/RMS level dB: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  const phases = [...report.matchAll(/lavfi\.aphasemeter\.phase=(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const phase = phases.reduce((sum, p) => sum + p, 0) / phases.length;
  assert.ok(Math.abs(rms[0] - rms[1]) < 0.5, `the channels alike: ${rms}`);
  assert.ok(phase > 0.9, `in step: ${phase}`);

  // Kept with the recording.
  const again = await runApp({ recording: faulty, data }, () => [...document.querySelectorAll('#checkup-findings .finding.fixed')].length);
  assert.equal(again, 2);
});

test('a silent channel is filled from the other, and the recording measures 3 dB louder for it', { skip }, async () => {
  const oneSided = join(work, 'One sided.wav');
  execFileSync(ffmpeg(), ['-v', 'error', '-y', '-i', mix, '-af', 'pan=stereo|c0=0*c0|c1=c1', '-c:a', 'pcm_s16le', oneSided]);
  const seen = await runApp({ recording: oneSided, data: await fresh(), timeoutMs: 60_000 }, async (page) => {
    const finding = document.querySelector('#checkup-findings .finding')!;
    const offered = [finding.querySelector('b')!.textContent, finding.querySelector('[data-fix]')!.textContent];
    const before = page.text('stat-in');
    document.querySelector<HTMLButtonElement>('[data-fix="dead-channel"]')!.click();
    await page.wait(400);
    return { offered, before, after: page.text('stat-in') };
  });
  assert.deepEqual(seen.offered, ['The left channel is silent', 'Fill it from the other']);
  const lufs = (text: string) => Number(text.replace('−', '-').match(/-?[\d.]+/)![0]);
  assert.ok(Math.abs(lufs(seen.after) - lufs(seen.before) - 3.0) < 0.15, `${seen.before} became ${seen.after}`);
});

test('the strip under the picture shows the mix and moves the playhead', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    page.click('view-video');
    const strip = page.element<HTMLCanvasElement>('mix-strip');
    await page.until(() => strip.dataset.seconds !== undefined, 'the strip to be drawn');
    const box = strip.getBoundingClientRect();
    strip.dispatchEvent(new MouseEvent('mousedown', { clientX: box.left + box.width / 2, clientY: box.top + 10, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: box.left + box.width * 0.75, clientY: box.top + 10, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await page.wait(100);
    return { height: Math.round(box.height), playhead: page.playhead() };
  });
  assert.equal(seen.height, 48);
  assert.ok(Math.abs(seen.playhead - MIX_SECONDS * 0.75) <= 1, `dragged to ${seen.playhead}`);
});

test('Export all makes MP4 videos of the mixes, and a cancelled one leaves nothing behind', { skip }, async () => {
  const folder = join(work, 'videos');
  await mkdir(folder);
  // Two mixes of ten seconds each, given a template and a name in the Video view.
  const message = await runApp({ recording: mix, data: await fresh(), exportFolder: folder, timeoutMs: 120_000 }, async (page) => {
    page.key('Enter');
    for (let i = 0; i < 4; i++) page.key('ArrowRight');
    await page.wait(100);
    page.key('KeyO');
    await page.wait(100);
    // Two tracks in the first mix, which become its chapters.
    page.key('Enter');
    page.key('KeyM');
    page.key('ArrowRight');
    page.key('KeyM');
    page.key('Enter');
    for (let i = 0; i < 2; i++) page.key('ArrowRight');
    await page.wait(100);
    page.click('split-here');
    await page.settle();
    page.click('view-video');
    const template = page.element<HTMLSelectElement>('template');
    template.value = 'ring';
    template.dispatchEvent(new Event('change'));
    page.type('mix-artist', 'Suva');
    await page.settle();
    page.click('export-all');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    document.querySelector<HTMLButtonElement>('[data-format=mp4]')!.click();
    page.click('export-go');
    await page.until(() => /^Export/.test(page.text('export-status')), 'the export to finish', 100_000);
    return page.text('export-status');
  });
  assert.match(message, /^Exported 2 mixes\./);
  const files = (await readdir(folder)).sort();
  assert.deepEqual(files, ['Test mix - 01 Mix 1.mp4', 'Test mix - 02 Mix 2.mp4']);
  for (const file of files) {
    // ffmpeg describes a file it is given nothing to do with.
    let described = '';
    try {
      execFileSync(ffmpeg(), ['-hide_banner', '-i', join(folder, file)], { stdio: 'pipe' });
    } catch (error) {
      described = String((error as { stderr: Buffer }).stderr);
    }
    assert.match(described, /Duration: 00:00:10\.00/, `${file} is ten seconds long`);
    assert.match(described, /Video: h264.*1920x1080.*30 fps/, `${file} has its picture`);
    if (file.includes('Mix 1')) {
      assert.match(described, /Chapter #0:0: start 0\.0+, end 5\.0+[\s\S]*title\s*: Track 1/, 'the first track is a chapter');
      assert.match(described, /Chapter #0:1: start 5\.0+, end 10\.0+[\s\S]*title\s*: Track 2/, 'and so is the second');
    }
    assert.match(described, /Audio: aac/, `${file} has its sound`);
    assert.match(described, /title\s*: Test mix - Mix/, `${file} keeps its tags`);
  }

  // A longer one, stopped part way: no file is left.
  const stopped = join(work, 'stopped');
  await mkdir(stopped);
  const said = await runApp({ recording: mix, data: await fresh(), exportFolder: stopped, timeoutMs: 180_000 }, async (page) => {
    page.key('Enter');
    for (let i = 0; i < 8; i++) page.key('ArrowRight', { shift: true });
    await page.wait(100);
    page.click('split-here');
    await page.settle();
    page.click('export-all');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    document.querySelector<HTMLButtonElement>('[data-format=mp4]')!.click();
    page.click('export-go');
    // Into the picture, past the sound, which is the first tenth. Only just: a machine
    // without a graphics card, as GitHub's Windows one, draws the picture slowly.
    await page.until(() => parseFloat(page.element('progress-bar').style.width) > 12, 'the picture to be under way', 120_000);
    page.key('Escape', { key: 'Escape' });
    await page.until(() => /cancelled/.test(page.text('export-status')), 'the export to stop');
    await page.wait(500);
    return page.text('export-status');
  });
  assert.match(said, /cancelled/);
  assert.deepEqual(await readdir(stopped), [], 'nothing is left of the cancelled video');
});

test('the artist can be typed in the Video view while the mix plays, and undone', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh(), timeoutMs: 90_000 }, async (page) => {
    page.click('view-video');
    page.key('Space');
    await page.until(() => page.element('play').classList.contains('playing'), 'playback to start');
    const name = page.element<HTMLInputElement>('mix-artist');
    name.focus();
    for (const typed of ['S', 'Su', 'Suv', 'Suva']) {
      name.value = typed;
      name.dispatchEvent(new Event('input', { bubbles: true }));
      await page.wait(300);
    }
    await page.wait(1000);
    const kept = { focused: document.activeElement === name, value: name.value };
    name.blur();
    page.key('Space');
    await page.settle();
    page.click('undo');
    await page.wait(200);
    return { kept, undone: page.element<HTMLInputElement>('mix-artist').value };
  });
  assert.deepEqual(seen.kept, { focused: true, value: 'Suva' });
  assert.equal(seen.undone, '', 'undo takes the typing back');
});

test('a last recording that is gone gives an empty start, without a word', { skip }, async () => {
  const data = await fresh();
  const gone = join(work, 'Gone.wav');
  await writeFile(join(data, 'last-recording.json'), JSON.stringify({ path: gone }));
  await writeFile(join(data, 'recent-recordings.json'), JSON.stringify([gone, mix]));
  const shown = await runApp({ data }, async (page) => {
    await page.until(() => !page.element('recent').hidden, 'the recent recordings to be listed');
    return {
      startScreen: !page.element('empty').hidden && page.element('views').hidden,
      name: page.text('file-name'),
      message: page.text('export-status'),
      recent: [...document.querySelectorAll('.recent-item .name')].map((item) => item.textContent),
      settingsUsable: !page.element('settings').inert,
    };
  });
  assert.ok(shown.startScreen);
  assert.equal(shown.name, 'No recording open');
  assert.equal(shown.message, '');
  assert.deepEqual(shown.recent, ['Test mix.wav'], 'a recording that is not there is left off the list');
  assert.ok(!shown.settingsUsable);
});

test('a recording can be closed, and opened again from the start screen', { skip }, async () => {
  const data = await fresh();
  const seen = await runApp({ recording: mix, data, menu: 'close' }, async (page) => {
    await page.until(() => !page.element('empty').hidden, 'the start screen');
    await page.until(() => !page.element('recent').hidden, 'the recent recordings to be listed');
    const closed = {
      name: page.text('file-name'),
      canPlay: !page.element<HTMLButtonElement>('play').disabled,
      canExport: !page.element<HTMLButtonElement>('export').disabled,
      settingsUsable: !page.element('settings').inert,
      recent: [...document.querySelectorAll('.recent-item .name')].map((item) => item.textContent),
    };
    document.querySelector<HTMLButtonElement>('.recent-item')!.click();
    await page.until(() => !page.element('views').hidden, 'the recording to open again');
    return { closed, reopened: page.text('file-name'), settingsUsable: !page.element('settings').inert };
  });
  assert.deepEqual(seen.closed, {
    name: 'No recording open', canPlay: false, canExport: false, settingsUsable: false, recent: ['Test mix.wav'],
  });
  assert.equal(seen.reopened, 'Test mix.wav');
  assert.ok(seen.settingsUsable);

  // Closed by hand means: do not bring it back at the next start.
  const next = await runApp({ recording: mix, data, menu: 'close' }, () => null).then(() =>
    runApp({ data }, (page) => page.text('file-name')),
  );
  assert.equal(next, 'No recording open');
});

test('the keys move the playhead, switch what is heard and show the help', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    const at: Record<string, number> = {};
    const press = async (name: string, code: string, options?: { shift?: boolean; alt?: boolean }) => {
      page.key(code, options);
      await page.wait(60);
      at[name] = page.playhead();
    };
    await press('return', 'Enter');
    await press('right', 'ArrowRight');
    await press('shiftRight', 'ArrowRight', { shift: true });
    await press('optionRight', 'ArrowRight', { alt: true });
    await press('left', 'ArrowLeft');
    await press('end', 'End');
    await press('returnAgain', 'Enter');

    page.key('KeyA');
    const original = page.element('bypass').classList.contains('on') && !page.element('bypass-note').hidden;
    page.key('KeyA');
    const levelled = !page.element('bypass').classList.contains('on') && page.element('bypass-note').hidden;

    // Typing in a field must not set the shortcuts off.
    const name = page.element<HTMLInputElement>('mix-name');
    name.focus();
    name.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backspace', key: 'Backspace', bubbles: true }));
    name.dispatchEvent(new KeyboardEvent('keydown', { code: 'End', key: 'End', bubbles: true }));
    name.blur();
    const afterTyping = page.playhead();

    page.key('Slash', { key: '?', shift: true });
    return { at, original, levelled, afterTyping, help: page.element<HTMLDialogElement>('help-dialog').open };
  });
  assert.deepEqual(seen.at, { return: 0, right: 5, shiftRight: 35, optionRight: 36, left: 31, end: 530, returnAgain: 0 });
  assert.ok(seen.original && seen.levelled);
  assert.equal(seen.afterTyping, 0);
  assert.ok(seen.help);
});

test('I and O put the start and the end of the mix at the playhead', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    const region = () => [page.region().start, page.region().end];
    page.key('Enter');
    for (let i = 0; i < 2; i++) page.key('ArrowRight', { shift: true });
    await page.wait(60);
    page.key('KeyI');
    await page.wait(60);
    const afterIn = region();

    for (let i = 0; i < 4; i++) page.key('ArrowRight', { shift: true });
    await page.wait(60);
    // The button does what the key does.
    page.click('mark-end');
    await page.wait(60);
    const afterOut = region();

    // Five seconds after the start is too close for an end.
    page.key('Enter');
    page.key('ArrowRight');
    await page.wait(60);
    page.key('KeyO');
    await page.wait(60);
    const refused = { region: region(), said: page.text('readout') };

    await page.settle();
    page.click('undo');
    await page.settle();
    return { afterIn, afterOut, refused, afterUndo: region(), length: page.region().length };
  });
  assert.deepEqual(seen.afterIn, ['0:01:00', '0:09:00']);
  assert.deepEqual(seen.afterOut, ['0:01:00', '0:03:00']);
  assert.deepEqual(seen.refused.region, ['0:01:00', '0:03:00']);
  assert.match(seen.refused.said, /at least 10 seconds/);
  assert.deepEqual(seen.afterUndo, ['0:00:00', '0:09:00'], 'the two marks made in one go undo together');
});

test('a double click on a free part of the recording fills it with a mix', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    // Free the first and the last minutes by trimming the only mix.
    page.key('Enter');
    for (let i = 0; i < 4; i++) page.key('ArrowRight', { shift: true });
    await page.wait(60);
    page.key('KeyI');
    for (let i = 0; i < 6; i++) page.key('ArrowRight', { shift: true });
    await page.wait(60);
    page.key('KeyO');
    await page.settle();

    const overview = page.element('overview');
    const box = overview.getBoundingClientRect();
    const doubleClick = (share: number) =>
      overview.dispatchEvent(new MouseEvent('dblclick', { clientX: box.left + box.width * share, clientY: box.top + 20, bubbles: true }));

    doubleClick(0.5);
    await page.wait(100);
    const onAMix = page.tabs().length;
    doubleClick(0.9);
    await page.wait(100);
    const region = [page.region().start, page.region().end];
    doubleClick(0.9);
    await page.wait(100);
    return { onAMix, tabs: page.tabs(), region };
  });
  assert.equal(seen.onAMix, 1, 'a double click on a mix adds nothing');
  assert.equal(seen.tabs.length, 2, 'and a second one on the new mix adds nothing more');
  assert.deepEqual(seen.region, ['0:05:00', '0:09:00']);
});

test('J, K and L run the playhead backwards, stop it, and run it forwards at speed', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    const playing = () => page.element('play').classList.contains('playing');
    // How many seconds of the mix pass per second, once the playhead is under
    // way: a slow machine takes its time to start, which must not count.
    const speed = async (direction: 1 | -1) => {
      const from = page.playhead();
      await page.until(() => (page.playhead() - from) * direction >= 1, 'the playhead to get under way');
      const start = { at: page.playhead(), time: performance.now() };
      await page.until(() => (page.playhead() - start.at) * direction >= 6, 'the playhead to run on');
      return (Math.abs(page.playhead() - start.at) * 1000) / (performance.now() - start.time);
    };
    page.key('Enter');
    for (let i = 0; i < 4; i++) page.key('ArrowRight', { shift: true });
    await page.wait(100);

    // Three presses at once, from standing still, as a hand would do it.
    page.key('KeyL');
    const once = page.text('shuttle');
    page.key('KeyL');
    page.key('KeyL');
    await page.until(playing, 'L to start playback');
    const thrice = page.text('shuttle');
    const rate = page.element('shuttle').dataset.rate;
    const forwards = await speed(1);

    page.key('KeyK');
    await page.until(() => !playing(), 'K to stop playback');
    const stopped = { shown: page.text('shuttle'), at: page.playhead() };
    await page.wait(300);
    const stillThere = page.playhead() === stopped.at;

    page.key('KeyJ');
    page.key('KeyJ');
    page.key('KeyJ');
    const back = page.text('shuttle');
    const backwards = await speed(-1);
    const soundless = !playing();

    page.key('KeyL');
    await page.until(playing, 'L to turn it round');
    const turned = page.text('shuttle');
    page.key('Space');
    await page.until(() => !playing(), 'Space to stop it');
    return {
      once, thrice, rate, forwards, stopped: stopped.shown, stillThere, back, backwards, soundless, turned,
      after: page.text('shuttle'), message: page.text('export-status'),
    };
  });
  assert.equal(seen.once, '', 'one press of L is ordinary playback');
  assert.equal(seen.thrice, '4×');
  assert.equal(seen.rate, '4', 'the player is asked for four times the speed');
  // How fast it then really goes depends on the machine: GitHub's Mac manages
  // one and a half times. That it moves on, and no faster than asked, is what is checked.
  assert.ok(seen.forwards > 0.3 && seen.forwards < 6, `ran forwards at ${seen.forwards.toFixed(1)}× instead of 4×`);
  assert.equal(seen.stopped, '');
  assert.ok(seen.stillThere);
  assert.equal(seen.back, '◀ 4×');
  assert.ok(seen.backwards > 1.5 && seen.backwards < 6, `ran backwards at ${seen.backwards.toFixed(1)}× instead of 4×`);
  assert.ok(seen.soundless, 'nothing plays while running backwards');
  assert.equal(seen.turned, '', 'L after J plays forwards at the ordinary speed');
  assert.equal(seen.after, '');
  assert.equal(seen.message, '', 'no complaint about playback');
});

test('zoomed in close, the waveform is drawn from the wave itself', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    const detail = page.element('detail');
    await page.until(() => detail.dataset.wave === 'blocks', 'the whole mix to be drawn from the analysis');
    for (let i = 0; i < 14; i++) {
      page.click('zoom-in');
      await page.wait(20);
    }
    await page.until(() => detail.dataset.wave === 'fine', 'the wave to arrive');
    // Stepping on stays fine: the next stretch has been fetched ahead.
    // (A pause before each look: the picture is redrawn a moment after the key.)
    for (let i = 0; i < 3; i++) page.key('ArrowRight', { shift: true });
    await page.wait(150);
    await page.until(() => detail.dataset.wave === 'fine', 'the wave further on');
    // Marking the start of the mix here must not throw the view back out,
    // and neither must cutting it further on.
    // Thrown out to the whole mix, the view would never be fine again and the wait would fail.
    page.key('KeyI');
    await page.wait(150);
    await page.until(() => detail.dataset.wave === 'fine', 'the view to stay close after marking the start');
    const afterMark = { wave: detail.dataset.wave, start: page.region().start };
    page.key('ArrowRight', { shift: true });
    await page.wait(150);
    page.click('split-here');
    await page.wait(150);
    await page.until(() => detail.dataset.wave === 'fine', 'the view to stay close after the split');
    Object.assign(afterMark, { afterSplit: detail.dataset.wave, mixes: page.tabs().length });
    page.click('zoom-fit');
    await page.until(() => detail.dataset.wave === 'blocks', 'the whole mix again');
    return afterMark;
  });
  assert.deepEqual(seen, { wave: 'fine', start: '0:01:30', afterSplit: 'fine', mixes: 2 });
});

test('edges and cuts land on the playhead to the millisecond, and so does the export', { skip }, async () => {
  const exportFolder = join(work, 'exact');
  await mkdir(exportFolder);
  const seen = await runApp({ recording: mix, data: await fresh(), exportFolder, timeoutMs: 120_000 }, async (page) => {
    const playing = () => page.element('play').classList.contains('playing');
    const field = (id: 'start' | 'end') => page.region()[id];
    page.key('Enter');
    for (let i = 0; i < 2; i++) page.key('ArrowRight', { shift: true });
    // Stop playback wherever it happens to be and start the mix there; again
    // in the rare case that it stopped on a whole tenth of a second.
    do {
      page.key('Space');
      await page.until(playing, 'playback to start');
      await page.wait(350);
      page.key('Space');
      await page.until(() => !playing(), 'playback to stop');
      page.key('KeyI');
      await page.wait(100);
    } while (!/\.\d\d/.test(field('start')));

    // A minute on, cut. The first piece is then a minute long exactly.
    for (let i = 0; i < 2; i++) page.key('ArrowRight', { shift: true });
    await page.wait(100);
    page.click('split-here');
    await page.settle();
    const first = { start: field('start'), end: field('end'), length: page.region().length };
    document.querySelectorAll<HTMLElement>('.mix-tab')[1].click();
    await page.wait(100);
    const second = { start: field('start'), end: field('end') };

    page.click('export-all');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    page.click('export-go');
    await page.until(() => page.text('export-status').startsWith('Exported'), 'the export to finish', 90_000);
    return { first, second };
  });
  const seconds = (time: string) => time.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  assert.match(seen.first.start, /^0:01:0\d\.\d+$/, 'the start is kept to a fraction of a second');
  assert.equal(seen.first.length, '0:01:00');
  assert.equal(seen.second.start, seen.first.end, 'the second piece starts exactly where the first ends');
  assert.equal(seen.second.end, '0:09:00');

  const [one, two] = (await readdir(exportFolder)).sort();
  const lengths = [(await probe(join(exportFolder, one))).duration, (await probe(join(exportFolder, two))).duration];
  // The length of a file is read to a hundredth of a second.
  assert.ok(Math.abs(lengths[0] - 60) < 0.011, `the first file is ${lengths[0]} s long`);
  const rest = MIX_SECONDS - seconds(seen.first.end);
  assert.ok(Math.abs(lengths[1] - rest) < 0.011, `the second file is ${lengths[1]} s long, not ${rest}`);
});

test('playing moves the playhead and lights the meter', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    const meter = page.element('level-meter');
    page.key('Space');
    await page.until(() => page.element('play').classList.contains('playing'), 'playback to start');
    await page.until(() => page.playhead() >= 1 && !!meter.dataset.peak, 'the playhead to move and the meter to light');
    const playing = { peak: Number(meter.dataset.peak), figures: meter.dataset.figures ?? '' };
    page.key('Space');
    await page.until(() => !page.element('play').classList.contains('playing'), 'playback to stop');
    const stoppedAt = page.playhead();
    await page.wait(400);
    return { playing, stoppedAt, later: page.playhead() };
  });
  // The loudest track peaks around -6 dBFS and is turned down a little.
  assert.ok(seen.playing.peak > -30 && seen.playing.peak <= 0, `peak was ${seen.playing.peak}`);
  assert.match(seen.playing.figures, /^LUFS −\d+\.\d, gain [+−]\d+\.\d$/);
  assert.equal(seen.later, seen.stoppedAt, 'the playhead holds still once paused');
});

test('Export all writes each mix, levelled and under the ceiling', { skip }, async () => {
  const exportFolder = join(work, 'exports');
  const message = await runApp({ recording: night, data: await fresh(), exportFolder, timeoutMs: 120_000 }, async (page) => {
    await page.until(() => !page.element<HTMLButtonElement>('split-gaps').disabled, 'Split at gaps to be offered');
    page.click('split-gaps');
    await page.settle();
    page.click('export-all');
    await page.until(() => page.element<HTMLDialogElement>('export-dialog').open, 'the export dialog');
    page.click('export-go');
    await page.until(() => page.text('export-status').startsWith('Exported'), 'the export to finish', 90_000);
    return page.text('export-status');
  });
  assert.match(message, /^Exported 2 mixes\./);

  const files = (await readdir(exportFolder)).sort();
  assert.deepEqual(files, ['Two sets - 01 Mix 1.wav', 'Two sets - 02 Mix 2.wav']);
  for (const file of files) {
    const exported = await measure(join(exportFolder, file));
    assert.ok(Math.abs(exported.shortTerm.length * HOP_SECONDS - MIX_SECONDS) < 5, 'about nine minutes long');
    assert.ok(exported.peak <= Math.pow(10, -1 / 20) + 0.01, `peak ${exported.peak} is over the ceiling`);
    // Loudness in the full-energy part of each track, half a minute in.
    const tracks = TRACK_LEVELS_DB.map((_, track) => exported.shortTerm[Math.round((track * TRACK_SECONDS + 30) / HOP_SECONDS)]);
    const spread = Math.max(...tracks) - Math.min(...tracks);
    assert.ok(spread < 2, `tracks that were 10 dB apart are still ${spread.toFixed(1)} dB apart`);
  }
});

test('keys typed into the layer search are letters, not the window\'s shortcuts', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh(), timeoutMs: 60_000 }, async (page) => {
    page.click('view-video');
    page.choose('template', 'ring');
    await page.wait(100);
    page.click('template-edit');
    await page.until(() => document.body.classList.contains('editing'), 'the editor to open');
    page.click('editor-add');
    const search = document.activeElement as HTMLInputElement;
    // A for bypass, Space for play, as a key press in the box sends them.
    for (const [code, key] of [['KeyA', 'a'], ['Space', ' ']]) {
      search.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true }));
    }
    await page.wait(100);
    return {
      searching: search.type,
      bypassed: page.element('bypass').classList.contains('on'),
      playing: page.element('play').classList.contains('playing'),
    };
  });
  assert.deepEqual(seen, { searching: 'search', bypassed: false, playing: false });
});
