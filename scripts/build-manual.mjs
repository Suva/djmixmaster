// Builds the manual as it travels with the app, into dist/help/ (or the folder
// given): its pages in manual/, with the style sheet and the icon beside, so
// that Help → User Manual opens the manual of the version installed, without
// a network. The pages are made as the website's are (scripts/site/manual.mjs,
// site/manual.html); links out of the manual, to the download page and "What's
// new", go to the website. Run by scripts/build.mjs.
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MANUAL, manualPages } from './site/manual.mjs';

/** The website, where the manual's links to the rest of it go. */
export const SITE = 'https://dmm.clysuva.com/';
const REPOSITORY_URL = 'https://github.com/Suva/djmixmaster';

const root = join(import.meta.dirname, '..');
const out = resolve(process.argv[2] && import.meta.filename === resolve(process.argv[1] ?? '') ? process.argv[2] : join(root, 'dist', 'help'));

const template = readFileSync(join(root, 'site', 'manual.html'), 'utf8');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'manual'), { recursive: true });
for (const page of manualPages()) {
  // A page's links to the rest of the website (../index.html) go to it by its address: the copy has only the manual.
  const outward = (html) => html.replaceAll('href="../', `href="${SITE}`);
  const values = {
    TITLE: page.title.replace(/<[^>]+>/g, ''), CONTENT: outward(page.html), NAV: outward(page.nav), PAGER: outward(page.pager), SITE, REPOSITORY_URL,
  };
  let html = template;
  for (const [name, value] of Object.entries(values)) html = html.replaceAll(`{{${name}}}`, value);
  const unfilled = html.match(/\{\{[A-Z_]+\}\}/g);
  if (unfilled) throw new Error(`site/manual.html has placeholders nothing fills in: ${[...new Set(unfilled)].join(', ')}`);
  writeFileSync(join(out, 'manual', `${page.name}.html`), html);
}
cpSync(join(MANUAL, 'pictures'), join(out, 'manual', 'pictures'), { recursive: true });
for (const file of ['style.css', 'icon.png']) copyFileSync(join(root, 'site', file), join(out, file));
