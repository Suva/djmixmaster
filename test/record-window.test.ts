// Tests of recording in the window. In check mode the only device is a
// generated test signal, a tone on each side at levels of their own (the left
// at half of full scale, the right at a quarter), so that a recording can be
// made, and its channels told apart, anywhere. Parts are made two seconds
// long. See window.test.ts for how these run.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ffmpeg } from '../src/audio-io.ts';
import { TEST_SIGNAL, writerArgs } from '../src/app/recording.ts';
import { dataFolder, electronPath, runApp, workFolder } from './window-app.ts';

const skip = process.env.DJMASTER_SKIP_WINDOW_TESTS
  ? 'DJMASTER_SKIP_WINDOW_TESTS is set'
  : electronPath() ? false : 'Electron is not installed here';

let work: string;
const PARTS = { DJMASTER_PART_SECONDS: '2' };
/** The capture helper, built with the app where there is a C compiler (scripts/build.mjs). */
const HELPER = join('native/capture/build', process.platform === 'win32' ? 'djm-capture.exe' : 'djm-capture');
const noHelper = skip || (existsSync(HELPER) ? false : 'The capture helper is not built here');

before(async () => {
  if (!skip) work = await workFolder();
});

after(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

/** The peak of each channel of a file, in dBFS. */
function peaks(file: string): number[] {
  const report = spawnSync(ffmpeg(), ['-hide_banner', '-nostats', '-i', file, '-af', 'astats=measure_overall=none:measure_perchannel=Peak_level', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return [...report.matchAll(/Peak level dB: (-?[\d.]+)/g)].map((m) => Number(m[1]));
}

/** Seconds in a file: the sound it holds, read to the end. */
function duration(file: string): number {
  const report = spawnSync(ffmpeg(), ['-hide_banner', '-nostats', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const times = [...report.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].at(-1)!;
  return Number(times[1]) * 3600 + Number(times[2]) * 60 + Number(times[3]);
}

test('the input is heard as soon as it is chosen, recorded only from Start, and opened when stopped', { skip }, async () => {
  const folder = join(work, 'recorded');
  await mkdir(folder);
  const data = await dataFolder(work);
  const seen = await runApp({ data, exportFolder: folder, env: PARTS, timeoutMs: 60_000 }, async (page) => {
    page.click('view-record');
    await page.until(() => page.text('record-device-note').includes('channels'), 'the device to be opened');
    // Chromium's test signal, as where there is no helper; the helper's own comes first when there is one.
    page.choose('record-device', 'Test signal');
    await page.until(() => page.text('record-device-note') === '2 channels, 48 kHz.', 'the test signal to be opened');
    const note = page.text('record-device-note');
    const meter = page.element('record-meter');
    await page.until(() => Boolean(meter.dataset.level), 'the level to show before recording');
    const monitoring = { state: page.text('record-state'), level: meter.dataset.level, clipped: meter.dataset.clipped };
    // The right channel alone, on both sides: the meters follow at once.
    page.choose('record-channels', '1,1');
    await page.wait(600);
    const right = meter.dataset.level;
    page.click('record-folder-change');
    await page.wait(200);
    page.type('record-name', 'Test night');
    await page.wait(1500);
    const before = await window.api.recordSetup().then((setup) => setup.status.state);
    page.click('record-go');
    await page.until(() => page.text('record-state').startsWith('Recording'), 'the recording to start');
    await page.until(() => page.text('record-written').includes('parts'), 'a second part', 10_000);
    const indicatorInView = page.element('record-indicator').hidden;
    // Elsewhere, the bar at the bottom says it goes on.
    page.click('view-mastering');
    await page.wait(1200);
    const indicator = { hidden: page.element('record-indicator').hidden, text: page.text('record-indicator') };
    page.click('record-indicator');
    await page.wait(200);
    page.click('record-go');
    const asked = page.text('record-go');
    page.click('record-go');
    await page.until(() => page.text('file-name').includes('Test night'), 'the recording to open', 20_000);
    return { note, monitoring, right, before, indicatorInView, indicator, asked, file: page.text('file-name'), record: document.body.classList.contains('record') };
  });
  assert.equal(seen.note, '2 channels, 48 kHz.');
  assert.equal(seen.monitoring.state, 'Ready: set the level, then start recording');
  assert.equal(seen.monitoring.level, '-6.0,-12.0');
  assert.equal(seen.monitoring.clipped, 'false,false', 'no clip lit by a level well under full scale');
  assert.equal(seen.right, '-12.0,-12.0');
  assert.equal(seen.before, 'monitoring', 'nothing written while only listening');
  assert.ok(seen.indicatorInView, 'no indicator in the Record view itself');
  assert.equal(seen.indicator.hidden, false);
  assert.match(seen.indicator.text, /^● Recording 0:00:0\d$/);
  assert.equal(seen.asked, 'Press again to stop');
  assert.equal(seen.record, false, 'Mastering shows the recording just made');
  const files = (await readdir(folder)).sort();
  assert.ok(files.length >= 2 && files.every((file, i) => file === `Test night part ${String(i + 1).padStart(3, '0')}.wav`), files.join(', '));
  assert.match(seen.file, new RegExp(`^Test night part 00\\*\\.wav \\(${files.length} files\\)$`));
  // Every moment of it: two seconds of sound in the first part, nothing dropped.
  assert.ok(Math.abs(duration(join(folder, files[0])) - 2) < 0.05, `the first part is ${duration(join(folder, files[0]))} s`);
  const [left, right] = peaks(join(folder, files[0]));
  assert.ok(Math.abs(left - -12.04) < 0.2 && Math.abs(right - -12.04) < 0.2, `peaks ${left}, ${right}`);
  const preferences = JSON.parse(readFileSync(join(data, 'preferences.json'), 'utf8'));
  assert.deepEqual(preferences.recording, { device: TEST_SIGNAL, channels: [1, 1], format: 'wav', folder });
});

test('coming back to the Record view shows the input in use, and a stereo input starts on its channels 1 and 2', { skip }, async () => {
  const folder = join(work, 'back again');
  await mkdir(folder);
  const seen = await runApp({ data: await dataFolder(work), exportFolder: folder, env: PARTS, timeoutMs: 60_000 }, async (page) => {
    const shown = () => ({ device: page.element<HTMLSelectElement>('record-device').value, channels: page.element<HTMLSelectElement>('record-channels').value });
    page.click('view-record');
    await page.until(() => page.text('record-device-note').includes('channels'), 'the device to be opened');
    page.choose('record-device', 'Test signal, mono');
    await page.until(() => page.text('record-device-note') === '1 channel, 48 kHz.', 'the mono device to be opened');
    const mono = shown();
    page.click('record-folder-change');
    await page.wait(200);
    page.type('record-name', 'Mic night');
    page.click('record-go');
    await page.until(() => page.text('record-state').startsWith('Recording'), 'the recording to start');
    page.click('view-mastering');
    await page.wait(500);
    page.click('view-record');
    await page.wait(800);
    const back = { ...shown(), name: page.element<HTMLInputElement>('record-name').value };
    page.click('record-go');
    page.click('record-go');
    await page.until(() => page.text('file-name').includes('Mic night'), 'the recording to open', 20_000);
    // Afterwards, a stereo device: its own two channels, not the mono one's choice.
    page.click('view-record');
    await page.wait(800);
    page.choose('record-device', 'Test signal');
    await page.until(() => page.text('record-device-note') === '2 channels, 48 kHz.', 'the stereo device to be opened');
    const stereo = shown();
    // Chosen without recording, it is still the one shown on coming back.
    page.click('view-mastering');
    await page.wait(500);
    page.click('view-record');
    await page.until(() => page.text('record-device-note') === '2 channels, 48 kHz.', 'the device to be opened again');
    return { mono, back, stereo, again: shown() };
  });
  assert.deepEqual(seen.mono, { device: 'Test signal, mono', channels: '0,0' });
  assert.deepEqual(seen.back, { device: 'Test signal, mono', channels: '0,0', name: 'Mic night' });
  assert.deepEqual(seen.stereo, { device: 'Test signal', channels: '0,1' });
  assert.deepEqual(seen.again, { device: 'Test signal', channels: '0,1' });
});

test('a FLAC recording has each part packed once it is finished, and none left as WAV', { skip }, async () => {
  const folder = join(work, 'packed');
  await mkdir(folder);
  const seen = await runApp({ data: await dataFolder(work), exportFolder: folder, env: PARTS, timeoutMs: 60_000 }, async (page) => {
    page.click('view-record');
    await page.until(() => page.text('record-device-note').includes('channels'), 'the device to be opened');
    page.click('record-folder-change');
    await page.wait(200);
    page.type('record-name', 'Packed night');
    page.click('record-format-flac');
    page.click('record-go');
    await page.until(() => page.text('record-written').includes('3 parts'), 'a third part', 15_000);
    page.click('record-go');
    page.click('record-go');
    await page.until(() => page.text('file-name').includes('Packed night'), 'the recording to open', 30_000);
    return page.text('file-name');
  });
  const files = (await readdir(folder)).sort();
  assert.ok(files.length >= 3 && files.every((file) => file.endsWith('.flac')), files.join(', '));
  assert.match(seen, /^Packed night part 00\*\.flac \(\d files\)$/);
  // Each knows its own length, which FLAC written straight through the parts would not.
  for (const file of files.slice(0, -1)) assert.ok(Math.abs(duration(join(folder, file)) - 2) < 0.05, `${file}: ${duration(join(folder, file))} s`);
});

test('a recording a crash cut short is put right and offered to be opened', { skip }, async () => {
  const folder = join(work, 'cut short');
  await mkdir(folder);
  const data = await dataFolder(work);
  // Two parts, the second left as a crash leaves it: its header still says it holds as much as a WAV can.
  const plan = { device: TEST_SIGNAL, channels: [0, 1] as [number, number], format: 'wav' as const, folder, name: 'Lost night' };
  for (const part of [1, 2]) {
    spawnSync(ffmpeg(), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-ac', '2', '-c:a', 'pcm_s24le', join(folder, `Lost night part 00${part}.wav`)]);
  }
  const broken = join(folder, 'Lost night part 002.wav');
  const bytes = readFileSync(broken);
  bytes.writeUInt32LE(0xffffffff, 4);
  bytes.writeUInt32LE(0xffffffff, bytes.indexOf('data') + 4);
  await writeFile(broken, bytes);
  // The process it names is long gone.
  await writeFile(join(data, 'recording.json'), JSON.stringify({ pid: 999_999, plan, input: { channels: 2, sampleRate: 48000 }, started: Date.now() - 60_000 }));

  const seen = await runApp({ data, timeoutMs: 40_000 }, async (page) => {
    await page.until(() => !page.element('record-interrupted').hidden, 'the cut-short recording to be offered');
    const offered = page.text('record-interrupted-text');
    page.click('record-open-interrupted');
    await page.until(() => page.text('file-name').includes('Lost night'), 'the recording to open', 20_000);
    return { offered, file: page.text('file-name') };
  });
  assert.match(seen.offered, /^“Lost night” stopped before it was ended: The app was closed while recording/);
  assert.match(seen.offered, /Its 2 parts are in/);
  assert.equal(seen.file, 'Lost night part 00*.wav (2 files)');
  assert.ok(Math.abs(duration(broken) - 2) < 0.05, 'the broken header put right');
  assert.equal(readFileSync(broken).readUInt32LE(4), bytes.length - 8);
});

test('the helper records any two channels of an input, straight into the parts', { skip: noHelper }, async () => {
  const folder = join(work, 'through the helper');
  await mkdir(folder);
  const seen = await runApp({ data: await dataFolder(work), exportFolder: folder, env: PARTS, timeoutMs: 60_000 }, async (page) => {
    page.click('view-record');
    await page.until(() => page.element<HTMLSelectElement>('record-device').options.length > 0, 'the devices to be listed');
    page.choose('record-device', 'Test interface');
    await page.until(() => page.text('record-device-note') === '4 channels, 48 kHz.', 'the test interface to be opened');
    const channels = [...page.element<HTMLSelectElement>('record-channels').options].map((option) => option.text);
    page.choose('record-channels', '2,3');
    const meter = page.element('record-meter');
    await page.until(() => meter.dataset.level === '-18.1,-24.1', 'the level of channels 3 and 4');
    page.click('record-folder-change');
    await page.wait(200);
    page.type('record-name', 'Helper night');
    page.click('record-go');
    await page.until(() => page.text('record-written').includes('parts'), 'a second part', 15_000);
    page.click('record-go');
    page.click('record-go');
    await page.until(() => page.text('file-name').includes('Helper night'), 'the recording to open', 20_000);
    return { channels, file: page.text('file-name') };
  });
  assert.deepEqual(seen.channels.slice(0, 2), ['1 and 2', '3 and 4']);
  const files = (await readdir(folder)).sort();
  assert.match(seen.file, new RegExp(`^Helper night part 00\\*\\.wav \\(${files.length} files\\)$`));
  // Channels 3 and 4 of the test interface: an eighth and a sixteenth of full scale.
  const [left, right] = peaks(join(folder, files[0]));
  assert.ok(Math.abs(left - -18.06) < 0.2 && Math.abs(right - -24.08) < 0.2, `peaks ${left}, ${right}`);
});

test('a recording the helper goes on with after the app is gone is picked up, stopped and opened', { skip: noHelper }, async () => {
  const folder = join(work, 'carried on');
  await mkdir(folder);
  const data = await dataFolder(work);
  // As an app that went down leaves it: the helper recording into ffmpeg on their own, and the lock file.
  const plan = { device: 'Test interface', channels: [0, 1] as [number, number], format: 'wav' as const, folder, name: 'Long night' };
  const helper = spawn(HELPER, ['record', '--device', 'test', '--channels', '1,2'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const writer = spawn(ffmpeg(), writerArgs(plan, 48000, 2), { detached: true, stdio: [helper.stdout!, 'ignore', 'ignore'] });
  helper.stdout!.destroy();
  helper.unref();
  writer.unref();
  await writeFile(join(data, 'recording.json'), JSON.stringify({ pid: writer.pid, helperPid: helper.pid, plan, input: { channels: 4, sampleRate: 48000 }, started: Date.now() }));
  try {
    const seen = await runApp({ data, env: PARTS, timeoutMs: 60_000 }, async (page) => {
      await page.until(() => document.body.classList.contains('record') && page.text('record-state').startsWith('Recording'), 'the recording to be shown, still going');
      const shown = { state: page.text('record-state'), problem: page.text('record-problem') };
      await page.wait(2500);
      page.click('record-go');
      page.click('record-go');
      await page.until(() => page.text('file-name').includes('Long night'), 'the recording to open', 30_000);
      return { ...shown, file: page.text('file-name') };
    });
    assert.equal(seen.state, 'Recording “Long night”');
    assert.match(seen.problem, /started before the app was last closed/);
    assert.match(seen.file, /^Long night part 00/);
    const files = (await readdir(folder)).sort();
    assert.ok(files.length >= 2, files.join(', '));
    // Ended by its input ending, ffmpeg finished every part as it should.
    for (const file of files) assert.ok(duration(join(folder, file)) > 0, file);
    for (const pid of [helper.pid!, writer.pid!]) {
      assert.throws(() => process.kill(pid, 0), `process ${pid} has stopped`);
    }
  } finally {
    for (const child of [helper, writer]) child.kill('SIGKILL');
  }
});
