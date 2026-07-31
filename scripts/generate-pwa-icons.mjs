import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electron from 'electron';

const projectRoot = resolve(import.meta.dirname, '..');
const scriptDir = mkdtempSync(join(tmpdir(), 'soloe-pwa-icon-'));
const rendererScript = join(scriptDir, 'render-icon.cjs');

writeFileSync(
  rendererScript,
  String.raw`
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = process.argv.at(-1);
const sourcePath = resolve(root, 'build/favicon.svg');
const outputPath = resolve(root, 'build/apple-touch-icon.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false
    }
  });
  await win.loadURL('about:blank');

  const svg = readFileSync(sourcePath, 'utf8');
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const png = await win.webContents.executeJavaScript(
    '(' + (async ({ dataUrl, size, background }) => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('failed to create icon canvas');
      context.fillStyle = background;
      context.fillRect(0, 0, size, size);

      const image = new Image();
      await new Promise((resolveImage, rejectImage) => {
        image.onload = resolveImage;
        image.onerror = () => rejectImage(new Error('failed to load canonical favicon'));
        image.src = dataUrl;
      });
      context.drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }).toString() + ')(' + JSON.stringify({ dataUrl, size: 180, background: '#1A1A1A' }) + ')'
  );

  writeFileSync(outputPath, Buffer.from(png, 'base64'));
  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
`
);

try {
  const result = spawnSync(
    electron,
    ['--no-sandbox', '--disable-gpu', rendererScript, projectRoot],
    { cwd: projectRoot, encoding: 'utf8', stdio: 'inherit' }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`electron exited with status ${result.status ?? 'unknown'}`);
  }
} finally {
  rmSync(scriptDir, { recursive: true, force: true });
}
