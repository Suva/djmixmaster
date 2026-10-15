import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chaptersOf, parseTime, parseTracklist, splitName, trackAt, youtubeList } from '../src/tracks.ts';

test('a Rekordbox playlist gives the names, in order, without times', () => {
  const m3u8 = [
    '#EXTM3U',
    '#EXTINF:439,Six Ou Sept - Big Brother is Raving You',
    '/Volumes/Music/Six Ou Sept - Big Brother is Raving You.mp3',
    '#EXTINF:525,ChôKô - Power Portal',
    '/Volumes/Music/ChôKô - CC ATOM 202 - 02 Power Portal.flac',
  ].join('\n');
  assert.deepEqual(parseTracklist(m3u8), [
    { name: 'Six Ou Sept - Big Brother is Raving You', at: null },
    { name: 'ChôKô - Power Portal', at: null },
  ]);
});

test('a table with Artist and Track Title columns gives the two joined', () => {
  const table = '﻿#\tArtwork\tArtist\tTrack Title\tBPM\tTime\r\n1\t\tCult Collective\tThe Others - Vimana\t164.00\t11:54\r\n2\t\tEnko\tVariscan\t155.00\t07:16\r\n';
  assert.deepEqual(parseTracklist(table), [
    { name: 'Cult Collective - The Others - Vimana', at: null },
    { name: 'Enko - Variscan', at: null },
  ]);
});

test('a typed list may have numbers and times in front or behind', () => {
  assert.deepEqual(parseTracklist('0:00 Intro\n03:15 - Six Ou Sept - Big Brother\n1:02:03.5 Last one\n4. Name only\nSomething (12:30)\n01. [5:00] A - B\n\n'), [
    { name: 'Intro', at: 0 },
    { name: 'Six Ou Sept - Big Brother', at: 195 },
    { name: 'Last one', at: 3723.5 },
    { name: 'Name only', at: null },
    { name: 'Something', at: 750 },
    { name: 'A - B', at: 300 },
  ]);
  assert.equal(parseTime('1:75'), null);
  assert.equal(parseTime('1:60:00'), null);
});

test('a name splits into artist and title at the first dash', () => {
  assert.deepEqual(splitName('Cult Collective - The Others - Vimana'), { artist: 'Cult Collective', title: 'The Others - Vimana' });
  assert.deepEqual(splitName('Untitled'), { artist: '', title: 'Untitled' });
});

test('the first chapter starts with the mix, the list is ready for YouTube, and says what YouTube will not take', () => {
  const tracks = [{ at: 4, name: 'A - One' }, { at: 300, name: '' }, { at: 3725, name: 'C - Three' }];
  assert.deepEqual(chaptersOf(tracks, 4000).map((chapter) => [chapter.start, chapter.end, chapter.title]), [
    [0, 300, 'A - One'], [300, 3725, 'Track 2'], [3725, 4000, 'C - Three'],
  ]);
  assert.deepEqual(youtubeList(tracks, 4000), { text: '0:00 A - One\n5:00 Track 2\n1:02:05 C - Three', problems: [] });
  const short = youtubeList([{ at: 0, name: 'A' }, { at: 5, name: 'B' }], 100).problems;
  assert.equal(short.length, 2);
});

test('what is playing: the first track until the second starts', () => {
  const tracks = [{ at: 10, name: 'A' }, { at: 20, name: 'B' }];
  assert.equal(trackAt(tracks, 0)?.track.name, 'A');
  assert.equal(trackAt(tracks, 20)?.index, 1);
  assert.equal(trackAt(tracks, 15)?.next?.name, 'B');
  assert.equal(trackAt([], 5), null);
});
