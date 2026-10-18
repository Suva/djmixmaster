// Builds the website into _site/: the pages in site/ with the newest release's
// version and download links filled in, the released part of CHANGELOG.md as
// the "What's new" page, and the manual (site/manual/, see site/manual.mjs). Needs the GitHub CLI, signed in or
// with GH_TOKEN set, to look the release up.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const linux = asset('.AppImage');

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
  LINUX_URL: linux?.browser_download_url ?? releasesUrl,
  LINUX_DETAIL: linux ? `AppImage · ${megabytes(linux.size)}` : 'AppImage',
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
 * on indented lines), lines starting "  - " items of a list within the item
 * before, and anything else is a paragraph. Changes not released
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
        const last = blocks.at(-1);
        if (!line.trim()) blocks.push(null);
        else if (line.startsWith('- ')) blocks.push({ kind: 'li', text: line.slice(2), items: [] });
        else if (line.startsWith('  - ') && last?.kind === 'li') last.items.push(line.slice(4));
        // A line carried on: of the last item within, if there is one, else of the block.
        else if (last?.items?.length) last.items[last.items.length - 1] += ` ${line.trim()}`;
        else if (last) last.text += ` ${line.trim()}`;
        else blocks.push({ kind: 'p', text: line.trim() });
      }
      let html = `<h2 id="v${escape(version.trim())}">${escape(version.trim())}${date ? ` <span class="date">${escape(date.trim())}</span>` : ''}</h2>\n`;
      let inList = false;
      for (const block of blocks.filter(Boolean)) {
        if (block.kind === 'li' && !inList) html += '<ul>\n';
        if (block.kind !== 'li' && inList) html += '</ul>\n';
        inList = block.kind === 'li';
        const within = block.items?.length ? `\n<ul>\n${block.items.map((item) => `<li>${inline(item)}</li>`).join('\n')}\n</ul>\n` : '';
        html += `<${block.kind}>${inline(block.text)}${within}</${block.kind}>\n`;
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

// The manual: its pages in the page around them, and its pictures. Made from the sources in MANUAL_ROOT when it is
// set, as the website's workflow sets it to the newest release's, so the manual describes the version that is
// downloaded, as "What's new" does; else from these.
const manualRoot = resolve(process.env.MANUAL_ROOT ?? '.');
const manualModule = join(manualRoot, 'scripts', 'site', 'manual.mjs');
if (existsSync(manualModule)) {
  const { MANUAL, manualPages } = await import(pathToFileURL(manualModule).href);
  mkdirSync('_site/manual', { recursive: true });
  for (const page of manualPages()) {
    writeFileSync(`_site/manual/${page.name}.html`, fill('manual.html', { TITLE: page.title.replace(/<[^>]+>/g, ''), CONTENT: page.html, NAV: page.nav, PAGER: page.pager }));
  }
  cpSync(join(MANUAL, 'pictures'), '_site/manual/pictures', { recursive: true });
} else {
  console.log(`No manual in ${manualRoot}: that version came before it.`);
}
// The pages link to the manual once there is one to link to.
const manualLink = existsSync('_site/manual/index.html') ? '<a href="manual/">Manual</a>' : '';

writeFileSync('_site/index.html', fill('index.html', { MANUAL_LINK: manualLink }));
writeFileSync('_site/changes.html', fill('changes.html', { CHANGES: changes(), MANUAL_LINK: manualLink }));
for (const file of ['screenshot.png', 'icon.png', 'style.css']) copyFileSync(`site/${file}`, `_site/${file}`);

console.log(`Built _site/ for ${release ? release.tag_name : 'no release yet'}.`);
