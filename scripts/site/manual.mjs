// Makes the manual's pages from site/manual/: Markdown written by hand, with
// directives such as {{shortcuts: Playback}} or {{layers}} filled in from the
// app's own code, so that what the manual lists cannot drift from what the
// app has. Used by build-site.mjs, and by the tests, which check that every
// page, picture and link is there. Needs no network.
//
// The Markdown is the little the pages use: # headings, paragraphs, - and 1.
// lists, | tables |, ``` code ```, > notes, ![caption](picture) on a line of
// its own, **bold**, _italic_, `code` and [links](page.md#part).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..', '..');
// As addresses: import() takes no Windows path.
const load = (path) => import(pathToFileURL(join(root, path)).href);
const { LAYER_TYPES, COMMON_PARAMS, STYLE_PARAMS, TEXT_VARIABLES, TEXT_ABOUT, FONTS } = await load('src/visuals/template.ts');
const { FUNCTIONS, FUNCTION_ABOUT } = await load('src/visuals/expression.ts');
const { MUSIC_NAMES, MUSIC_ABOUT } = await load('src/visuals/music.ts');
const { shortcuts } = await load('src/app/shortcuts.ts');

export const MANUAL = join(root, 'site', 'manual');

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const slug = (text) => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** **bold**, _italic_, `code`, [links](page.md#part), and \* for an asterisk. Links to pages become their .html. */
function inline(text) {
  const codes = [];
  let html = escape(text).replace(/`([^`]+)`/g, (_m, code) => `\u0000${codes.push(code) - 1}\u0000`);
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_(.+?)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => `<a href="${href.replace(/^([\w-]+)\.md(#|$)/, '$1.html$2')}">${label}</a>`)
    .replace(/\\\*/g, '*');
  return html.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
}

const table = (head, rows, className = '') =>
  `<div class="table"><table${className ? ` class="${className}"` : ''}><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>\n${
    rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n')}\n</tbody></table></div>\n`;

// ---------------------------------------------------------------------------
// What the directives put in.

const MAC = shortcuts({ command: '⌘', option: 'Option' });
const PC = shortcuts({ command: 'Ctrl+', option: 'Alt' });

/** A section of the shortcuts as a table: the keys on a Mac and elsewhere, in one column where they are the same. */
function shortcutTable(title) {
  const at = MAC.findIndex(([name]) => name === title);
  if (at < 0) throw new Error(`There are no shortcuts called "${title}"`);
  // Arrows in a row stay together: "← →" is one thing to press.
  const keys = (text) => escape(text).replace(/([←→↑↓]) (?=[←→↑↓])/g, '$1&nbsp;').replace(/\+(?=[←→↑↓])/g, '+&#8288;');
  const rows = MAC[at][1].map(([mac, does], i) => {
    const pc = PC[at][1][i][0];
    return mac === pc ? [`<td colspan="2">${keys(mac)}</td>`, escape(does)] : [`<td>${keys(mac)}</td><td>${keys(pc)}</td>`, escape(does)];
  });
  return `<div class="table"><table class="keys"><thead><tr><th>Mac</th><th>Windows, Linux</th><th>Does</th></tr></thead><tbody>\n${
    rows.map(([keys, does]) => `<tr>${keys}<td>${does}</td></tr>`).join('\n')}\n</tbody></table></div>\n`;
}

/** What a setting takes and starts at. */
function range(spec) {
  const unit = spec.unit ? ` ${spec.unit}` : '';
  switch (spec.kind) {
    case 'number': return [`${spec.min} to ${spec.max}${unit}`, `${spec.default}${unit}`];
    case 'switch': return ['on or off', spec.default ? 'on' : 'off'];
    case 'colour': return ['a colour', !spec.default ? 'none' : /^#[0-9a-f]{3,8}$/i.test(spec.default) ? `<span class="swatch" style="background:${spec.default}"></span> <code>${escape(spec.default)}</code>` : `<code>${escape(spec.default)}</code>`];
    case 'choice': return [spec.choices.map((c) => escape(c)).join(', '), escape(spec.default)];
    case 'text': return ['text', spec.default ? `<code>${escape(spec.default)}</code>` : 'empty'];
    case 'font': return ['a font', escape(spec.default)];
    case 'image': return ['a picture', 'none'];
    case 'video': return ['a video', 'none'];
    case 'lut': return ['a .cube LUT', 'none'];
    default: return [spec.kind, escape(spec.default)];
  }
}

const settingsTable = (params) => table(['Setting', 'Takes', 'Starts at'], Object.values(params).map((spec) => [escape(spec.label), ...range(spec)]), 'settings');

/** Every kind of layer: its picture, what it does, and its own settings. */
function layers() {
  const sections = [];
  for (const kind of ['draws', 'effect', 'group']) {
    const types = Object.entries(LAYER_TYPES).filter(([type, spec]) => (type === 'group' ? kind === 'group' : spec.effect ? kind === 'effect' : kind === 'draws'));
    sections.push(`<h2 id="${kind}">${{ draws: 'Layers that draw', effect: 'Effects: layers that change what is beneath', group: 'Groups' }[kind]}</h2>\n`);
    for (const [type, spec] of types) {
      const picture = `pictures/layers/${type}.jpg`;
      if (!existsSync(join(MANUAL, picture))) throw new Error(`The manual has no picture of the ${spec.label} layer: ${picture}; take them with scripts/manual-pictures.mjs`);
      const own = Object.keys(spec.params).length ? settingsTable(spec.params) : '<p class="muted">No settings of its own.</p>\n';
      const common = spec.common ? spec.common.map((key) => COMMON_PARAMS[key].label.toLowerCase()) : null;
      const also = common
        ? `Also: ${common.join(', ')}${spec.effect ? '' : ', and the layer styles'}.`
        : `Also: everything every layer has${spec.effect ? '' : ', and the layer styles'}.`;
      sections.push(`<section class="layer" id="${type}">
<h3>${escape(spec.label)}</h3>
<figure><img src="${picture}" alt="The ${escape(spec.label)} layer" loading="lazy"></figure>
<p>${escape(spec.description)}</p>
${own}<p class="muted">${also} See <a href="layer-settings.html">settings every layer has</a>.</p>
</section>\n`);
    }
  }
  return sections.join('');
}

const DIRECTIVES = {
  layers,
  'layer-list': () => table(['Layer', 'What it does'], Object.entries(LAYER_TYPES).map(([type, spec]) => [`<a href="layer-types.html#${type}">${escape(spec.label)}</a>`, escape(spec.description)])),
  'common-settings': () => settingsTable(COMMON_PARAMS),
  'style-settings': () => settingsTable(STYLE_PARAMS),
  functions: () => table(['Function', 'What it gives'], Object.entries(FUNCTIONS).map(([name, f]) => [`<code>${escape(f.usage)}</code>`, escape(FUNCTION_ABOUT[name])]), 'reference'),
  music: () => table(['Name', 'What it is'], MUSIC_NAMES.map((name) => [`<code>${name}</code>`, escape(MUSIC_ABOUT[name])]), 'reference'),
  'text-variables': () => table(['Variable', 'Gives'], TEXT_VARIABLES.map((name) => [`<code>%${name}%</code>`, escape(TEXT_ABOUT[name])]), 'reference'),
  fonts: () => `<p>${Object.keys(FONTS).map((f) => `<code>${escape(f)}</code>`).join(', ')}</p>\n`,
  'all-shortcuts': () => MAC.map(([title]) => `<h2 id="${slug(title)}">${escape(title)}</h2>\n${shortcutTable(title)}`).join(''),
};

function directive(text) {
  const [name, argument] = text.split(':').map((part) => part.trim());
  if (name === 'shortcuts') return `<h3 class="keys-title">Shortcuts</h3>\n${shortcutTable(argument)}`;
  const make = DIRECTIVES[name];
  if (!make) throw new Error(`The manual has no directive {{${text}}}`);
  return make();
}

// ---------------------------------------------------------------------------
// Markdown

/** A page's Markdown as HTML, with its title (the # heading) and its parts (the ## headings). */
export function render(markdown) {
  const lines = markdown.replace(/\r/g, '').split('\n');
  let html = '';
  let title = '';
  const parts = [];
  let i = 0;
  const paragraph = [];
  const flush = () => {
    if (paragraph.length) html += `<p>${inline(paragraph.join(' '))}</p>\n`;
    paragraph.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { flush(); i++; continue; }
    if ((m = line.match(/^\{\{(.+)\}\}\s*$/))) { flush(); html += directive(m[1]); i++; continue; }
    if ((m = line.match(/^(#{1,3}) (.+)$/))) {
      flush();
      const level = m[1].length;
      const text = m[2].trim();
      if (level === 1) title = text;
      const id = slug(text);
      if (level === 2) parts.push({ id, text });
      html += level === 1 ? `<h1>${inline(text)}</h1>\n` : `<h${level} id="${id}">${inline(text)}</h${level}>\n`;
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      flush();
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      html += `<pre><code>${escape(code.join('\n'))}</code></pre>\n`;
      i++;
      continue;
    }
    if ((m = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/))) {
      flush();
      if (!existsSync(join(MANUAL, m[2]))) throw new Error(`The manual has no picture ${m[2]}`);
      html += `<figure><img src="${m[2]}" alt="${escape(m[1])}" loading="lazy">${m[1] ? `<figcaption>${inline(m[1])}</figcaption>` : ''}</figure>\n`;
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      flush();
      const rows = [];
      for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i].trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => inline(cell.trim().replace(/\\\|/g, '|'))));
      html += table(rows[0], rows.slice(2));
      continue;
    }
    if (line.startsWith('> ')) {
      flush();
      const note = [];
      for (; i < lines.length && lines[i].startsWith('> '); i++) note.push(lines[i].slice(2));
      html += `<aside class="note-box">${inline(note.join(' '))}</aside>\n`;
      continue;
    }
    if ((m = line.match(/^(- |\d+\. )/))) {
      flush();
      const ordered = m[1] !== '- ';
      const items = [];
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (/^(- |\d+\. )/.test(l)) items.push(l.replace(/^(- |\d+\. )/, ''));
        else if (/^\s{2,}\S/.test(l) && items.length) items[items.length - 1] += ` ${l.trim()}`;
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}>\n${items.map((item) => `<li>${inline(item)}</li>`).join('\n')}\n</${tag}>\n`;
      continue;
    }
    paragraph.push(line.trim());
    i++;
  }
  flush();
  if (!title) throw new Error('A page of the manual has no # title');
  return { title, parts, html };
}

// ---------------------------------------------------------------------------
// The manual

/** The pages in order, under their headings, as contents.json lists them. */
export function contents() {
  return JSON.parse(readFileSync(join(MANUAL, 'contents.json'), 'utf8'));
}

/**
 * Every page of the manual: its name (the .md file without the extension),
 * title, and the HTML of its article, side menu and links to the pages
 * before and after.
 */
export function manualPages() {
  const sections = contents();
  const order = sections.flatMap((section) => section.pages);
  const rendered = new Map(order.map((name) => [name, render(readFileSync(join(MANUAL, `${name}.md`), 'utf8'))]));
  const pages = order.map((name, index) => {
    const page = rendered.get(name);
    const nav = sections.map((section) => `<p class="nav-heading">${escape(section.title)}</p>\n<ul>\n${section.pages.map((other) =>
      `<li${other === name ? ' class="on"' : ''}><a href="${other}.html">${inline(rendered.get(other).title)}</a></li>`).join('\n')}\n</ul>`).join('\n');
    const before = order[index - 1];
    const after = order[index + 1];
    const pager = `<nav class="pager">${before ? `<a href="${before}.html">← ${inline(rendered.get(before).title)}</a>` : '<span></span>'}${
      after ? `<a href="${after}.html">${inline(rendered.get(after).title)} →</a>` : ''}</nav>`;
    return { name, title: page.title, html: page.html, nav, pager, parts: page.parts };
  });
  checkLinks(pages);
  return pages;
}

/** Every link from one page of the manual to another, and to a part of one, leads somewhere. */
function checkLinks(pages) {
  const ids = new Map(pages.map((page) => [page.name, new Set([...page.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
  for (const page of pages) {
    for (const [, target, part] of page.html.matchAll(/href="([\w-]+)\.html(?:#([^"]+))?"/g)) {
      if (!ids.has(target)) throw new Error(`${page.name}.md links to ${target}, which is not a page of the manual`);
      if (part && !ids.get(target).has(part)) throw new Error(`${page.name}.md links to ${target}#${part}, which is not there`);
    }
  }
}
