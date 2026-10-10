// Renders build/icon.svg to build/icon.icns. Run with: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const build = join(__dirname, '..', 'build');
const iconset = join(build, 'icon.iconset');

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  const svg = readFileSync(join(build, 'icon.svg'), 'utf8');
  const page = `<body style="margin:0;background:transparent">${svg}</body>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await new Promise((done) => setTimeout(done, 300));
  const image = (await window.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' });

  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      writeFileSync(join(iconset, name), image.resize({ width: pixels, height: pixels, quality: 'best' }).toPNG());
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(build, 'icon.icns')]);
  writeFileSync(join(build, 'icon.png'), image.toPNG());
  rmSync(iconset, { recursive: true, force: true });
  app.quit();
});
