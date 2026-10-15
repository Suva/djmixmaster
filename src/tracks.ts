// The tracks played in a recording: markers where each starts, with its name.
// Kept free of Node imports: the window places and draws them, the video
// shows them, and exports turn them into chapters.
//
// Track lists come from DJ software or are typed. Rekordbox exports its
// history as a playlist (M3U8) or as a table (text, tab-separated), and
// neither says when a track was played, only in what order; a list typed or
// pasted from a description often has times. `parseTracklist` reads all of these.

/** A track marker. */
export interface Track {
  /** Where the track starts, in seconds from the start of the recording. */
  at: number;
  /** "Artist - Title", or whatever was typed; may be empty. */
  name: string;
  /** Placed by spreading an imported list evenly, not by hand: probably not where the track really starts. */
  guessed?: boolean;
}

/** A track as a mix sees it: its start in seconds from the start of the mix. */
export interface MixTrack {
  at: number;
  name: string;
}

/** The artist and the title in a track's name, split at the first dash between spaces. */
export function splitName(name: string): { artist: string; title: string } {
  const match = /^(.*?)\s+[-–—]\s+(.*)$/.exec(name.trim());
  return match ? { artist: match[1].trim(), title: match[2].trim() } : { artist: '', title: name.trim() };
}

/** Seconds as a time in a track list or a video description: 4:05, or 1:02:03 from an hour on. */
export function listTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** Reads a time such as 4:05, 1:02:03 or 62:03.5 as seconds; null if it is not one. */
export function parseTime(text: string): number | null {
  const match = /^\s*(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const [hours, minutes, seconds] = [Number(match[1] ?? 0), Number(match[2]), Number(match[3].replace(',', '.'))];
  if (seconds >= 60 || (match[1] !== undefined && minutes >= 60)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** One line of an imported list: a name, and where it starts in the mix if the list said. */
export interface ListedTrack {
  name: string;
  at: number | null;
}

/**
 * Reads a track list, whatever it came as: an M3U or M3U8 playlist, a table
 * with Artist and Title columns (Rekordbox's text export), or lines of
 * names, each perhaps with a number and a time in front ("01. 4:05 Artist -
 * Title") or a time at the end. Times are taken as counted from the start of
 * the mix. A file read as text must be decoded first (Rekordbox writes UTF-16).
 */
export function parseTracklist(text: string): ListedTrack[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines.some((line) => /^#EXTM3U|^#EXTINF/i.test(line.trim()))) {
    // A playlist: names from the #EXTINF lines; the other lines are file paths.
    return lines.flatMap((line) => {
      const match = /^#EXTINF:[^,]*,(.*)$/i.exec(line.trim());
      return match && match[1].trim() ? [{ name: match[1].trim(), at: null }] : [];
    });
  }
  const header = lines.findIndex((line) => line.includes('\t'));
  if (header >= 0) {
    const columns = lines[header].split('\t').map((column) => column.trim().toLowerCase());
    const artist = columns.findIndex((column) => column === 'artist');
    const title = columns.findIndex((column) => column === 'track title' || column === 'title' || column === 'name');
    if (title >= 0) {
      return lines.slice(header + 1).flatMap((line) => {
        const cells = line.split('\t').map((cell) => cell.trim());
        const name = [artist >= 0 ? cells[artist] : '', cells[title] ?? ''].filter(Boolean).join(' - ');
        return name ? [{ name, at: null }] : [];
      });
    }
  }
  return lines.flatMap((line) => {
    let rest = line.trim();
    if (!rest || rest.startsWith('#')) return [];
    let at: number | null = null;
    // A time in brackets or plain, at the start, after an optional number such as "3." or "03)".
    const front = /^(?:\d{1,3}[.)]\s+)?[[(]?((?:\d+:)?\d+:\d+(?:[.,]\d+)?)[\])]?\s*[-–—|.:]?\s*(.*)$/.exec(rest);
    const back = /^(.*?)\s*[-–—|]?\s*[[(]?((?:\d+:)?\d+:\d+(?:[.,]\d+)?)[\])]?$/.exec(rest);
    if (front && parseTime(front[1]) !== null) {
      at = parseTime(front[1]);
      rest = front[2];
    } else if (back && back[1] && parseTime(back[2]) !== null) {
      at = parseTime(back[2]);
      rest = back[1];
    } else {
      rest = rest.replace(/^\d{1,3}[.)]\s+/, '');
    }
    rest = rest.trim();
    return rest ? [{ name: rest, at }] : [];
  });
}

/** Where `count` tracks would start if spread evenly over `length` seconds. */
export function spreadEvenly(count: number, length: number): number[] {
  return Array.from({ length: count }, (_, i) => (i * length) / Math.max(1, count));
}

/** What a track is called where it has to be called something: its name, or its number. */
export const shownName = (track: MixTrack, index: number) => track.name.trim() || `Track ${index + 1}`;

/**
 * The tracks of a mix as chapters: each from its start to the next one's, the
 * first from the very start of the mix, however late its marker was put.
 */
export function chaptersOf(tracks: MixTrack[], length: number): { start: number; end: number; title: string }[] {
  return tracks.map((track, i) => ({
    start: i === 0 ? 0 : track.at,
    end: i + 1 < tracks.length ? tracks[i + 1].at : length,
    title: shownName(track, i),
  }));
}

/**
 * The list for a YouTube description, which YouTube turns into chapters, and
 * what keeps it from doing so: it wants the first at 0:00, at least three, and
 * each at least ten seconds long.
 */
export function youtubeList(tracks: MixTrack[], length: number): { text: string; problems: string[] } {
  const chapters = chaptersOf(tracks, length);
  const problems: string[] = [];
  if (chapters.length < 3) problems.push('YouTube makes chapters only from three tracks or more.');
  const short = chapters.filter((chapter) => chapter.end - chapter.start < 10).length;
  if (short) problems.push(`${short === 1 ? 'One track is' : `${short} tracks are`} shorter than ten seconds, which YouTube does not accept.`);
  return { text: chapters.map((chapter) => `${listTime(chapter.start)} ${chapter.title}`).join('\n'), problems };
}

/** What is playing `seconds` into the mix: the track, its number from 0, and the next. Before the first marker it is the first track. */
export function trackAt(tracks: MixTrack[], seconds: number): { index: number; track: MixTrack; next: MixTrack | null } | null {
  if (tracks.length === 0) return null;
  let index = 0;
  while (index + 1 < tracks.length && tracks[index + 1].at <= seconds) index++;
  return { index, track: tracks[index], next: tracks[index + 1] ?? null };
}
