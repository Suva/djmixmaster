// Builds the website into _site/: the pages in site/ with the newest release's
// version and download links filled in, and the released part of
// CHANGELOG.md as the "What's new" page. Needs the GitHub CLI, signed in or
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

/** The little Markdown CHANGELOG.md uses: bold, code, and an escaped asterisk. */
const inline = (text) =>
  escape(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\\\*/g, '*');

/**
 * The released versions in CHANGELOG.md as HTML. Each "## <version> — <date>"
 * becomes a heading; under it, lines starting "- " are list items (continued
 * on indented lines) and anything else is a paragraph. Changes not released
 * yet are left out: the page goes with the downloads.
 */
function changes() {
  const sections = readFileSync('CHANGELOG.md', 'utf8').split(/^## /m).slice(1);
  return sections
    .filter((section) => !section.startsWith('Not released yet'))
    .map((section) => {
      const [heading, ...lines] = section.split('\n');
      const [version, date] = heading.split(' — ');
      const blocks = [];
      for (const line of lines) {
        if (!line.trim()) blocks.push(null);
        else if (line.startsWith('- ')) blocks.push({ kind: 'li', text: line.slice(2) });
        else if (blocks.at(-1)) blocks.at(-1).text += ` ${line.trim()}`;
        else blocks.push({ kind: 'p', text: line.trim() });
      }
      let html = `<h2 id="v${escape(version.trim())}">${escape(version.trim())}${date ? ` <span class="date">${escape(date.trim())}</span>` : ''}</h2>\n`;
      let inList = false;
      for (const block of blocks.filter(Boolean)) {
        if (block.kind === 'li' && !inList) html += '<ul>\n';
        if (block.kind !== 'li' && inList) html += '</ul>\n';
        inList = block.kind === 'li';
        html += `<${block.kind}>${inline(block.text)}</${block.kind}>\n`;
      }
      return html + (inList ? '</ul>\n' : '');
    })
    .join('\n');
}

/** A page from site/ with its placeholders filled in. `raw` values are HTML already. */
function fill(file, raw = {}) {
  let page = readFileSync(`site/${file}`, 'utf8');
  for (const [name, value] of Object.entries(raw)) page = page.replaceAll(`{{${name}}}`, value);
  for (const [name, value] of Object.entries(values)) page = page.replaceAll(`{{${name}}}`, escape(value));
  const unfilled = page.match(/\{\{[A-Z_]+\}\}/g);
  if (unfilled) throw new Error(`${file} has placeholders nothing fills in: ${[...new Set(unfilled)].join(', ')}`);
  return page;
}

rmSync('_site', { recursive: true, force: true });
mkdirSync('_site');
writeFileSync('_site/index.html', fill('index.html'));
writeFileSync('_site/changes.html', fill('changes.html', { CHANGES: changes() }));
for (const file of ['screenshot.png', 'icon.png', 'style.css']) copyFileSync(`site/${file}`, `_site/${file}`);
console.log(`Built _site/ for ${release ? release.tag_name : 'no release yet'}.`);
