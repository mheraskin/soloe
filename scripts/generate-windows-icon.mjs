import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electron from 'electron';

const projectRoot = resolve(import.meta.dirname, '..');
const scriptDir = mkdtempSync(join(tmpdir(), 'soloe-icon-'));
const rendererScript = join(scriptDir, 'render-icon.cjs');

writeFileSync(
  rendererScript,
  String.raw`
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = process.argv.at(-1);
const svgPath = resolve(root, 'build/icon.svg');
const icoPath = resolve(root, 'build/icon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];

app.disableHardwareAcceleration();

function createIco(images) {
  const headerSize = 6;
  const directorySize = 16 * images.length;
  let offset = headerSize + directorySize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directories = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...directories, ...images.map(({ png }) => png)]);
}

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

  const svg = readFileSync(svgPath, 'utf8');
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const script = [
    'Promise.all(' + JSON.stringify(sizes) + '.map((size) => new Promise((resolve, reject) => {',
    '  const canvas = document.createElement("canvas");',
    '  canvas.width = size;',
    '  canvas.height = size;',
    '  const context = canvas.getContext("2d");',
    '  const image = new Image();',
    '  image.onload = () => {',
    '    context.clearRect(0, 0, size, size);',
    '    context.drawImage(image, 0, 0, size, size);',
    '    resolve({ size, data: canvas.toDataURL("image/png").split(",")[1] });',
    '  };',
    '  image.onerror = () => reject(new Error("failed to render icon SVG at " + size + "px"));',
    '  image.src = ' + JSON.stringify(dataUrl) + ';',
    '})))'
  ].join('\n');
  const images = await win.webContents.executeJavaScript(script);

  writeFileSync(
    icoPath,
    createIco(images.map(({ size, data }) => ({ size, png: Buffer.from(data, 'base64') })))
  );
  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
`
);

try {
  const result = spawnSync(electron, ['--no-sandbox', '--disable-gpu', rendererScript, projectRoot], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'inherit'
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`electron exited with status ${result.status ?? 'unknown'}`);
  }
} finally {
  rmSync(scriptDir, { recursive: true, force: true });
}
