// Recordings that come in several files: what order the parts go in, and what
// to call them together. Kept apart from main.ts so it can be tested on its own.

import { basename } from 'node:path';

/** The longest start that all the names share. */
function commonStart(names: string[]): string {
  let start = names[0];
  for (const name of names) while (!name.startsWith(start)) start = start.slice(0, -1);
  return start;
}

/** A shared start shorter than this is chance ("F" in "Friday" and "Fog"), not a name the parts were given. */
const NAME_SHARED_AT_LEAST = 3;

/**
 * A name for several files at once. Files a recorder numbered share the start
 * of their name and get a pattern, as in "REC00*.WAV (3 files)". Files named
 * by hand often share nothing but the extension, and get the first file's
 * name and a count instead.
 */
export function nameForParts(names: string[]): string {
  const start = commonStart(names);
  if (start.length < NAME_SHARED_AT_LEAST) return `${names[0]} + ${names.length - 1} more`;
  const rests = names.map((name) => name.slice(start.length));
  let end = rests[0];
  for (const rest of rests) while (!rest.endsWith(end)) end = end.slice(1);
  return `${start}*${end} (${names.length} files)`;
}

/**
 * The order the parts were recorded in. A recorder numbers them, so where the
 * names differ by a number they go in its order ("part 2" before "part 10").
 * Otherwise the names say nothing about order, and the time each file was last
 * written does: a recorder finishes one part before it starts the next.
 */
export function orderParts(parts: { path: string; modified: number }[]): string[] {
  const names = parts.map((part) => basename(part.path));
  const start = commonStart(names);
  const numbered = names.every((name) => /^\d/.test(name.slice(start.length)));
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  return [...parts]
    .sort((a, b) =>
      numbered ? byName(basename(a.path), basename(b.path)) : a.modified - b.modified || byName(a.path, b.path),
    )
    .map((part) => part.path);
}
