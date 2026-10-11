// Builds the website into _site/: the page in site/ with the newest release's
// version and download links filled in. Needs the GitHub CLI, signed in or
// with GH_TOKEN set, to look the release up.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const repository = process.env.GITHUB_REPOSITORY ?? 'Suva/djmixmaster';
const releasesUrl = `https://github.com/${repository}/releases`;

/** The newest published release, pre-releases included, or null if there is none. */
function newestRelease() {
  try {
    const releases = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases`], { encoding: 'utf8' }));
    return releases.find((release) => !release.draft) ?? null;
  } catch (error) {
    console.warn(`Could not read the releases (${error.message.split('\n')[0]}); the page will link to the releases list.`);
    return null;
  }
}

const megabytes = (bytes) => `${Math.round(bytes / 1048576)} MB`;
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const release = newestRelease();
const asset = (extension) => release?.assets.find((a) => a.name.endsWith(extension));
const mac = asset('.dmg');
const windows = asset('.exe');

let version = 'See the releases page for the current version.';
if (release) {
  const date = new Date(release.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const kind = release.prerelease ? 'Pre-release version' : 'Version';
  version = `${kind} ${release.tag_name.replace(/^v/, '')}, released ${date}.`;
}

const values = {
  VERSION_LINE: version,
  MAC_URL: mac?.browser_download_url ?? releasesUrl,
  MAC_DETAIL: mac ? `Apple Silicon · ${megabytes(mac.size)}` : 'Apple Silicon',
  WINDOWS_URL: windows?.browser_download_url ?? releasesUrl,
  WINDOWS_DETAIL: windows ? `64-bit · ${megabytes(windows.size)}` : '64-bit',
  RELEASES_URL: release?.html_url ?? releasesUrl,
  REPOSITORY_URL: `https://github.com/${repository}`,
};

let page = readFileSync('site/index.html', 'utf8');
for (const [name, value] of Object.entries(values)) page = page.replaceAll(`{{${name}}}`, escape(value));
const unfilled = page.match(/\{\{[A-Z_]+\}\}/g);
if (unfilled) throw new Error(`The page has placeholders nothing fills in: ${[...new Set(unfilled)].join(', ')}`);

rmSync('_site', { recursive: true, force: true });
mkdirSync('_site');
writeFileSync('_site/index.html', page);
for (const file of ['screenshot.png', 'icon.png']) copyFileSync(`site/${file}`, `_site/${file}`);
console.log(`Built _site/ for ${release ? release.tag_name : 'no release yet'}.`);
