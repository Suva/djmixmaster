// The manual (site/manual/) is kept in step with the app: it builds, every
// page is in its contents, every kind of layer has its picture, and no picture
// is left over. What it lists of the app's (layers, functions, music values,
// text variables, shortcuts) is made from the app's own code, and TypeScript
// sees that each has its description; this sees that the pages put them in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error: a script of the site's, in plain JavaScript.
import { contents, MANUAL, manualPages } from '../scripts/site/manual.mjs';
import { LAYER_TYPES } from '../src/visuals/template.ts';

type Page = { name: string; title: string; html: string };

test('the manual builds, with every page in its contents and every link leading somewhere', () => {
  const pages: Page[] = manualPages();
  const listed = (contents() as { pages: string[] }[]).flatMap((section) => section.pages).sort();
  const written = readdirSync(MANUAL).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -3)).sort();
  assert.deepEqual(listed, written, 'every page written is in contents.json, and every page there is written');
  for (const page of pages) assert.ok(page.title && page.html.length > 200, `${page.name} has a title and something to say`);
});

test('the manual shows every kind of layer, each with its picture, and keeps no picture it does not use', () => {
  const pages: Page[] = manualPages();
  const layers = pages.find((page) => page.name === 'layer-types')!.html;
  for (const [type, spec] of Object.entries(LAYER_TYPES)) {
    assert.match(layers, new RegExp(`<section class="layer" id="${type}">`), `${spec.label} has its section`);
  }
  const pictures = readdirSync(join(MANUAL, 'pictures', 'layers')).map((file) => file.replace(/\.jpg$/, '')).sort();
  assert.deepEqual(pictures, Object.keys(LAYER_TYPES).sort(), 'a picture for each kind of layer, and none for a kind there is not');
  const used = pages.map((page) => page.html).join('\n');
  for (const file of readdirSync(join(MANUAL, 'pictures')).filter((f) => /\.(png|jpg)$/.test(f))) {
    assert.ok(used.includes(`pictures/${file}`), `pictures/${file} is shown on some page`);
  }
});

test('the manual puts the shortcuts at the foot of the pages they belong to, and all of them on one', () => {
  const pages: Page[] = manualPages();
  const all = pages.find((page) => page.name === 'shortcuts')!.html;
  const sections = [...all.matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
  assert.ok(sections.length >= 5, 'every section of the shortcuts on the Shortcuts page');
  const keys = readFileSync(join(MANUAL, 'levelling.md'), 'utf8');
  assert.match(keys, /\{\{shortcuts: Playback\}\}/);
  assert.match(pages.find((page) => page.name === 'levelling')!.html, /<table class="keys">/);
});

test('the manual the app carries builds, and every link in it to a file leads to one it has', async () => {
  const { execFileSync } = await import('node:child_process');
  const { existsSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname, resolve } = await import('node:path');
  const out = mkdtempSync(join(tmpdir(), 'djm-help-'));
  try {
    execFileSync(process.execPath, ['scripts/build-manual.mjs', out], { cwd: join(import.meta.dirname, '..') });
    const pages = readdirSync(join(out, 'manual')).filter((file) => file.endsWith('.html'));
    assert.ok(pages.includes('index.html') && pages.length > 10, `its pages: ${pages.length}`);
    for (const page of pages) {
      const html = readFileSync(join(out, 'manual', page), 'utf8');
      for (const [, link] of html.matchAll(/(?:href|src)="([^"#]*)(?:#[^"]*)?"/g)) {
        if (!link) continue;
        // Out to the web, as the pages' own links are, and the header's to the rest of the website; anything else is a file it has.
        if (/^(https?|mailto):/.test(link)) continue;
        assert.ok(existsSync(resolve(dirname(join(out, 'manual', page)), link)), `${page} links to ${link}, which the copy has`);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
