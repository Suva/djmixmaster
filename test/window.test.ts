// Tests of the window: each starts the real app, drives it as a user would
// and looks at what it shows or writes. See window-app.ts for how, and
// AGENTS.md for the check mode this rests on. They need the app built
// (`npm test` does that first) and are skipped where Electron is not installed.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ffmpeg } from '../src/audio-io.ts';
import { HOP_SECONDS } from '../src/loudness.ts';
import { measure } from '../src/master.ts';
import { TRACK_LEVELS_DB, TRACK_SECONDS, writeSyntheticMix } from './synthetic-mix.ts';
import { dataFolder, electronPath, runApp, workFolder } from './window-app.ts';

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
      length: page.text('region-length'),
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

test('a mix can be split, deleted with Backspace, and both undone', { skip }, async () => {
  const seen = await runApp({ recording: mix, data: await fresh() }, async (page) => {
    await page.settle();
    // Deleting the only mix takes away what was marked: it covers everything again.
    page.key('Enter');
    for (let i = 0; i < 2; i++) page.key('ArrowRight', { shift: true });
    await page.wait(100);
    page.key('KeyI');
    await page.wait(100);
    const trimmed = page.text('region-length');
    page.key('Backspace');
    await page.wait(100);
    const afterDeletingTheOnlyMix = { tabs: page.tabs().length, length: page.text('region-length'), trimmed };

    page.key('Enter');
    for (let i = 0; i < 6; i++) page.key('ArrowRight', { shift: true });
    await page.wait(100);
    // Control+E, as on Windows; the app takes Command the same way.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', ctrlKey: true, bubbles: true }));
    await page.settle();
    const afterSplit = page.tabs();

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
    return { afterDeletingTheOnlyMix, afterSplit, afterDelete, message, afterUndo, afterSecondUndo, afterRedo: page.tabs() };
  });
  assert.deepEqual(seen.afterDeletingTheOnlyMix, { tabs: 1, length: '0:09:00', trimmed: '0:08:00' });
  assert.equal(seen.afterSplit.length, 2);
  assert.match(seen.afterSplit[0], /0:03:00/);
  assert.match(seen.afterSplit[1], /0:06:00/);
  assert.equal(seen.afterDelete.length, 1);
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
  });
  // No recording is named this time: the app is started as from the Dock.
  const back = await runApp({ data }, (page) => ({
    name: page.text('file-name'),
    tabs: page.tabs(),
    cut: page.text('cut-value'),
    message: page.text('export-status'),
    undo: !page.element<HTMLButtonElement>('undo').disabled,
  }));
  assert.equal(back.name, 'Test mix.wav');
  assert.equal(back.tabs.length, 2);
  assert.match(back.tabs[0], /Warm-up/);
  assert.match(back.cut, /6\.0 dB/);
  assert.equal(back.message, 'Picked up where you left off.');
  assert.ok(!back.undo, 'undo does not reach into an earlier session');
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
    const original = page.element('hear-original').classList.contains('on');
    page.key('KeyA');
    const levelled = page.element('hear-levelled').classList.contains('on');

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
    const region = () => [page.element<HTMLInputElement>('region-start').value, page.element<HTMLInputElement>('region-end').value];
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
    return { afterIn, afterOut, refused, afterUndo: region(), length: page.text('region-length') };
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
    const region = [page.element<HTMLInputElement>('region-start').value, page.element<HTMLInputElement>('region-end').value];
    doubleClick(0.9);
    await page.wait(100);
    return { onAMix, tabs: page.tabs(), region };
  });
  assert.equal(seen.onAMix, 1, 'a double click on a mix adds nothing');
  assert.equal(seen.tabs.length, 2, 'and a second one on the new mix adds nothing more');
  assert.deepEqual(seen.region, ['0:05:00', '0:09:00']);
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
