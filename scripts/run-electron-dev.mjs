import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const require = createRequire(import.meta.url);

export const DEVELOPMENT_APP_NAME = 'Soloe';
export const DEVELOPMENT_APP_ID = 'com.soloe.app.dev';
export const DEVELOPMENT_BUNDLE_FORMAT_VERSION = 5;
export const DEVELOPMENT_HELPER_BUNDLES = [
  ['Electron Helper.app', 'Soloe Helper.app', 'Soloe Helper'],
  ['Electron Helper (GPU).app', 'Soloe Helper (GPU).app', 'Soloe Helper (GPU)'],
  ['Electron Helper (Plugin).app', 'Soloe Helper (Plugin).app', 'Soloe Helper (Plugin)'],
  ['Electron Helper (Renderer).app', 'Soloe Helper (Renderer).app', 'Soloe Helper (Renderer)']
];
export const DEVELOPMENT_NESTED_SIGNABLES = [
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib',
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libGLESv2.dylib',
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib',
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib',
  'Contents/Frameworks/Mantle.framework/Versions/A/Mantle',
  'Contents/Frameworks/ReactiveObjC.framework/Versions/A/ReactiveObjC',
  'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt',
  'Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel',
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.error}`
    );
  }
}

async function copyMacosApp(source, destination) {
  const cloned = spawnSync('cp', ['-cR', source, destination], { encoding: 'utf8' });
  if (cloned.status === 0) return;
  run('ditto', [source, destination]);
}

export async function prepareMacosDevelopmentElectron() {
  const electronPackagePath = require.resolve('electron/package.json');
  const electronDirectory = dirname(electronPackagePath);
  const electronPackage = JSON.parse(await readFile(electronPackagePath, 'utf8'));
  const sourceApp = join(electronDirectory, 'dist', 'Electron.app');
  const iconPath = join(repositoryRoot, 'build', 'icon-macos.png');
  const bundleIconPath = join(repositoryRoot, 'build', 'icon-macos.icns');
  const cacheKey = createHash('sha256')
    .update(String(DEVELOPMENT_BUNDLE_FORMAT_VERSION))
    .update(String(electronPackage.version))
    .update(readFileSync(iconPath))
    .update(readFileSync(bundleIconPath))
    .update(DEVELOPMENT_APP_NAME)
    .update(DEVELOPMENT_APP_ID)
    .digest('hex');
  const cacheDirectory = join(
    repositoryRoot,
    'node_modules',
    '.cache',
    'soloe-electron-dev',
    String(electronPackage.version)
  );
  const distDirectory = join(cacheDirectory, 'dist');
  const destinationApp = join(distDirectory, `${DEVELOPMENT_APP_NAME}.app`);
  const markerPath = join(cacheDirectory, 'branding-key');
  const marker = existsSync(markerPath) ? await readFile(markerPath, 'utf8') : '';

  const executablePath = join(destinationApp, 'Contents', 'MacOS', DEVELOPMENT_APP_NAME);
  if (marker === cacheKey && existsSync(executablePath)) return executablePath;

  await rm(cacheDirectory, { recursive: true, force: true });
  await mkdir(distDirectory, { recursive: true });
  await copyMacosApp(sourceApp, destinationApp);

  const infoPlist = join(destinationApp, 'Contents', 'Info.plist');
  run('plutil', ['-replace', 'CFBundleDisplayName', '-string', DEVELOPMENT_APP_NAME, infoPlist]);
  run('plutil', ['-replace', 'CFBundleExecutable', '-string', DEVELOPMENT_APP_NAME, infoPlist]);
  run('plutil', ['-replace', 'CFBundleIconFile', '-string', 'soloe.icns', infoPlist]);
  run('plutil', ['-replace', 'CFBundleName', '-string', DEVELOPMENT_APP_NAME, infoPlist]);
  run('plutil', ['-replace', 'CFBundleIdentifier', '-string', DEVELOPMENT_APP_ID, infoPlist]);
  await copyFile(bundleIconPath, join(destinationApp, 'Contents', 'Resources', 'soloe.icns'));
  await rename(
    join(destinationApp, 'Contents', 'MacOS', 'Electron'),
    join(destinationApp, 'Contents', 'MacOS', DEVELOPMENT_APP_NAME)
  );

  for (const relativePath of DEVELOPMENT_NESTED_SIGNABLES) {
    run('codesign', ['--force', '--sign', '-', join(destinationApp, relativePath)]);
  }

  const frameworksDirectory = join(destinationApp, 'Contents', 'Frameworks');
  for (const [sourceName, destinationName, bundleName] of DEVELOPMENT_HELPER_BUNDLES) {
    const helperApp = join(frameworksDirectory, destinationName);
    await rename(join(frameworksDirectory, sourceName), helperApp);
    const helperInfoPlist = join(helperApp, 'Contents', 'Info.plist');
    await rename(
      join(helperApp, 'Contents', 'MacOS', sourceName.slice(0, -'.app'.length)),
      join(helperApp, 'Contents', 'MacOS', bundleName)
    );
    run('plutil', ['-replace', 'CFBundleName', '-string', bundleName, helperInfoPlist]);
    run('plutil', [
      '-replace',
      'CFBundleIdentifier',
      '-string',
      `${DEVELOPMENT_APP_ID}.helper`,
      helperInfoPlist
    ]);
    run('codesign', ['--force', '--sign', '-', helperApp]);
  }

  run('codesign', ['--force', '--sign', '-', destinationApp]);
  await writeFile(markerPath, cacheKey);
  return executablePath;
}

export async function runElectronDevelopment() {
  const electronVite = join(repositoryRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
  const environment = { ...process.env, SOLOE_DESKTOP_DEVELOPMENT: '1' };
  if (process.platform === 'darwin') {
    environment.ELECTRON_EXEC_PATH = await prepareMacosDevelopmentElectron();
  }

  const child = spawn(
    process.execPath,
    [electronVite, 'dev', '--config', join(repositoryRoot, 'electron.vite.config.ts')],
    { cwd: process.cwd(), env: environment, stdio: 'inherit' }
  );
  process.once('SIGINT', () => {
    if (!child.killed) child.kill('SIGINT');
  });
  process.once('SIGTERM', () => {
    if (!child.killed) child.kill('SIGTERM');
  });
  child.once('exit', (code) => process.exit(code ?? 1));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  runElectronDevelopment().catch((error) => {
    console.error('[desktop-dev]', error);
    process.exit(1);
  });
}
