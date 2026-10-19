// Looks for a newer version, quietly. The check runs after the window is up,
// gives up after a few seconds, and tells nobody when it fails: no internet,
// a Wi-Fi sign-in page and GitHub being down all simply look like "no news".
//
// Nothing is installed from here. A newer version is only pointed out, with a
// link to the download page; installing in place would need a signed app.

import { app, net } from 'electron';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNewer, parseVersion } from '../version.ts';

/** GitHub's public list entry for the newest full release; pre-releases are not offered. */
const FEED = process.env.DJMASTER_UPDATE_FEED ?? 'https://api.github.com/repos/Suva/djmixmaster/releases/latest';
export const DOWNLOAD_PAGE = 'https://suva.github.io/djmixmaster/';

/**
 * Whether this copy came from the Microsoft Store, which brings its updates
 * itself: the app then neither looks for a newer version nor points to the
 * download page, as the Store asks. DJMASTER_STORE=1 acts as such a copy.
 */
export const UPDATES_FROM_STORE = process.windowsStore === true || process.env.DJMASTER_STORE === '1';
/** The manual, on the website, for the version released last. */
export const MANUAL_PAGE = `${DOWNLOAD_PAGE}manual/`;
const TIMEOUT_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface UpdateSettings {
  /** Whether to look for updates without being asked. */
  automatic: boolean;
  /** When the feed was last read, in milliseconds since 1970. */
  lastChecked: number;
  /** The newest version the feed has named, kept so the notice can show without asking again. */
  newest: string | null;
  /** A version the user chose not to be told about any more. */
  skipped: string | null;
}

const file = () => join(app.getPath('userData'), 'updates.json');
let settings: UpdateSettings = { automatic: true, lastChecked: 0, newest: null, skipped: null };

export async function loadUpdateSettings(): Promise<UpdateSettings> {
  try {
    const saved = JSON.parse(await readFile(file(), 'utf8'));
    settings = {
      automatic: saved.automatic !== false,
      lastChecked: Number(saved.lastChecked) || 0,
      newest: typeof saved.newest === 'string' && parseVersion(saved.newest) ? saved.newest : null,
      skipped: typeof saved.skipped === 'string' ? saved.skipped : null,
    };
  } catch {
    // First run, or an unreadable file: the defaults stand.
  }
  return settings;
}

async function save() {
  try {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(file(), JSON.stringify(settings));
  } catch (error) {
    console.error('Could not save the update settings:', error);
  }
}

export function setAutomatic(automatic: boolean) {
  settings.automatic = automatic;
  return save();
}

export function skipVersion(version: string) {
  settings.skipped = version;
  return save();
}

/** Asks the feed for the newest version. Null means it could not be found out, for whatever reason. */
async function readFeed(): Promise<string | null> {
  try {
    const response = await net.fetch(FEED, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    const release = (await response.json()) as { tag_name?: unknown };
    // Only a plain version number is ever passed on; nothing else from the reply is used.
    const version = typeof release.tag_name === 'string' ? parseVersion(release.tag_name) : null;
    return version ? version.join('.') : null;
  } catch {
    return null;
  }
}

export type CheckResult =
  | { state: 'newer'; version: string }
  | { state: 'current' }
  | { state: 'unknown' };

/** A check the user asked for: always reads the feed, and says so when it cannot. */
export async function checkNow(): Promise<CheckResult> {
  const newest = await readFeed();
  if (!newest) return { state: 'unknown' };
  settings.lastChecked = Date.now();
  settings.newest = newest;
  await save();
  return isNewer(newest, app.getVersion()) ? { state: 'newer', version: newest } : { state: 'current' };
}

/**
 * The check made on its own after start-up. Reads the feed at most once a day
 * and otherwise goes by what it learnt last time. Returns a version only when
 * there is something worth telling: newer than this one and not skipped.
 */
export async function checkQuietly(): Promise<string | null> {
  // Running from the project is not an installed copy; there is nothing to update.
  if (!app.isPackaged && !process.env.DJMASTER_UPDATE_FEED) return null;
  if (UPDATES_FROM_STORE) return null;
  if (!settings.automatic) return null;
  if (Date.now() - settings.lastChecked > DAY_MS) {
    const newest = await readFeed();
    if (newest) {
      settings.lastChecked = Date.now();
      settings.newest = newest;
      await save();
    }
  }
  const newest = settings.newest;
  return newest && isNewer(newest, app.getVersion()) && newest !== settings.skipped ? newest : null;
}
