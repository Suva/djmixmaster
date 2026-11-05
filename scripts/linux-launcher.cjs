// electron-builder's afterPack hook: on Linux, puts a small launcher where the
// app's executable was, which starts the real one (renamed `<name>.bin`).
//
// Inside Firejail, a sandbox itself and how the AppImage catalog tries apps,
// Chromium's own sandbox cannot start: the process that draws the page dies at
// once and the window stays empty. The AppImage's start script turns Chromium's
// sandbox off only where user namespaces are missing (recent Ubuntu), and
// Firejail has them. The switch has to be on the command line: on Linux Chromium
// starts its helper processes before the app's JavaScript runs, so setting it
// from main.ts comes too late. The window only ever shows the app's own pages,
// served from inside it, never anything from the internet.
const { renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function linuxLauncher(context) {
  if (context.electronPlatformName !== 'linux') return;
  const name = context.packager.executableName;
  const executable = join(context.appOutDir, name);
  renameSync(executable, `${executable}.bin`);
  writeFileSync(executable, `#!/bin/sh
here=$(dirname "$(readlink -f "$0")")
if [ "$container" = firejail ]; then
  exec "$here/${name}.bin" --no-sandbox "$@"
fi
exec "$here/${name}.bin" "$@"
`, { mode: 0o755 });
};
