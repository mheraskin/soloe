import { execFile, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const electronPath = require('electron');
const electronVersion = require('electron/package.json').version;
const root = path.resolve(import.meta.dirname, '..');
const nativeRunMode = process.platform === 'win32' ? 'windows' : 'linux';
const config = parseArgs(process.argv.slice(2));
const token = config.serverToken ?? `browser-integration-${process.pid}`;
const children = new Set();
const browsers = new Set();
let scratchRoot;
let runtime;
let server;

async function main() {
  if (config.serverUrl) {
    await runExistingServerSmoke();
    return;
  }
  await fs.access(path.join(root, 'out', 'web', 'index.html')).catch(() => {
    throw new Error('Browser bundle is missing; run pnpm --filter @soloe/web build first');
  });
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-browser-integration-'));
  const dataDirectory = path.join(scratchRoot, 'data');
  const normalRepo = path.join(scratchRoot, 'normal-repo');
  const largeRepo = path.join(scratchRoot, 'large-repo');
  const runtimeEndpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\soloe-browser-integration-${process.pid}`
    : path.join(dataDirectory, 'runtime.sock');
  await Promise.all([
    createFixtureRepository(normalRepo, 40, 2),
    createFixtureRepository(largeRepo, config.largeFiles, config.largeChanges)
  ]);
  const overviewAgent = await createFakeOverviewAgent(scratchRoot);

  runtime = await startService(
    ['--filter', '@soloe/runtime', 'start'],
    {
      SOLOE_DATA_DIR: dataDirectory,
      SOLOE_RUNTIME_ENDPOINT: runtimeEndpoint
    },
    'runtime'
  );
  const serverPort = await availablePort();
  const serverEnv = {
    SOLOE_DATA_DIR: dataDirectory,
    SOLOE_RUNTIME_ENDPOINT: runtimeEndpoint,
    SOLOE_SERVER_HOST: '127.0.0.1',
    SOLOE_SERVER_PORT: String(serverPort),
    SOLOE_SERVER_TOKEN: token,
    SOLOE_WEB_ROOT: path.join(root, 'out', 'web')
  };
  server = await startService(['--filter', '@soloe/server', 'start'], serverEnv, 'server');
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  await configureOverviewAgent(baseUrl, overviewAgent);

  const normalProject = await rpc(baseUrl, 'projects', 'create', [{
    name: 'Browser integration',
    path: normalRepo,
    defaultRunMode: nativeRunMode
  }]);
  const normalSession = await rpc(baseUrl, 'sessions', 'create', [{
    name: 'Browser fixture',
    projectId: normalProject.id,
    cwd: normalRepo,
    runMode: nativeRunMode,
    launch: { type: 'terminal', shell: 'auto' }
  }]);
  const largeProject = await rpc(baseUrl, 'projects', 'create', [{
    name: 'Large browser integration',
    path: largeRepo,
    defaultRunMode: nativeRunMode
  }]);
  const largeSession = await rpc(baseUrl, 'sessions', 'create', [{
    name: 'Large fixture',
    projectId: largeProject.id,
    cwd: largeRepo,
    runMode: nativeRunMode,
    launch: { type: 'terminal', shell: 'auto' }
  }]);

  const first = await launchBrowser(`${baseUrl}/?token=${encodeURIComponent(token)}`, 'one');
  browsers.add(first);
  const workflow = await first.cdp.evaluate(
    `(${runBrowserWorkflow.toString()})(${JSON.stringify({
      projectId: normalProject.id,
      sessionId: normalSession.id,
      normalCwd: normalRepo,
      largeProjectId: largeProject.id,
      largeSessionId: largeSession.id,
      largeCwd: largeRepo,
      runMode: nativeRunMode,
      largeFileCount: config.largeFiles,
      largeChangeCount: config.largeChanges
    })})`
  );

  const second = await launchBrowser(`${baseUrl}/?token=${encodeURIComponent(token)}`, 'two');
  browsers.add(second);
  const remote = await launchRemoteElectron(baseUrl, 'remote');
  browsers.add(remote);
  const remoteWorkflow = await remote.cdp.evaluate(
    `(${runRemoteElectronWorkflow.toString()})(${JSON.stringify({
      projectId: normalProject.id,
      sessionId: normalSession.id,
      normalCwd: normalRepo,
      runMode: nativeRunMode
    })})`
  );
  await second.cdp.evaluate(`(() => {
    window.__soloeNotesEvents = [];
    window.soloe.notes.onChange((event) => window.__soloeNotesEvents.push(event));
    window.__soloeReconnects = 0;
    window.soloe.terminal.onReconnect(() => { window.__soloeReconnects += 1; });
    return true;
  })()`);
  await remote.cdp.evaluate(`(() => {
    window.__soloeNotesEvents = [];
    window.soloe.notes.onChange((event) => window.__soloeNotesEvents.push(event));
    window.__soloeReconnects = 0;
    window.soloe.terminal.onReconnect(() => { window.__soloeReconnects += 1; });
    return true;
  })()`);
  await first.cdp.evaluate(`(() => {
    window.__soloeReconnects = 0;
    window.soloe.terminal.onReconnect(() => { window.__soloeReconnects += 1; });
    return true;
  })()`);

  await first.cdp.evaluate(`(async () => {
    const result = await window.soloe.notes.write(
      ${JSON.stringify(normalProject.id)},
      'multi-client.md',
      'shared browser update'
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  })()`);
  await waitFor(async () => (
    await second.cdp.evaluate(
      `window.__soloeNotesEvents.some((event) => event.projectId === ${JSON.stringify(normalProject.id)})`
    )
  ), 10_000, 'second browser notes event');
  await waitFor(async () => (
    await remote.cdp.evaluate(
      `window.__soloeNotesEvents.some((event) => event.projectId === ${JSON.stringify(normalProject.id)})`
    )
  ), 10_000, 'remote Electron notes event');

  await stopChild(server);
  server = undefined;
  await delay(250);
  server = await startService(['--filter', '@soloe/server', 'start'], serverEnv, 'server');
  await waitFor(async () => {
    const counts = await Promise.all([
      first.cdp.evaluate('window.__soloeReconnects'),
      second.cdp.evaluate('window.__soloeReconnects'),
      remote.cdp.evaluate('window.__soloeReconnects')
    ]);
    return counts.every((count) => count >= 1);
  }, 15_000, 'browser and remote Electron clients to reconnect');

  const runningBeforeClose = await rpc(baseUrl, 'terminal', 'listRunning');
  assert(
    runningBeforeClose.some((entry) => entry.terminalId === workflow.terminal.terminalId),
    'runtime-owned terminal was not running before browser close'
  );
  await remote.close();
  browsers.delete(remote);
  const runningAfterRemoteClose = await rpc(baseUrl, 'terminal', 'listRunning');
  assert(
    runningAfterRemoteClose.some((entry) => entry.terminalId === workflow.terminal.terminalId),
    'closing remote Electron stopped a runtime-owned terminal'
  );
  await first.close();
  browsers.delete(first);
  const runningAfterClose = await rpc(baseUrl, 'terminal', 'listRunning');
  assert(
    runningAfterClose.some((entry) => entry.terminalId === workflow.terminal.terminalId),
    'closing the browser stopped a runtime-owned terminal'
  );
  const replay = await second.cdp.evaluate(`(async () => {
    const result = await window.soloe.terminal.replay(
      ${JSON.stringify(workflow.terminal.terminalId)},
      0
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  })()`);
  assert(
    replay?.data?.includes(workflow.terminal.marker),
    'replacement browser could not replay terminal output'
  );

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      node: process.version,
      electron: electronVersion,
      largeFiles: config.largeFiles,
      largeChanges: config.largeChanges
    },
    workflow,
    remoteElectron: remoteWorkflow,
    multiClient: {
      notesChangeObserved: true,
      remoteElectronNotesChangeObserved: true,
      reconnectObservedByAllClients: true,
      terminalSurvivedRemoteElectronClose: true,
      terminalSurvivedBrowserClose: true,
      replayRecoveredByReplacementClient: true
    }
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runExistingServerSmoke() {
  assert(config.webUrl, '--web-url is required with --server-url');
  assert(config.serverToken, '--server-token is required with --server-url');
  assert(config.smokeCwd, '--smoke-cwd is required with --server-url');
  assert(
    Boolean(config.serviceDataDir) === Boolean(config.wslDistro),
    '--service-data-dir and --wsl-distro must be provided together'
  );
  await fs.access(path.join(root, 'out', 'web', 'index.html')).catch(() => {
    throw new Error('Browser bundle is missing; run pnpm --filter @soloe/web build first');
  });
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-browser-integration-'));
  const baseUrl = config.serverUrl;
  const fixtureRoot = path.posix.join(
    config.smokeCwd,
    `soloe-browser-integration-${process.pid}-${Date.now()}`
  );
  const readyMarker = `soloe-fixture-ready-${process.pid}`;
  const overviewAgentSource = Buffer.from(fakeOverviewAgentSource(), 'utf8').toString('base64');
  const overviewAgent = path.posix.join(fixtureRoot, 'fake-codex');
  const overviewAgentModule = path.posix.join(fixtureRoot, 'fake-overview-agent.mjs');
  const bootstrapSession = await rpc(baseUrl, 'sessions', 'create', [{
    name: 'WSL bootstrap',
    cwd: config.smokeCwd,
    runMode: config.runMode,
    launch: { type: 'terminal', shell: 'auto' }
  }]);
  const bootstrapTerminal = await rpc(baseUrl, 'terminal', 'start', [{
    sessionId: bootstrapSession.id,
    cols: 100,
    rows: 30
  }]);
  const fixtureCommand = [
    `mkdir -p '${fixtureRoot}/src' '${fixtureRoot}/docs/grill/alpha' '${fixtureRoot}/.scratch/alpha/issues'`,
    `printf '# Fixture\\n\\n## Agent skills\\n\\nFixture configuration.\\n' > '${fixtureRoot}/AGENTS.md'`,
    `printf '# Coverage\\n\\n## Branches\\n\\n### 1. Core\\n- [ ] 1A. Browser integration\\n' > '${fixtureRoot}/docs/grill/alpha/coverage-map.md'`,
    `printf '# Browser integration\\nStatus: open\\n' > '${fixtureRoot}/.scratch/alpha/issues/01-browser.md'`,
    `printf 'export const value = 1;\\n' > '${fixtureRoot}/src/app.ts'`,
    `cd '${fixtureRoot}'`,
    'git init -b main >/dev/null',
    "git config user.name 'Soloe Integration'",
    "git config user.email 'integration@soloe.test'",
    'git config core.autocrlf false',
    'git add .',
    "git commit -m 'test: create browser fixture' >/dev/null",
    "printf 'export const value = 2;\\n' > src/app.ts",
    "printf 'browser integration\\n' > untracked.txt",
    `printf '%s' '${overviewAgentSource}' | base64 -d > '${overviewAgentModule}'`,
    `printf '#!/usr/bin/env sh\\nexec node \"${overviewAgentModule}\" \"$@\"\\n' > '${overviewAgent}'`,
    `chmod +x '${overviewAgent}'`,
    `printf '${readyMarker}\\n'`
  ].join(' && ');
  await rpc(baseUrl, 'terminal', 'input', [
    bootstrapTerminal.terminalId,
    `${fixtureCommand}\n`
  ]);
  await waitFor(async () => {
    const replay = await rpc(baseUrl, 'terminal', 'replay', [
      bootstrapTerminal.terminalId,
      0
    ]);
    return replay.data.includes(readyMarker);
  }, 20_000, 'WSL fixture repository');
  await configureOverviewAgent(baseUrl, overviewAgent);

  const project = await rpc(baseUrl, 'projects', 'create', [{
    name: 'WSL browser integration',
    path: fixtureRoot,
    defaultRunMode: config.runMode
  }]);
  const normalSession = await rpc(baseUrl, 'sessions', 'create', [{
    name: 'Browser fixture',
    projectId: project.id,
    cwd: fixtureRoot,
    runMode: config.runMode,
    launch: { type: 'terminal', shell: 'auto' }
  }]);
  const largeSession = await rpc(baseUrl, 'sessions', 'create', [{
    name: 'Large fixture',
    projectId: project.id,
    cwd: fixtureRoot,
    runMode: config.runMode,
    launch: { type: 'terminal', shell: 'auto' }
  }]);

  const first = await launchBrowser(
    `${config.webUrl}/?token=${encodeURIComponent(token)}`,
    'wsl-one'
  );
  browsers.add(first);
  const workflow = await first.cdp.evaluate(
    `(${runBrowserWorkflow.toString()})(${JSON.stringify({
      projectId: project.id,
      sessionId: normalSession.id,
      normalCwd: fixtureRoot,
      largeProjectId: project.id,
      largeSessionId: largeSession.id,
      largeCwd: fixtureRoot,
      runMode: config.runMode,
      largeFileCount: 1,
      largeChangeCount: 1
    })})`
  );

  const second = await launchBrowser(
    `${config.webUrl}/?token=${encodeURIComponent(token)}`,
    'wsl-two'
  );
  browsers.add(second);
  const remote = await launchRemoteElectron(baseUrl, 'wsl-remote');
  browsers.add(remote);
  const remoteWorkflow = await remote.cdp.evaluate(
    `(${runRemoteElectronWorkflow.toString()})(${JSON.stringify({
      projectId: project.id,
      sessionId: normalSession.id,
      normalCwd: fixtureRoot,
      runMode: config.runMode
    })})`
  );
  await second.cdp.evaluate(`(() => {
    window.__soloeNotesEvents = [];
    window.soloe.notes.onChange((event) => window.__soloeNotesEvents.push(event));
    window.__soloeReconnects = 0;
    window.soloe.terminal.onReconnect(() => { window.__soloeReconnects += 1; });
    return true;
  })()`);
  await remote.cdp.evaluate(`(() => {
    window.__soloeNotesEvents = [];
    window.soloe.notes.onChange((event) => window.__soloeNotesEvents.push(event));
    window.__soloeReconnects = 0;
    window.soloe.terminal.onReconnect(() => { window.__soloeReconnects += 1; });
    return true;
  })()`);
  await first.cdp.evaluate(`(() => {
    window.__soloeReconnects = 0;
    window.soloe.terminal.onReconnect(() => { window.__soloeReconnects += 1; });
    return true;
  })()`);
  await first.cdp.evaluate(`(async () => {
    const result = await window.soloe.notes.write(
      ${JSON.stringify(project.id)},
      'multi-client.md',
      'shared WSL update'
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  })()`);
  await waitFor(async () => (
    await second.cdp.evaluate(
      `window.__soloeNotesEvents.some((event) => event.projectId === ${JSON.stringify(project.id)})`
    )
  ), 10_000, 'second WSL browser notes event');
  await waitFor(async () => (
    await remote.cdp.evaluate(
      `window.__soloeNotesEvents.some((event) => event.projectId === ${JSON.stringify(project.id)})`
    )
  ), 10_000, 'WSL remote Electron notes event');

  const serverRestart = config.serviceDataDir
    ? await restartWslServer({
        baseUrl,
        serviceDataDir: config.serviceDataDir,
        wslDistro: config.wslDistro,
        clients: [first, second, remote]
      })
    : { exercised: false };

  const runningBeforeClose = await rpc(baseUrl, 'terminal', 'listRunning');
  assert(
    runningBeforeClose.some((entry) => entry.terminalId === workflow.terminal.terminalId),
    'WSL runtime-owned terminal was not running before client close'
  );
  await remote.close();
  browsers.delete(remote);
  await first.close();
  browsers.delete(first);
  const runningAfterClose = await rpc(baseUrl, 'terminal', 'listRunning');
  assert(
    runningAfterClose.some((entry) => entry.terminalId === workflow.terminal.terminalId),
    'closing WSL-backed clients stopped a runtime-owned terminal'
  );
  const replay = await second.cdp.evaluate(`(async () => {
    const result = await window.soloe.terminal.replay(
      ${JSON.stringify(workflow.terminal.terminalId)},
      0
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  })()`);
  assert(
    replay?.data?.includes(workflow.terminal.marker),
    'replacement WSL browser could not replay terminal output'
  );

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      node: process.version,
      electron: electronVersion,
      backend: 'wsl',
      serverUrl: baseUrl,
      webUrl: config.webUrl
    },
    fixtureRoot,
    workflow,
    remoteElectron: remoteWorkflow,
    multiClient: {
      notesChangeObserved: true,
      remoteElectronNotesChangeObserved: true,
      terminalSurvivedRemoteElectronClose: true,
      terminalSurvivedBrowserClose: true,
      replayRecoveredByReplacementClient: true,
      reconnectObservedByAllClients: serverRestart.exercised
    },
    serverRestart
  }, null, 2)}\n`);
}

async function restartWslServer({
  baseUrl,
  serviceDataDir,
  wslDistro,
  clients
}) {
  const runtimeBefore = await readServiceRecord(serviceDataDir, 'runtime');
  const serverBefore = await readServiceRecord(serviceDataDir, 'server');
  assert(runtimeBefore?.pid, 'WSL Runtime service record is missing');
  assert(serverBefore?.pid, 'WSL Server service record is missing');
  await execFileAsync(
    'wsl.exe',
    ['--distribution', wslDistro, '--exec', 'kill', '-TERM', String(serverBefore.pid)],
    { windowsHide: true }
  );
  let serverAfter;
  await waitFor(async () => {
    serverAfter = await readServiceRecord(serviceDataDir, 'server');
    if (!serverAfter?.pid || serverAfter.pid === serverBefore.pid) return false;
    try {
      await rpc(baseUrl, 'sessions', 'list');
      return true;
    } catch {
      return false;
    }
  }, 30_000, 'WSL Application Server replacement');
  const runtimeAfter = await readServiceRecord(serviceDataDir, 'runtime');
  assert(
    runtimeAfter?.pid === runtimeBefore.pid,
    `WSL Runtime changed across Server restart (${runtimeBefore.pid} -> ${runtimeAfter?.pid})`
  );
  await waitFor(async () => {
    const reconnects = await Promise.all(
      clients.map((client) => client.cdp.evaluate('window.__soloeReconnects'))
    );
    return reconnects.every((count) => count >= 1);
  }, 20_000, 'WSL clients to reconnect after Server replacement');
  return {
    exercised: true,
    previousServerPid: serverBefore.pid,
    replacementServerPid: serverAfter.pid,
    runtimePid: runtimeAfter.pid,
    runtimePreserved: true,
    allClientsReconnected: true
  };
}

async function readServiceRecord(dataDirectory, service) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDirectory, `${service}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function createFixtureRepository(directory, fileCount, changedCount) {
  await fs.mkdir(path.join(directory, 'src'), { recursive: true });
  await fs.mkdir(path.join(directory, 'docs', 'grill', 'alpha'), { recursive: true });
  await fs.mkdir(path.join(directory, '.scratch', 'alpha', 'issues'), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'AGENTS.md'),
    '# Fixture\n\n## Agent skills\n\nFixture configuration.\n'
  );
  await fs.writeFile(
    path.join(directory, 'docs', 'grill', 'alpha', 'coverage-map.md'),
    '# Coverage\n\n## Branches\n\n### 1. Core\n- [ ] 1A. Browser integration\n'
  );
  await fs.writeFile(
    path.join(directory, '.scratch', 'alpha', 'issues', '01-browser.md'),
    '# Browser integration\nStatus: open\n'
  );
  const batchSize = 200;
  for (let offset = 0; offset < fileCount; offset += batchSize) {
    const writes = [];
    for (let index = offset; index < Math.min(fileCount, offset + batchSize); index += 1) {
      writes.push(fs.writeFile(
        path.join(directory, 'src', `file-${String(index).padStart(5, '0')}.txt`),
        `fixture ${index}\n`
      ));
    }
    await Promise.all(writes);
  }
  await fs.writeFile(path.join(directory, 'src', 'app.ts'), 'export const value = 1;\n');
  await git(directory, ['init', '-b', 'main']);
  await git(directory, ['config', 'user.name', 'Soloe Integration']);
  await git(directory, ['config', 'user.email', 'integration@soloe.test']);
  await git(directory, ['config', 'core.autocrlf', 'false']);
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-m', 'test: create browser fixture']);
  for (let index = 0; index < changedCount; index += 1) {
    await fs.appendFile(
      path.join(directory, 'src', `file-${String(index).padStart(5, '0')}.txt`),
      `changed ${index}\n`
    );
  }
  await fs.writeFile(path.join(directory, 'src', 'app.ts'), 'export const value = 2;\n');
  await fs.writeFile(path.join(directory, 'untracked.txt'), 'browser integration\n');
}

async function createFakeOverviewAgent(directory) {
  const modulePath = path.join(directory, 'fake-overview-agent.mjs');
  await fs.writeFile(modulePath, fakeOverviewAgentSource());
  if (process.platform === 'win32') {
    const executable = path.join(directory, 'fake-codex.cmd');
    await fs.writeFile(executable, `@node "${modulePath}" %*\r\n`);
    return executable;
  }
  const executable = path.join(directory, 'fake-codex');
  await fs.writeFile(executable, `#!/usr/bin/env sh\nexec node "${modulePath}" "$@"\n`);
  await fs.chmod(executable, 0o755);
  return executable;
}

function fakeOverviewAgentSource() {
  return `let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (prompt.includes('SOLOE_E2E_CANCEL')) {
  process.stdout.write('cancel-ready');
  setInterval(() => {}, 60_000);
} else if (prompt.includes('# Conversation')) {
  process.stdout.write('stream-one ');
  setTimeout(() => {
    process.stdout.write('stream-two');
    process.exit(0);
  }, 50);
} else {
  process.stdout.write('deterministic browser integration overview');
}
`;
}

async function configureOverviewAgent(baseUrl, executable) {
  await rpc(baseUrl, 'settings', 'update', [{
    binaries: { codex: executable },
    models: {
      worktreeOverview: { provider: 'codex', id: 'gpt-5.4-mini' }
    }
  }]);
}

async function git(cwd, args) {
  await execFileAsync('git', args, { cwd });
}

async function startService(args, extraEnv, label) {
  const command = process.platform === 'win32'
    ? {
        file: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'pnpm.cmd', ...args]
      }
    : { file: 'pnpm', args };
  const child = spawn(command.file, command.args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  const logs = [];
  capture(child.stdout, logs);
  capture(child.stderr, logs);
  try {
    await waitForReady(child, logs, label);
    return child;
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}\n${label} log tail:\n${logs.slice(-30).join('')}`);
  }
}

function waitForReady(child, logs, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, 30_000);
    const onData = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (!line.includes('"ready":true')) continue;
        cleanup();
        resolve();
        return;
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`${label} exited before ready with code ${code}`));
    };
    const onError = (error) => {
      cleanup();
      reject(new Error(`${label} failed to launch: ${error.message}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function launchBrowser(url, name) {
  const debugPort = await availablePort();
  const userData = path.join(scratchRoot, `electron-${name}`);
  const child = spawn(electronPath, [
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userData}`,
    path.join(root, 'scripts', 'browser-integration-electron.mjs')
  ], {
    cwd: root,
    env: {
      ...process.env,
      SOLOE_BROWSER_INTEGRATION_URL: url
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  const logs = [];
  capture(child.stdout, logs);
  capture(child.stderr, logs);
  try {
    const target = await waitForPage(debugPort, child, logs);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await waitFor(async () => cdp.evaluate(
      `Boolean(
        window.soloe?.transport?.kind === 'browser'
        && performance.getEntriesByName('soloe:renderer-mounted').length
      )`
    ), 30_000, `browser ${name} renderer`);
    return {
      child,
      cdp,
      async close() {
        await cdp.close().catch(() => {});
        child.kill('SIGTERM');
        await waitForExit(child, 8_000);
        children.delete(child);
      }
    };
  } catch (error) {
    child.kill('SIGKILL');
    await waitForExit(child, 2_000).catch(() => {});
    throw new Error(`${error.message}\nElectron browser log tail:\n${logs.slice(-30).join('')}`);
  }
}

async function launchRemoteElectron(baseUrl, name) {
  const debugPort = await availablePort();
  const userData = path.join(scratchRoot, `electron-${name}`);
  const child = spawn(electronPath, [
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userData}`,
    root
  ], {
    cwd: root,
    env: {
      ...process.env,
      SOLOE_CLIENT_SERVER_URL: baseUrl,
      SOLOE_SERVER_TOKEN: token
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  const logs = [];
  capture(child.stdout, logs);
  capture(child.stderr, logs);
  try {
    const target = await waitForPage(debugPort, child, logs);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await waitFor(async () => cdp.evaluate(
      `Boolean(
        window.soloe?.transport?.kind === 'remote-electron'
        && performance.getEntriesByName('soloe:renderer-mounted').length
      )`
    ), 30_000, `remote Electron ${name} renderer`);
    return {
      child,
      cdp,
      async close() {
        await cdp.close().catch(() => {});
        child.kill('SIGTERM');
        await waitForExit(child, 8_000);
        children.delete(child);
      }
    };
  } catch (error) {
    child.kill('SIGKILL');
    await waitForExit(child, 2_000).catch(() => {});
    throw new Error(`${error.message}\nRemote Electron log tail:\n${logs.slice(-30).join('')}`);
  }
}

async function rpc(baseUrl, namespace, method, args = []) {
  const response = await fetch(new URL('/api/rpc', baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      namespace,
      method,
      args,
      clientId: 'browser-integration-runner'
    })
  });
  if (!response.ok) throw new Error(`RPC ${namespace}.${method} returned HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok) {
    throw new Error(`RPC ${namespace}.${method} failed: ${result.code ?? 'error'} ${result.error}`);
  }
  return result.value;
}

function capture(stream, logs) {
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk) => {
    logs.push(chunk);
    if (logs.length > 300) logs.shift();
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, 'SIGTERM');
  await waitForExit(child, 10_000);
  children.delete(child);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(timeoutMs).then(() => signalChild(child, 'SIGKILL'))
  ]);
}

function signalChild(child, signal) {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    return;
  }
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if its process group already exited.
    }
  }
  child.kill(signal);
}

async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => socket.close(resolve));
  if (!port) throw new Error('Could not allocate a local port');
  return port;
}

async function waitForPage(port, child, logs) {
  const deadline = Date.now() + 30_000;
  let lastTargets = [];
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited with code ${child.exitCode}:\n${logs.slice(-30).join('')}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        lastTargets = targets;
        const page = targets.find((target) => target.type === 'page' && target.url !== 'about:blank');
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {
      // DevTools is not listening yet.
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for the browser DevTools target; targets=${JSON.stringify(
      lastTargets.map((target) => ({ type: target.type, url: target.url }))
    )}`
  );
}

class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to DevTools')), 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('DevTools WebSocket failed'));
      }, { once: true });
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'Renderer evaluation failed'
      );
    }
    return result.result?.value;
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close();
    await new Promise((resolve) => {
      this.socket.addEventListener('close', resolve, { once: true });
      setTimeout(resolve, 500);
    });
  }
}

function parseArgs(args) {
  const values = new Map();
  for (const arg of args) {
    const match = /^--([^=]+)=(.*)$/u.exec(arg);
    if (!match) throw new Error(`Expected --name=value, received ${arg}`);
    values.set(match[1], match[2]);
  }
  return {
    largeFiles: positiveInteger(values.get('large-files') ?? '4000', 'large-files'),
    largeChanges: positiveInteger(values.get('large-changes') ?? '160', 'large-changes'),
    serverUrl: values.get('server-url'),
    webUrl: values.get('web-url'),
    serverToken: values.get('server-token'),
    smokeCwd: values.get('smoke-cwd'),
    serviceDataDir: values.get('service-data-dir'),
    wslDistro: values.get('wsl-distro'),
    runMode: values.get('run-mode') ?? nativeRunMode
  };
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runBrowserWorkflow(input) {
  const api = window.soloe;
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const unwrap = async (promise, label) => {
    const result = await promise;
    if (!result.ok) throw new Error(`${label}: ${result.code ?? 'error'} ${result.error}`);
    return result.value;
  };
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const waitUntil = async (check, timeoutMs, label) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (check()) return;
      await sleep(25);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const visible = (element) => Boolean(element && element.getClientRects().length > 0);
  const paneRoot = {
    Files: '.mobile-files-surface',
    'Working diff': '.mobile-diff-surface',
    'Feature Lab': '.mobile-feature-surface'
  };
  const measurePane = async (label, timeoutMs = 15_000, maxEventLoopGapBudgetMs = 750) => {
    const button = document.querySelector(`button[aria-label="${label}"]`);
    assert(button, `Missing ${label} rail button`);
    if (button.getAttribute('aria-pressed') === 'true') {
      button.click();
      await sleep(50);
    }
    performance.clearResourceTimings();
    const startedAt = performance.now();
    let loadingAt = null;
    let lastHeartbeat = startedAt;
    let maxEventLoopGapMs = 0;
    let heartbeatTicks = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastHeartbeat);
      lastHeartbeat = now;
      heartbeatTicks += 1;
    }, 16);
    const detectLoading = () => {
      const loading = document.querySelector(`[aria-label="Loading ${label.toLowerCase()}"]`);
      const root = document.querySelector(paneRoot[label]);
      if (
        loading
        || (root && /loading|listing|scanning|rendering \d+ of \d+/iu.test(root.textContent ?? ''))
      ) {
        loadingAt ??= performance.now();
      }
    };
    const observer = new MutationObserver(detectLoading);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    button.click();
    detectLoading();
    await sleep(0);
    await waitUntil(() => {
      const root = document.querySelector(paneRoot[label]);
      if (!visible(root)) return false;
      return !/loading|listing files|scanning|rendering \d+ of \d+/iu.test(root.textContent ?? '');
    }, timeoutMs, `${label} completion`);
    clearInterval(heartbeat);
    observer.disconnect();
    const completedAt = performance.now();
    const resources = performance.getEntriesByType('resource')
      .filter((entry) => entry.name.endsWith('/api/rpc'))
      .map((entry) => ({
        durationMs: Math.round(entry.duration * 100) / 100,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize
      }));
    const result = {
      firstLoadingStateMs: Math.round(((loadingAt ?? completedAt) - startedAt) * 100) / 100,
      completedMs: Math.round((completedAt - startedAt) * 100) / 100,
      heartbeatTicks,
      maxEventLoopGapMs: Math.round(maxEventLoopGapMs * 100) / 100,
      rpcResources: resources
    };
    assert(result.completedMs < timeoutMs, `${label} exceeded its completion budget`);
    assert(
      result.maxEventLoopGapMs < maxEventLoopGapBudgetMs,
      `${label} blocked the renderer event loop for ${result.maxEventLoopGapMs}ms`
    );
    return result;
  };
  const selectSession = async (id, name, projectId) => {
    await waitUntil(
      () => Boolean(
        document.querySelector(`[data-session-id="${CSS.escape(id)}"]`)
        || (projectId && document.querySelector(`[data-project-id="${CSS.escape(projectId)}"]`))
      ),
      10_000,
      `session ${name} sidebar data`
    );
    let row = document.querySelector(`[data-session-id="${CSS.escape(id)}"]`);
    if (!row && projectId) {
      const project = document.querySelector(
        `[data-project-id="${CSS.escape(projectId)}"]`
      );
      const toggle = project?.querySelector('button');
      assert(toggle, `Missing project for session ${name}`);
      toggle.click();
      await waitUntil(
        () => Boolean(document.querySelector(`[data-session-id="${CSS.escape(id)}"]`)),
        5_000,
        `session ${name} row`
      );
      row = document.querySelector(`[data-session-id="${CSS.escape(id)}"]`);
    }
    assert(row, `Missing session ${name}`);
    if (row.getAttribute('data-row-selected') !== 'true') row.click();
    await waitUntil(
      () => row.getAttribute('data-row-selected') === 'true',
      5_000,
      `session ${name} selection`
    );
  };

  assert(api.transport?.kind === 'browser', 'renderer did not install the browser transport');
  assert(
    !document.querySelector('button[aria-label="Browser"]'),
    'Electron-only embedded Browser pane was visible in the PWA'
  );
  for (const label of ['Minimize', 'Maximize', 'Close']) {
    assert(
      !document.querySelector(`button[aria-label="${label}"]`),
      `Electron-only ${label} window control was visible in the PWA`
    );
  }
  const sessions = await unwrap(api.sessions.list(), 'sessions.list');
  assert(sessions.some((session) => session.id === input.sessionId), 'fixture session was not loaded');
  await selectSession(input.sessionId, 'Browser fixture');

  const inspectorButton = document.querySelector('button[aria-label="Inspector"]');
  assert(inspectorButton, 'Inspector rail button is missing');
  inspectorButton.click();
  await waitUntil(
    () => visible(document.querySelector('[data-pane-slot]')) && document.body.textContent?.includes('Inspector'),
    5_000,
    'Inspector pane'
  );

  const normalPerformance = {
    files: await measurePane('Files'),
    diff: await measurePane('Working diff'),
    feature: await measurePane('Feature Lab')
  };
  const notesButton = document.querySelector('button[aria-label="Notes"]');
  assert(notesButton, 'Notes rail button is missing');
  notesButton.click();
  await waitUntil(
    () => visible(document.querySelector('.mobile-notes-surface')),
    5_000,
    'Notes pane'
  );
  notesButton.click();
  assert(document.querySelector('.rail-process'), 'Process Usage widget is missing');

  const scope = { cwd: input.normalCwd, runMode: input.runMode };
  let tree;
  const treeDeadline = performance.now() + 5_000;
  do {
    tree = await unwrap(api.files.listTree({ ...scope, force: true }), 'files.listTree');
    if (tree.paths.includes('src/app.ts')) break;
    await sleep(100);
  } while (performance.now() < treeDeadline);
  assert(tree.paths.includes('src/app.ts'), 'Files tree omitted src/app.ts');
  const original = await unwrap(
    api.files.readFile({ ...scope, relativePath: 'src/app.ts' }),
    'files.readFile'
  );
  assert(!original.binary && !original.truncated, 'Text file was not editable');
  await unwrap(
    api.files.writeFile({
      ...scope,
      relativePath: 'integration.txt',
      content: 'browser write\\n'
    }),
    'files.writeFile'
  );
  const search = await unwrap(
    api.files.search({ ...scope, query: 'integration', limit: 20 }),
    'files.search'
  );
  assert(search.some((entry) => entry.path === 'integration.txt'), 'File search missed saved file');

  let changes;
  const gitDeadline = performance.now() + 5_000;
  do {
    changes = await unwrap(
      api.git.workingChanges({ ...scope, force: true }),
      'git.workingChanges'
    );
    if (changes.changes.some((change) => change.path === 'src/app.ts')) break;
    await sleep(100);
  } while (performance.now() < gitDeadline);
  assert(changes.changes.some((change) => change.path === 'src/app.ts'), 'Diff missed app change');
  await unwrap(
    api.git.fileDiff({ ...scope, path: 'src/app.ts', contextLines: 3 }),
    'git.fileDiff'
  );
  await unwrap(api.git.stageFiles({ ...scope, paths: ['integration.txt'] }), 'git.stageFiles');
  let staged = await unwrap(
    api.git.workingChanges({ ...scope, force: true }),
    'git.workingChanges staged'
  );
  assert(
    staged.changes.some((change) => change.path === 'integration.txt' && change.staged),
    'Git stage was not reflected'
  );
  await unwrap(api.git.unstageFiles({ ...scope, paths: ['integration.txt'] }), 'git.unstageFiles');
  staged = await unwrap(
    api.git.workingChanges({ ...scope, force: true }),
    'git.workingChanges unstaged'
  );
  assert(
    staged.changes.some((change) => change.path === 'integration.txt' && !change.staged),
    'Git unstage was not reflected'
  );
  const diffButton = document.querySelector('button[aria-label="Working diff"]');
  if (diffButton?.getAttribute('aria-pressed') !== 'true') diffButton?.click();
  await sleep(500);
  const diffRow = document.querySelector('[data-file-path="src/app.ts"]');
  assert(
    diffRow,
    `Working Diff did not render the changed file: ${
      document.querySelector('.mobile-diff-surface')?.textContent?.trim().slice(0, 500)
      ?? 'surface missing'
    }`
  );
  diffRow.click();

  const note = await unwrap(
    api.notes.write(input.projectId, 'integration.md', 'browser note'),
    'notes.write'
  );
  const readNote = await unwrap(
    api.notes.read(input.projectId, note.filename),
    'notes.read'
  );
  assert(readNote.content === 'browser note', 'Notes read did not return saved content');
  await unwrap(
    api.notes.rename(input.projectId, 'integration.md', 'renamed.md'),
    'notes.rename'
  );
  const image = await unwrap(
    api.notes.saveImage(
      input.projectId,
      'image/png',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    ),
    'notes.saveImage'
  );
  const imageData = await unwrap(api.notes.readImage(image.absolutePath), 'notes.readImage');
  assert(imageData.mimeType === 'image/png', 'Notes image MIME type changed');
  await unwrap(api.notes.cleanupImages(input.projectId, []), 'notes.cleanupImages');
  await unwrap(api.notes.delete(input.projectId, 'renamed.md'), 'notes.delete');

  const feature = await unwrap(
    api.features.scan({ ...scope, slug: 'alpha' }),
    'features.scan'
  );
  assert(feature.selectedSlug === 'alpha', 'Feature Lab did not select fixture feature');
  await unwrap(
    api.features.setBranchStatus({
      ...scope,
      slug: 'alpha',
      branchId: '1A',
      status: 'resolved'
    }),
    'features.setBranchStatus'
  );
  await unwrap(
    api.features.setIssueStatus({
      ...scope,
      relativePath: '.scratch/alpha/issues/01-browser.md',
      status: 'resolved'
    }),
    'features.setIssueStatus'
  );

  const usage = await unwrap(api.system.usage({ detail: 'summary' }), 'system.usage');
  assert(usage.scope === 'backend', 'Browser usage did not report backend scope');
  const overviewRequest = {
    worktreeCwd: input.normalCwd,
    runMode: input.runMode,
    sessions: []
  };
  await unwrap(api.overview.get(overviewRequest), 'overview.get');
  const regeneratedOverview = await unwrap(
    api.overview.regenerate(overviewRequest),
    'overview.regenerate'
  );
  assert(
    regeneratedOverview.text === 'deterministic browser integration overview',
    `Overview regeneration returned unexpected text: ${regeneratedOverview.text}`
  );
  const overviewChunks = [];
  const unsubscribeOverview = api.overview.onChunk((chunk) => overviewChunks.push(chunk));
  const completedOverview = await unwrap(
    api.overview.askStart({
      ...overviewRequest,
      message: 'SOLOE_E2E_COMPLETE',
      history: []
    }),
    'overview.askStart complete'
  );
  await waitUntil(
    () => overviewChunks.some(
      (chunk) => chunk.requestId === completedOverview.requestId && chunk.type === 'done'
    ),
    10_000,
    'completed Overview stream'
  );
  const completedText = overviewChunks
    .filter((chunk) => (
      chunk.requestId === completedOverview.requestId && chunk.type === 'delta'
    ))
    .map((chunk) => chunk.text ?? '')
    .join('');
  assert(completedText === 'stream-one stream-two', 'Overview stream lost ordered chunks');
  const cancelledOverview = await unwrap(
    api.overview.askStart({
      ...overviewRequest,
      message: 'SOLOE_E2E_CANCEL',
      history: []
    }),
    'overview.askStart cancel'
  );
  await waitUntil(
    () => overviewChunks.some((chunk) => (
      chunk.requestId === cancelledOverview.requestId
      && chunk.type === 'delta'
      && chunk.text?.includes('cancel-ready')
    )),
    10_000,
    'cancellable Overview stream'
  );
  await unwrap(api.overview.askCancel(cancelledOverview.requestId), 'overview.askCancel');
  const cancelledChunkCount = overviewChunks.filter(
    (chunk) => chunk.requestId === cancelledOverview.requestId
  ).length;
  await sleep(250);
  assert(
    overviewChunks.filter(
      (chunk) => chunk.requestId === cancelledOverview.requestId
    ).length === cancelledChunkCount,
    'Overview cancellation allowed the active stream to emit more chunks'
  );
  assert(
    !overviewChunks.some((chunk) => (
      chunk.requestId === cancelledOverview.requestId
      && (chunk.type === 'done' || chunk.type === 'error')
    )),
    'Overview cancellation exposed a terminal stream event'
  );
  unsubscribeOverview();
  await unwrap(api.diagnostics.list(), 'diagnostics.list');
  await unwrap(api.diagnostics.crashLogs({ tailBytes: 4_096 }), 'diagnostics.crashLogs');

  const vault = await unwrap(
    api.vault.save({
      cwd: input.normalCwd,
      draft: {
        origin: 'https://browser-integration.test',
        username: 'browser',
        password: 'secret-value'
      }
    }),
    'vault.save'
  );
  const vaultList = await unwrap(api.vault.list({ cwd: input.normalCwd }), 'vault.list');
  assert(
    !JSON.stringify(vaultList).includes('secret-value'),
    'Vault list leaked a secret'
  );
  const secret = await unwrap(
    api.vault.getSecret({ cwd: input.normalCwd, id: vault.id }),
    'vault.getSecret'
  );
  assert(secret.password === 'secret-value', 'Explicit Vault secret read failed');
  await unwrap(
    api.vault.update({
      cwd: input.normalCwd,
      id: vault.id,
      patch: { username: 'updated-browser' }
    }),
    'vault.update'
  );
  await unwrap(api.vault.delete({ cwd: input.normalCwd, id: vault.id }), 'vault.delete');
  const integration = await unwrap(api.agentIntegration.status(), 'agentIntegration.status');
  assert(Array.isArray(integration.hosts), 'Agent integration status was not real');

  const marker = `soloe-browser-${crypto.randomUUID()}`;
  const started = await unwrap(
    api.terminal.start({ sessionId: input.sessionId, cols: 100, rows: 30 }),
    'terminal.start'
  );
  const output = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Terminal output marker timed out'));
    }, 10_000);
    const unsubscribe = api.terminal.onOutput((event) => {
      if (event.terminalId !== started.terminalId || !event.data.includes(marker)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
  await unwrap(
    api.terminal.input({
      terminalId: started.terminalId,
      data: input.runMode === 'windows'
        ? `Write-Output '${marker}'\\r\\n`
        : `printf '${marker}\\\\n'\\n`
    }),
    'terminal.input'
  );
  await output;
  const replay = await unwrap(api.terminal.replay(started.terminalId, 0), 'terminal.replay');
  assert(
    replay.data.includes(marker),
    'Terminal replay did not include the output marker'
  );

  for (const label of ['Files', 'Working diff', 'Feature Lab']) {
    const button = document.querySelector(`button[aria-label="${label}"]`);
    if (button?.getAttribute('aria-pressed') === 'true') button.click();
  }
  await sleep(100);
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'k',
    code: 'KeyK',
    ctrlKey: true,
    bubbles: true
  }));
  await waitUntil(
    () => Boolean(document.querySelector(
      'input[placeholder="Type a command or session name…"]'
    )),
    5_000,
    'command palette'
  );
  const commandInput = document.querySelector(
    'input[placeholder="Type a command or session name…"]'
  );
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  valueSetter.call(commandInput, 'Large fixture');
  commandInput.dispatchEvent(new Event('input', { bubbles: true }));
  await waitUntil(
    () => [...document.querySelectorAll('span')].some(
      (element) => element.textContent?.trim() === 'Switch to Large fixture'
    ),
    5_000,
    'large fixture command'
  );
  const largeCommand = [...document.querySelectorAll('span')].find(
    (element) => element.textContent?.trim() === 'Switch to Large fixture'
  );
  largeCommand.click();
  await sleep(100);
  const largePerformance = {
    files: await measurePane('Files', 30_000, 300),
    diff: await measurePane('Working diff', 30_000, 300),
    feature: await measurePane('Feature Lab', 30_000, 300)
  };
  const largeScope = { cwd: input.largeCwd, runMode: input.runMode };
  const largeTree = await unwrap(
    api.files.listTree({ ...largeScope, force: true }),
    'large files.listTree'
  );
  assert(
    largeTree.paths.length >= input.largeFileCount,
    'Large repository tree was unexpectedly incomplete'
  );
  const largeChanges = await unwrap(
    api.git.workingChanges({ ...largeScope, force: true }),
    'large git.workingChanges'
  );
  assert(
    largeChanges.changes.length >= input.largeChangeCount,
    'Large diff fixture did not produce enough changes'
  );
  await unwrap(api.features.scan({ ...largeScope, slug: 'alpha' }), 'large features.scan');

  return {
    transport: api.transport.kind,
    embeddedBrowserPaneHidden: true,
    panes: {
      inspector: true,
      files: true,
      diff: true,
      feature: true,
      notes: true,
      processUsage: true
    },
    workflows: {
      files: true,
      git: true,
      notes: true,
      notesImages: true,
      featureLab: true,
      processUsage: true,
      overview: {
        regenerated: true,
        streamed: true,
        cancelled: true
      },
      diagnostics: true,
      vault: true,
      agentIntegration: true
    },
    performance: {
      normal: normalPerformance,
      large: largePerformance
    },
    terminal: {
      terminalId: started.terminalId,
      marker,
      outputObserved: true,
      replayObserved: true
    }
  };
}

async function runRemoteElectronWorkflow(input) {
  const api = window.soloe;
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const unwrap = async (promise, label) => {
    const result = await promise;
    if (!result.ok) throw new Error(`${label}: ${result.code ?? 'error'} ${result.error}`);
    return result.value;
  };
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const waitUntil = async (check, timeoutMs, label) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (check()) return;
      await sleep(25);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const visible = (element) => Boolean(element && element.getClientRects().length > 0);

  assert(
    api.transport?.kind === 'remote-electron',
    'Remote Electron did not install the server transport'
  );
  await waitUntil(
    () => ['Minimize', 'Maximize', 'Close'].every((label) =>
      document.querySelector(`button[aria-label="${label}"]`)
    ),
    10_000,
    'remote Electron native window controls'
  );
  await waitUntil(
    () => Boolean(
      document.querySelector(`[data-session-id="${CSS.escape(input.sessionId)}"]`)
      || document.querySelector(`[data-project-id="${CSS.escape(input.projectId)}"]`)
    ),
    10_000,
    'remote Electron session sidebar data'
  );
  let sessionRow = document.querySelector(
    `[data-session-id="${CSS.escape(input.sessionId)}"]`
  );
  if (!sessionRow) {
    const project = document.querySelector(
      `[data-project-id="${CSS.escape(input.projectId)}"]`
    );
    project?.querySelector('button')?.click();
    await waitUntil(
      () => Boolean(document.querySelector(
        `[data-session-id="${CSS.escape(input.sessionId)}"]`
      )),
      5_000,
      'remote Electron session row'
    );
    sessionRow = document.querySelector(
      `[data-session-id="${CSS.escape(input.sessionId)}"]`
    );
  }
  assert(sessionRow, 'Remote Electron did not render the server-owned session');
  if (sessionRow.getAttribute('data-row-selected') !== 'true') sessionRow.click();
  await waitUntil(
    () => sessionRow.getAttribute('data-row-selected') === 'true',
    5_000,
    'remote Electron session selection'
  );

  const paneSelectors = {
    Inspector: '[data-pane-slot]',
    Files: '.mobile-files-surface',
    'Working diff': '.mobile-diff-surface',
    'Feature Lab': '.mobile-feature-surface',
    Notes: '.mobile-notes-surface',
    Browser: '.mobile-browser-surface'
  };
  for (const [label, selector] of Object.entries(paneSelectors)) {
    const button = document.querySelector(`button[aria-label="${label}"]`);
    assert(button, `Remote Electron is missing the ${label} pane`);
    if (button.getAttribute('aria-pressed') === 'true') {
      button.click();
      await sleep(25);
    }
    button.click();
    await waitUntil(
      () => button.getAttribute('aria-pressed') === 'true'
        && visible(document.querySelector(selector)),
      10_000,
      `remote Electron ${label} pane`
    );
    if (label === 'Browser') {
      assert(
        document.querySelector('.mobile-browser-surface webview'),
        'Remote Electron Browser pane did not mount its native webview'
      );
    }
    button.click();
  }

  const scope = { cwd: input.normalCwd, runMode: input.runMode };
  const sessions = await unwrap(api.sessions.list(), 'remote sessions.list');
  assert(
    sessions.some((session) => session.id === input.sessionId),
    'Remote Electron could not load server sessions'
  );
  await unwrap(api.projects.list(), 'remote projects.list');
  await unwrap(api.settings.get(), 'remote settings.get');
  await unwrap(api.observer.list(), 'remote observer.list');
  const tree = await unwrap(api.files.listTree({ ...scope, force: true }), 'remote files.listTree');
  assert(tree.paths.includes('src/app.ts'), 'Remote Electron Files used the wrong backend');
  await unwrap(api.git.status(scope), 'remote git.status');
  await unwrap(api.notes.list(input.projectId), 'remote notes.list');
  await unwrap(api.features.scan({ ...scope, slug: 'alpha' }), 'remote features.scan');
  const usage = await unwrap(api.system.usage({ detail: 'summary' }), 'remote system.usage');
  assert(usage.scope === 'backend', 'Remote Electron usage did not report backend scope');
  await unwrap(
    api.overview.get({ worktreeCwd: input.normalCwd, runMode: input.runMode, sessions: [] }),
    'remote overview.get'
  );
  await unwrap(api.diagnostics.list(), 'remote diagnostics.list');
  await unwrap(api.vault.list({ cwd: input.normalCwd }), 'remote vault.list');
  const integrations = await unwrap(
    api.agentIntegration.status(),
    'remote agentIntegration.status'
  );
  assert(Array.isArray(integrations.hosts), 'Remote Electron integration status was a placeholder');
  const terminals = await unwrap(api.terminal.listRunning(), 'remote terminal.listRunning');
  assert(terminals.length > 0, 'Remote Electron could not see runtime-owned terminals');

  return {
    transport: api.transport.kind,
    nativeOverrides: ['window', 'browser'],
    panes: {
      inspector: true,
      files: true,
      diff: true,
      feature: true,
      notes: true,
      embeddedBrowser: true,
      processUsage: Boolean(document.querySelector('.rail-process'))
    },
    serverBackedWorkflows: {
      sessions: true,
      projects: true,
      settings: true,
      observer: true,
      terminal: true,
      files: true,
      git: true,
      notes: true,
      features: true,
      usage: true,
      overview: true,
      diagnostics: true,
      vault: true,
      agentIntegration: true
    }
  };
}

await main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}).finally(async () => {
  for (const browser of browsers) await browser.close().catch(() => {});
  if (server) await stopChild(server).catch(() => {});
  if (runtime) await stopChild(runtime).catch(() => {});
  for (const child of children) signalChild(child, 'SIGKILL');
  if (scratchRoot) await fs.rm(scratchRoot, { recursive: true, force: true });
});
