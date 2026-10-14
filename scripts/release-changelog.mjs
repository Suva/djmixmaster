// Run by `npm version` (the "version" script in package.json), after the
// version number has been raised and before the release is committed: turns
// "Not released yet" in CHANGELOG.md into a heading for the new version, so
// the website lists what the release brings.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const unreleased = /^## Not released yet\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
if (!unreleased || !unreleased[1].trim()) {
  console.error('CHANGELOG.md has nothing under "## Not released yet". Write down what this release changes first.');
  process.exit(1);
}
const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
writeFileSync('CHANGELOG.md', changelog.replace('## Not released yet', `## ${version} — ${date}`));
console.log(`CHANGELOG.md: the unreleased changes are now ${version}, ${date}.`);
