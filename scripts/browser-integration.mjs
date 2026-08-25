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
const nativeRunMode = process.platform === 'win32'
  ? 'windows'
  : process.platform === 'darwin'
    ? 'macos'
    : 'linux';
const config = parseArgs(process.argv.slice(2));
const serverRecord = config.serverRecord
  ? JSON.parse(await fs.readFile(config.serverRecord, 'utf8'))
  : null;
const configuredServerUrl = config.serverUrl ?? serverRecord?.address;
const token = config.serverToken ?? serverRecord?.token ?? `browser-integration-${process.pid}`;
const children = new Set();
const browsers = new Set();
let scratchRoot;
let runtime;
let server;

async function main() {
  if (config.liveInventory) {
    await runLiveMultiDeviceInventorySmoke();
    return;
  }
  if (config.liveSessionId) {
    await runLiveSessionControlSmoke();
    return;
  }
  if (configuredServerUrl) {
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
    SOLOE_TAILSCALE_DISCOVERY: '0',
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
  await first.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  });
  const mobileWorkspace = await first.cdp.evaluate(
    `(${runMobileWorkspaceWorkflow.toString()})(${JSON.stringify({
      sessionId: normalSession.id,
      terminalId: workflow.terminal.terminalId,
      colorMarker: workflow.terminal.colorMarker,
      runMode: nativeRunMode
    })})`
  );
  await first.cdp.send('Emulation.clearDeviceMetricsOverride');

  const second = await launchBrowser(`${baseUrl}/?token=${encodeURIComponent(token)}`, 'two');
  browsers.add(second);
  const remote = await launchRemoteElectron(baseUrl, 'remote');
  browsers.add(remote);
  const remoteWorkflow = await remote.cdp.evaluate(
    `(${runRemoteElectronWorkflow.toString()})(${JSON.stringify({
      projectId: normalProject.id,
      sessionId: normalSession.id,
      terminalId: workflow.terminal.terminalId,
      normalCwd: normalRepo,
      colorMarker: workflow.terminal.colorMarker,
      colorEnvMarker: workflow.terminal.colorEnvMarker,
      runMode: nativeRunMode,
      expectCustomWindowControls: process.platform !== 'darwin'
    })})`
  );
  const remoteTerminalMarker = `soloe-ghostty-remote-${Date.now()}`;
  await typeTerminalCommand(
    remote.cdp,
    nativeRunMode === 'windows'
      ? `Write-Output '${remoteTerminalMarker}'\n`
      : `printf '${remoteTerminalMarker}\\n'\n`
  );
  await waitForTerminalMarker(
    remote.cdp,
    workflow.terminal.terminalId,
    remoteTerminalMarker
  );
  remoteWorkflow.ghosttyTerminalInputObserved = true;
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
  const history = await second.cdp.evaluate(`(async () => {
    const result = await window.soloe.terminal.historySnapshot(
      ${JSON.stringify(workflow.terminal.terminalId)}
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  })()`);
  assert(
    history?.data?.includes(workflow.terminal.marker),
    'replacement browser could not read terminal history'
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
    mobileWorkspace,
    remoteElectron: remoteWorkflow,
    multiClient: {
      notesChangeObserved: true,
      remoteElectronNotesChangeObserved: true,
      reconnectObservedByAllClients: true,
      terminalSurvivedRemoteElectronClose: true,
      terminalSurvivedBrowserClose: true,
      historyRecoveredByReplacementClient: true
    }
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runLiveMultiDeviceInventorySmoke() {
  assert(configuredServerUrl, '--server-url or --server-record is required with --live-inventory');
  assert(
    config.serverToken || serverRecord?.token,
    '--server-token or --server-record is required with --live-inventory'
  );
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-live-inventory-'));
  const client = await launchRemoteElectron(configuredServerUrl, 'live-inventory');
  browsers.add(client);
  await delay(5_000);
  await client.cdp.evaluate(`(() => {
    window.__soloeLiveInventoryErrors = [];
    window.addEventListener('error', (event) => {
      window.__soloeLiveInventoryErrors.push(event.error?.stack ?? event.message);
    });
    window.addEventListener('unhandledrejection', (event) => {
      window.__soloeLiveInventoryErrors.push(event.reason?.stack ?? String(event.reason));
    });
    return true;
  })()`);
  await client.cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Show sidebar"]');
    button?.click();
    return true;
  })()`);
  await delay(1_000);
  const result = await client.cdp.evaluate(`(async () => {
    const api = window.soloe;
    const unwrap = async (promise, label) => {
      const result = await promise;
      if (!result.ok) throw new Error(\`\${label}: \${result.code ?? 'error'} \${result.error}\`);
      return result.value;
    };
    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const state = await unwrap(api.sessions.refreshDevices(), 'sessions.refreshDevices');
    const expectedProjects = state.projects.filter((project) =>
      (project.presences ?? []).some((presence) => presence.available)
      || project.workspaces.some((workspace) =>
        workspace.locations.some((location) => location.available)
      )
    );
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      if (document.querySelectorAll('[data-project-id]').length >= expectedProjects.length) break;
      await sleep(50);
    }
    const renderedProjects = [...document.querySelectorAll('[data-project-id]')].map((element) => ({
      id: element.getAttribute('data-project-id'),
      text: element.textContent?.trim() ?? ''
    }));
    const missingProjects = expectedProjects.filter((project) =>
      !renderedProjects.some((rendered) => rendered.text.includes(project.name))
    );
    const remoteDevice = state.devices.find((device) =>
      device.available && !device.local && device.name.toLowerCase() === 'xps'
    ) ?? state.devices.find((device) => device.available && !device.local);
    if (!remoteDevice) throw new Error('No available remote Device can verify Worktree data');
    const remoteWorktree = state.projects.flatMap((project) =>
      project.workspaces.flatMap((workspace) =>
        workspace.locations
          .filter((location) =>
            location.available && location.deviceId === remoteDevice.deviceId
          )
          .map((location) => ({ project, workspace, location }))
      )
    )[0];
    if (!remoteWorktree) {
      throw new Error('No available Worktree was projected for ' + remoteDevice.name);
    }
    const worktreeSession = remoteWorktree.workspace.sessions.find((projection) =>
      projection.ref.deviceId === remoteDevice.deviceId
      && projection.session.cwd === remoteWorktree.location.path
    );
    const defaultRunMode = remoteDevice.platform === 'win32'
      ? 'windows'
      : remoteDevice.platform === 'darwin'
        ? 'macos'
        : 'linux';
    const scope = {
      cwd: remoteWorktree.location.path,
      runMode: worktreeSession?.session.runMode ?? defaultRunMode,
      ...(worktreeSession?.session.wslDistro
        ? { wslDistro: worktreeSession.session.wslDistro }
        : {})
    };
    const invokeWorktree = (namespace, method, args) => unwrap(
      api.sessions.invokeWorktree({
        deviceId: remoteDevice.deviceId,
        namespace,
        method,
        args
      }),
      remoteDevice.name + ' ' + namespace + '.' + method
    );
    const [files, workingTree, features, notes, vault] = await Promise.all([
      invokeWorktree('files', 'listTree', [{ ...scope, force: true }]),
      invokeWorktree('git', 'workingTreeSnapshot', [{ ...scope, force: true }]),
      invokeWorktree('features', 'scan', [scope]),
      invokeWorktree('notes', 'list', [remoteWorktree.location.projectId]),
      invokeWorktree('vault', 'list', [{ cwd: remoteWorktree.location.path }])
    ]);
    if (!Array.isArray(files.paths)) throw new Error('Remote Files response is invalid');
    if (!Array.isArray(workingTree.workingChanges?.changes)) {
      throw new Error('Remote Working diff response is invalid');
    }
    if (!Array.isArray(features.features)) throw new Error('Remote Feature Lab response is invalid');
    if (!Array.isArray(notes)) throw new Error('Remote Notes response is invalid');
    if (!Array.isArray(vault)) throw new Error('Remote Vault response is invalid');
    const projectBoundUnassigned = state.unassigned.filter(
      (projection) => projection.session.projectId
    );
    return {
      transport: api.transport.kind,
      devices: state.devices.map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        state: device.state
      })),
      projectedProjects: expectedProjects.map((project) => project.name),
      renderedProjects: renderedProjects.map((project) => project.text.split('\\n')[0]?.trim()),
      missingProjects: missingProjects.map((project) => project.name),
      deviceFilterLabels: [...document.querySelectorAll('button[aria-label^="Show devices:"]')]
        .map((button) => button.getAttribute('aria-label')),
      filterValue: document.querySelector('input[aria-label="Filter sessions"]')?.value ?? null,
      renderedSessionCount: document.querySelectorAll('[data-session-id]').length,
      rendererErrors: window.__soloeLiveInventoryErrors ?? [],
      remoteWorktree: {
        deviceName: remoteDevice.name,
        projectName: remoteWorktree.project.name,
        cwd: remoteWorktree.location.path,
        files: files.paths.length,
        gitBranch: workingTree.status?.branch ?? null,
        workingChanges: workingTree.workingChanges.changes.length,
        features: features.features.length,
        notes: notes.length,
        vaultEntries: vault.length
      },
      projectBoundUnassigned: projectBoundUnassigned.map((projection) => ({
        name: projection.session.name,
        deviceName: projection.deviceName,
        projectId: projection.session.projectId,
        cwd: projection.session.cwd
      }))
    };
  })()`);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    liveMultiDeviceInventory: result
  }, null, 2)}\n`);
  assert(
    result.missingProjects.length === 0,
    `Sidebar omitted projected Projects: ${result.missingProjects.join(', ')}`
  );
  assert(result.rendererErrors.length === 0, 'Renderer reported errors during live inventory smoke');
}

async function runLiveSessionControlSmoke() {
  assert(config.webUrl, '--web-url is required with --live-session-id');
  assert(config.serverToken, '--server-token is required with --live-session-id');
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-live-control-'));
  const url = `${config.webUrl}/?token=${encodeURIComponent(config.serverToken)}`;
  const first = await launchBrowser(url, 'live-mac-one');
  browsers.add(first);
  const firstState = await first.cdp.evaluate(
    `(${prepareLiveSessionClient.toString()})(${JSON.stringify({
      sessionId: config.liveSessionId,
      expectReadOnly: false
    })})`
  );
  const firstMarker = `macbook-first-${Date.now()}`;
  await typeTerminalCommand(first.cdp, `printf '${firstMarker}\\n'\n`);
  await waitForTerminalMarker(first.cdp, firstState.terminalId, firstMarker);

  const second = await launchBrowser(url, 'live-mac-two');
  browsers.add(second);
  const secondState = await second.cdp.evaluate(
    `(${prepareLiveSessionClient.toString()})(${JSON.stringify({
      sessionId: config.liveSessionId,
      expectReadOnly: true
    })})`
  );
  assert(
    secondState.terminalId === firstState.terminalId,
    'MacBook clients attached to different XPS terminals'
  );
  const stability = await second.cdp.evaluate(`(async () => {
    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const row = document.querySelector(${JSON.stringify(
      `[data-session-id="${config.liveSessionId}"]`
    )});
    const takeover = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Take Over'
    );
    const newSession = document.querySelector(
      'button[aria-label*="New session" i], button[title*="New session" i]'
    );
    const deviceMenu = document.querySelector('button[aria-label^="Show devices:"]');
    const targets = [row, takeover, newSession, deviceMenu].filter(Boolean);
    let removedTargets = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const removed of record.removedNodes) {
          if (targets.some((target) => removed === target || removed.contains?.(target))) {
            removedTargets += 1;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    await sleep(31_500);
    observer.disconnect();
    return {
      sessionRowStable: row?.isConnected === true
        && document.querySelector(${JSON.stringify(
          `[data-session-id="${config.liveSessionId}"]`
        )}) === row,
      takeoverStable: takeover?.isConnected === true,
      newSessionFound: Boolean(newSession),
      newSessionStable: newSession?.isConnected === true,
      deviceMenuFound: Boolean(deviceMenu),
      deviceMenuStable: !deviceMenu || deviceMenu.isConnected,
      removedTargets
    };
  })()`);
  assert(stability.sessionRowStable, 'Periodic refresh remounted the live Session row');
  assert(stability.takeoverStable, 'Periodic refresh remounted the Take Over control');
  assert(stability.newSessionFound, 'New Session control was not rendered');
  assert(stability.newSessionStable, 'Periodic refresh remounted the New Session control');
  assert(stability.deviceMenuStable, 'Periodic refresh remounted the device dropdown');
  assert(stability.removedTargets === 0, 'Periodic refresh removed stable UI controls');

  await second.cdp.evaluate(`(async () => {
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      const button = [...document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === 'Take Over'
      );
      if (button?.getClientRects().length) {
        button.click();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    while (performance.now() < deadline) {
      const button = [...document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === 'Take Over'
      );
      if (!button?.getClientRects().length) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Take Over did not make the second MacBook client interactive');
  })()`);
  await waitFor(async () => first.cdp.evaluate(`
    [...document.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Take Over'
        && button.getClientRects().length > 0
    )
  `), 10_000, 'first MacBook client to become read-only');

  const secondMarker = `macbook-takeover-${Date.now()}`;
  await typeTerminalCommand(second.cdp, `printf '${secondMarker}\\n'\n`);
  await waitForTerminalMarker(second.cdp, secondState.terminalId, secondMarker);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      backend: config.liveBackend ?? 'remote',
      webUrl: config.webUrl
    },
    sessionId: config.liveSessionId,
    terminalId: firstState.terminalId,
    liveSessionControl: {
      firstControllerInputObserved: true,
      spectatorObserved: true,
      periodicRefreshStable: stability,
      takeoverObserved: true,
      previousControllerBecameReadOnly: true,
      takeoverControllerInputObserved: true
    }
  }, null, 2)}\n`);
}

async function typeTerminalCommand(cdp, command) {
  await cdp.evaluate(`(() => {
    const textarea = document.querySelector(
      '.terminal-surface[data-terminal-pane-role="full"] .t3-ghostty-input'
    );
    if (!textarea) throw new Error('Interactive Ghostty input is unavailable');
    textarea.focus();
    return true;
  })()`);
  const submit = command.endsWith('\n');
  await cdp.send('Input.insertText', { text: submit ? command.slice(0, -1) : command });
  if (submit) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      text: '\r',
      unmodifiedText: '\r',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
  }
}

async function waitForTerminalMarker(cdp, terminalId, marker) {
  await waitFor(async () => cdp.evaluate(`(async () => {
    const result = await window.soloe.terminal.historySnapshot(
      ${JSON.stringify(terminalId)}
    );
    return Boolean(result.ok && result.value?.data?.includes(${JSON.stringify(marker)}));
  })()`), 10_000, `terminal marker ${marker}`);
}

async function prepareLiveSessionClient(input) {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const visible = (element) => Boolean(element && element.getClientRects().length > 0);
  const deadline = performance.now() + 15_000;
  let row = null;
  while (performance.now() < deadline) {
    row = document.querySelector(`[data-session-id="${CSS.escape(input.sessionId)}"]`);
    if (row) break;
    for (const project of document.querySelectorAll('[data-project-id]')) {
      project.querySelector('button')?.click();
    }
    await sleep(100);
  }
  if (!row) throw new Error(`Live Session ${input.sessionId} was not rendered`);
  if (row.getAttribute('data-row-selected') !== 'true') row.click();
  while (performance.now() < deadline && row.getAttribute('data-row-selected') !== 'true') {
    await sleep(50);
  }
  const terminalDeadline = performance.now() + 15_000;
  let terminalId = null;
  while (performance.now() < terminalDeadline) {
    const running = await window.soloe.terminal.listRunning();
    if (running.ok) {
      terminalId = running.value.find((terminal) => terminal.sessionId === input.sessionId)?.terminalId;
    }
    const takeover = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Take Over'
    );
    if (terminalId && (input.expectReadOnly ? visible(takeover) : visible(
      document.querySelector('.t3-ghostty-input')
    ))) break;
    await sleep(50);
  }
  if (!terminalId) throw new Error('The live Session has no running terminal');
  const takeoverVisible = visible([...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Take Over'
  ));
  if (takeoverVisible !== input.expectReadOnly) {
    throw new Error(input.expectReadOnly
      ? 'Second MacBook client did not enter read-only mode'
      : 'First MacBook client unexpectedly entered read-only mode');
  }
  return { terminalId, readOnly: takeoverVisible };
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
  const baseUrl = configuredServerUrl;
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
    const history = await rpc(baseUrl, 'terminal', 'historySnapshot', [
      bootstrapTerminal.terminalId
    ]);
    return history.data.includes(readyMarker);
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
      runMode: config.runMode,
      expectCustomWindowControls: process.platform !== 'darwin'
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
  const history = await second.cdp.evaluate(`(async () => {
    const result = await window.soloe.terminal.historySnapshot(
      ${JSON.stringify(workflow.terminal.terminalId)}
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  })()`);
  assert(
    history?.data?.includes(workflow.terminal.marker),
    'replacement WSL browser could not read terminal history'
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
      historyRecoveredByReplacementClient: true,
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
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
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
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
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
    serverRecord: values.get('server-record'),
    webUrl: values.get('web-url'),
    serverToken: values.get('server-token'),
    smokeCwd: values.get('smoke-cwd'),
    serviceDataDir: values.get('service-data-dir'),
    wslDistro: values.get('wsl-distro'),
    liveInventory: values.get('live-inventory') === '1',
    liveSessionId: values.get('live-session-id'),
    liveBackend: values.get('live-backend'),
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

async function runMobileWorkspaceWorkflow(input) {
  const api = window.soloe;
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
  };
  const waitUntil = async (check, timeoutMs, label) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const page = () => document.querySelector('.mobile-workspace')?.getAttribute('data-page');
  const mode = () => document.querySelector('.mobile-workspace')?.getAttribute('data-mode');

  await waitUntil(
    () => page() === 'workspace' && mode() === 'terminal',
    5_000,
    'mobile terminal workspace'
  );
  assert(!document.querySelector('.app-titlebar'), 'Mobile rendered the shared application title bar');
  assert(!document.querySelector('button[aria-label="Inspector"]'), 'Inspector still exists on mobile');
  assert(visible(document.querySelector('.mobile-workspace-dock')), 'Mobile workspace dock is hidden');
  assert(
    document.querySelectorAll('.mobile-page-indicator button').length === 2,
    'Mobile rendered more than the Sessions and Workspace pages'
  );
  const escapedSessionId = CSS.escape(input.sessionId);
  const sessionRow = document.querySelector(
    `[data-session-id="${escapedSessionId}"], [data-session-id$="/${escapedSessionId}"]`
  );
  assert(sessionRow, 'Mobile terminal fixture session is missing');
  if (sessionRow.getAttribute('data-row-selected') !== 'true') sessionRow.click();
  await waitUntil(
    () => sessionRow.getAttribute('data-row-selected') === 'true'
      && page() === 'workspace'
      && mode() === 'terminal',
    5_000,
    'mobile terminal session'
  );
  try {
    await waitUntil(
      () => document.querySelector(
        '.terminal-surface[data-terminal-pane-role="full"] .ghostty-terminal-host canvas'
      ),
      15_000,
      'mobile terminal renderer'
    );
  } catch (error) {
    const surfaces = [...document.querySelectorAll('.terminal-surface')].map((surface) => ({
      role: surface.getAttribute('data-terminal-pane-role'),
      text: surface.textContent?.trim().slice(0, 160) ?? '',
      ghostty: Boolean(surface.querySelector('.ghostty-terminal-host canvas'))
    }));
    throw new Error(`${error.message}; surfaces=${JSON.stringify(surfaces)}`);
  }
  const terminalFitsViewport = () => {
    const terminalHost = document.querySelector(
      '.terminal-surface[data-terminal-pane-role="full"] .ghostty-terminal-host'
    );
    const terminalCanvas = document.querySelector(
      '.terminal-surface[data-terminal-pane-role="full"] .ghostty-terminal-host canvas'
    );
    if (!terminalHost || !terminalCanvas) return false;
    const terminalHostRect = terminalHost.getBoundingClientRect();
    const terminalCanvasRect = terminalCanvas.getBoundingClientRect();
    return terminalCanvasRect.width <= terminalHostRect.width + 1
      && terminalHostRect.right <= window.innerWidth + 1;
  };
  await waitUntil(
    terminalFitsViewport,
    15_000,
    'mobile terminal to fit its viewport'
  );

  const root = document.documentElement;
  const ghosttyCanvas = document.querySelector(
    '.terminal-surface[data-terminal-pane-role="full"] .ghostty-terminal-host canvas'
  );
  const ghosttyRoot = document.querySelector(
    '.terminal-surface[data-terminal-pane-role="full"] .ghostty-terminal-host'
  );
  const ghosttyInput = ghosttyRoot?.querySelector('.t3-ghostty-input');
  const ghosttyScrollbar = ghosttyRoot?.querySelector('[role="scrollbar"]');
  assert(
    ghosttyCanvas && ghosttyRoot && ghosttyInput && ghosttyScrollbar,
    'Mobile terminal keyboard surfaces are missing'
  );
  const ansiRedPixelCount = () => {
    const context = ghosttyCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, ghosttyCanvas.width, ghosttyCanvas.height).data;
    let redPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      if (red >= green + 60 && red >= blue + 60) redPixels += 1;
    }
    return redPixels;
  };
  await waitUntil(
    () => ansiRedPixelCount() >= 100,
    5_000,
    `ANSI color replay for ${input.colorMarker}`
  );
  const scrollbarValue = () => Number(ghosttyScrollbar.getAttribute('aria-valuenow'));
  await waitUntil(
    () => Number(ghosttyScrollbar.getAttribute('aria-valuemax')) > 0
      && Number.isFinite(scrollbarValue()),
    5_000,
    'mobile terminal scrollback'
  );
  const scrollBeforeTouch = scrollbarValue();
  const touch = (type, clientY, buttons) => ghosttyCanvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: 'touch',
    pointerId: 41,
    isPrimary: true,
    button: 0,
    buttons,
    clientX: 190,
    clientY
  }));
  touch('pointerdown', 220, 1);
  for (const clientY of [250, 285, 325]) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    touch('pointermove', clientY, 1);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  touch('pointerup', 360, 0);
  await waitUntil(
    () => scrollbarValue() < scrollBeforeTouch,
    2_000,
    'finger drag to move terminal scrollback'
  );
  const scrollAtRelease = scrollbarValue();
  await waitUntil(
    () => scrollbarValue() < scrollAtRelease,
    1_000,
    'terminal touch momentum after release'
  );
  assert(page() === 'workspace', 'Vertical terminal swipe triggered workspace navigation');
  const tap = (type, buttons) => ghosttyCanvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: 'touch',
    pointerId: 42,
    isPrimary: true,
    button: 0,
    buttons,
    clientX: 190,
    clientY: 220
  }));
  tap('pointerdown', 1);
  tap('pointerup', 0);
  await waitUntil(
    () => document.activeElement === ghosttyInput,
    2_000,
    'mobile terminal input focus'
  );
  const ghosttyBeforeKeyboard = ghosttyRoot.getBoundingClientRect();
  const previousAppHeight = root.style.getPropertyValue('--app-height');
  const previousAppTop = root.style.getPropertyValue('--app-top');
  const keyboardHeight = 300;
  const visibleViewportHeight = Math.max(320, Math.round(window.innerHeight - keyboardHeight));
  root.style.setProperty('--app-height', `${visibleViewportHeight}px`);
  root.style.setProperty('--app-top', '0px');
  root.style.setProperty('--keyboard-inset', '300px');
  root.setAttribute('data-mobile-keyboard-open', '');
  window.dispatchEvent(new CustomEvent('soloe:rail-layout', {
    detail: { keyboardOpen: true, keyboardClosed: false }
  }));
  try {
    await waitUntil(() => {
      const hostRect = ghosttyRoot.getBoundingClientRect();
      const inputRect = ghosttyInput.getBoundingClientRect();
      return hostRect.bottom <= visibleViewportHeight + 1
        && inputRect.bottom <= visibleViewportHeight + 1;
    }, 5_000, 'mobile terminal above the virtual keyboard');
  } catch (error) {
    const geometry = {
      visibleViewportHeight,
      innerHeight: window.innerHeight,
      appHeight: root.style.getPropertyValue('--app-height'),
      appTop: root.style.getPropertyValue('--app-top'),
      shell: document.querySelector('.app-shell')?.getBoundingClientRect().toJSON(),
      workspace: document.querySelector('.mobile-workspace')?.getBoundingClientRect().toJSON(),
      host: ghosttyRoot.getBoundingClientRect().toJSON(),
      input: ghosttyInput.getBoundingClientRect().toJSON(),
      inputStyle: { left: ghosttyInput.style.left, top: ghosttyInput.style.top },
      canvas: {
        width: ghosttyCanvas.width,
        height: ghosttyCanvas.height,
        clientWidth: ghosttyCanvas.clientWidth,
        clientHeight: ghosttyCanvas.clientHeight
      }
    };
    throw new Error(`${error.message}; geometry=${JSON.stringify(geometry)}`);
  }
  const ghosttyWithKeyboard = ghosttyRoot.getBoundingClientRect();
  assert(
    Math.abs(ghosttyBeforeKeyboard.width - ghosttyWithKeyboard.width) <= 1
      && ghosttyWithKeyboard.height >= 120
      && ghosttyWithKeyboard.height < ghosttyBeforeKeyboard.height - 80,
    'Mobile keyboard did not refit the terminal into its visible viewport'
  );
  assert(
    ghosttyCanvas.getAttribute('aria-hidden') === 'true'
      && ghosttyInput.getAttribute('aria-label') === 'Terminal input'
      && ghosttyInput.getAttribute('inputmode') === 'text'
      && ghosttyInput.getAttribute('enterkeyhint') === 'enter'
      && ghosttyInput.getAttribute('autocorrect') === 'off'
      && document.activeElement === ghosttyInput,
    'Mobile Ghostty accessibility surfaces were not configured'
  );
  const mobileInputMarker = `soloe-mobile-input-${crypto.randomUUID()}`;
  const mobileOutput = new Promise((resolve, reject) => {
    let observed = '';
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Mobile terminal input marker timed out'));
    }, 10_000);
    const unsubscribe = api.terminal.onOutput((event) => {
      if (event.terminalId !== input.terminalId) return;
      observed += event.data;
      if (!observed.includes(mobileInputMarker)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
  ghosttyInput.value = input.runMode === 'windows'
    ? `Write-Output '${mobileInputMarker}'\r\n`
    : `printf '${mobileInputMarker}\\n'\n`;
  ghosttyInput.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    data: ghosttyInput.value,
    inputType: 'insertText'
  }));
  await mobileOutput;
  assert(
    document.activeElement === ghosttyInput,
    'Mobile terminal lost keyboard focus while delivering input'
  );
  root.removeAttribute('data-mobile-keyboard-open');
  root.style.removeProperty('--keyboard-inset');
  if (previousAppHeight) root.style.setProperty('--app-height', previousAppHeight);
  else root.style.removeProperty('--app-height');
  if (previousAppTop) root.style.setProperty('--app-top', previousAppTop);
  else root.style.removeProperty('--app-top');
  window.dispatchEvent(new CustomEvent('soloe:rail-layout', {
    detail: { keyboardOpen: false, keyboardClosed: true }
  }));
  await waitUntil(
    () => ghosttyRoot.getBoundingClientRect().height >= ghosttyBeforeKeyboard.height - 1,
    5_000,
    'mobile terminal after keyboard dismissal'
  );

  const activeIndicatorIsCentered = () => {
    const indicator = document.querySelector('.mobile-page-indicator');
    const activeDot = indicator?.querySelector('button.active span');
    if (!indicator || !activeDot) return false;
    const indicatorRect = indicator.getBoundingClientRect();
    const activeDotRect = activeDot.getBoundingClientRect();
    return Math.abs(
      (activeDotRect.left + activeDotRect.width / 2)
        - (indicatorRect.left + indicatorRect.width / 2)
    ) <= 1;
  };

  const files = document.querySelector('.mobile-pane-destination[aria-label="Files"]');
  assert(files, 'Mobile Files destination is missing');
  files.click();
  await waitUntil(
    () => page() === 'workspace'
      && mode() === 'pane'
      && document.querySelectorAll('[data-pane-slot]').length === 1
      && visible(document.querySelector('.mobile-files-surface')),
    10_000,
    'mobile Files page'
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const terminalSurface = document.querySelector('.mobile-workspace-terminal');
  const paneSurface = document.querySelector('.mobile-workspace-pane');
  const terminalRenderer = document.querySelector(
    '.terminal-surface[data-terminal-pane-role="full"] .ghostty-terminal-host'
  );
  assert(terminalSurface && paneSurface && terminalRenderer, 'Mobile workspace surfaces are missing');
  const terminalSurfaceRect = terminalSurface.getBoundingClientRect();
  const paneSurfaceRect = paneSurface.getBoundingClientRect();
  const terminalRendererRect = terminalRenderer.getBoundingClientRect();
  assert(
    Math.abs(terminalSurfaceRect.left - paneSurfaceRect.left) <= 1
      && Math.abs(terminalSurfaceRect.right - paneSurfaceRect.right) <= 1
      && terminalRendererRect.width > 0
      && terminalRendererRect.right > 0,
    'Mobile pane replaced the terminal with a side workspace instead of overlaying it'
  );

  files.click();
  await waitUntil(
    () => mode() === 'terminal' && files.getAttribute('aria-pressed') === 'false',
    5_000,
    'selected mobile Files pane to toggle back to terminal'
  );
  await waitUntil(
    terminalFitsViewport,
    5_000,
    'mobile terminal to remain rendered after closing a pane'
  );

  files.click();
  await waitUntil(
    () => mode() === 'pane' && files.getAttribute('aria-pressed') === 'true',
    5_000,
    'mobile Files pane to reopen'
  );

  const notes = document.querySelector('.mobile-pane-destination[aria-label="Notes"]');
  assert(notes, 'Mobile Notes destination is missing');
  notes.click();
  await waitUntil(
    () => page() === 'workspace'
      && mode() === 'pane'
      && document.querySelectorAll('[data-pane-slot]').length === 1
      && visible(document.querySelector('.mobile-notes-surface')),
    10_000,
    'mobile Notes replacement'
  );
  assert(
    files.getAttribute('aria-pressed') === 'false'
      && notes.getAttribute('aria-pressed') === 'true',
    'Mobile allowed more than one pane to remain active'
  );

  document.querySelector('.mobile-pane-destination[aria-label="Terminal"]')?.click();
  await waitUntil(
    () => page() === 'workspace' && mode() === 'terminal',
    5_000,
    'mobile terminal tool'
  );
  await waitUntil(
    terminalFitsViewport,
    5_000,
    'mobile terminal refit after returning from a pane'
  );
  const workspace = document.querySelector('.mobile-workspace');
  assert(workspace, 'Mobile workspace root is missing');
  const swipe = (fromX, toX, pointerId) => {
    workspace.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      pointerType: 'touch',
      pointerId,
      isPrimary: true,
      clientX: fromX,
      clientY: 300
    }));
    workspace.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      pointerType: 'touch',
      pointerId,
      isPrimary: true,
      clientX: toX,
      clientY: 302
    }));
  };
  swipe(120, 310, 1);
  await waitUntil(() => page() === 'navigation', 5_000, 'swipe to session list');
  await waitUntil(
    activeIndicatorIsCentered,
    1_000,
    'active Sessions dot to settle in the center'
  );
  swipe(310, 90, 2);
  await waitUntil(
    () => page() === 'workspace' && mode() === 'terminal',
    5_000,
    'swipe back to workspace'
  );
  await waitUntil(
    activeIndicatorIsCentered,
    1_000,
    'active Workspace dot to settle in the center'
  );

  let serviceWorkerReady = false;
  if ('serviceWorker' in navigator) {
    serviceWorkerReady = await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000))
    ]);
  }

  return {
    sharedTitlebarHidden: true,
    inspectorRemoved: true,
    singlePaneReplacement: true,
    paneOverlay: true,
    selectedPaneToggle: true,
    centeredActiveIndicator: true,
    visibleKeyboardTerminal: true,
    mobileGhosttyInputObserved: true,
    ansiColorReplay: true,
    ghosttyAccessibilitySurface: true,
    terminalScrollbarControl: true,
    touchTerminalScroll: true,
    inertialTerminalScroll: true,
    twoPageNavigation: true,
    swipeNavigation: true,
    serviceWorkerReady
  };
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
    try {
      await waitUntil(() => {
        const root = document.querySelector(paneRoot[label]);
        if (!visible(root)) return false;
        if (label === 'Working diff') {
          return Boolean(root.querySelector('[data-file-path]'));
        }
        return !/loading|listing files|scanning|rendering \d+ of \d+/iu.test(root.textContent ?? '');
      }, timeoutMs, `${label} completion`);
    } catch (error) {
      const root = document.querySelector(paneRoot[label]);
      throw new Error(`${error.message}; pressed=${button.getAttribute('aria-pressed')}; visible=${
        visible(root)
      }; text=${JSON.stringify(root?.textContent?.trim().slice(0, 500) ?? '')}`);
    }
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
    const escapedId = CSS.escape(id);
    const sessionSelector = `[data-session-id="${escapedId}"], [data-session-id$="/${escapedId}"]`;
    await waitUntil(
      () => Boolean(
        document.querySelector(sessionSelector)
        || (projectId && document.querySelector(`[data-project-id="${CSS.escape(projectId)}"]`))
      ),
      10_000,
      `session ${name} sidebar data`
    );
    let row = document.querySelector(sessionSelector);
    if (!row && projectId) {
      const project = document.querySelector(
        `[data-project-id="${CSS.escape(projectId)}"]`
      );
      const toggle = project?.querySelector('button');
      assert(toggle, `Missing project for session ${name}`);
      const isOpen = (button) => button.getAttribute('data-state') === 'open'
        || button.getAttribute('aria-expanded') === 'true';
      if (!isOpen(toggle)) toggle.click();
      await sleep(0);
      for (const worktreeToggle of document.querySelectorAll(
        'button[aria-label^="Toggle worktree "]'
      )) {
        if (!isOpen(worktreeToggle)) worktreeToggle.click();
      }
      await waitUntil(
        () => Boolean(document.querySelector(sessionSelector)),
        5_000,
        `session ${name} row`
      );
      row = document.querySelector(sessionSelector);
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
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: '+',
    code: 'Equal',
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  }));
  await sleep(0);
  assert(
    document.documentElement.style.zoom === '1.1',
    'Web Ctrl+plus did not apply local page zoom'
  );
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: '-',
    code: 'Minus',
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  }));
  await sleep(0);
  assert(
    document.documentElement.style.zoom === '',
    'Web Ctrl+minus did not restore local page zoom'
  );
  const sessions = await unwrap(api.sessions.list(), 'sessions.list');
  assert(sessions.some((session) => session.id === input.sessionId), 'fixture session was not loaded');
  await selectSession(input.sessionId, 'Browser fixture', input.projectId);

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
  const colorMarker = `soloe-ansi-color-${crypto.randomUUID()}`;
  const colorEnvMarker = `soloe-color-env-${crypto.randomUUID()}`;
  const started = await unwrap(
    api.terminal.start({ sessionId: input.sessionId, cols: 100, rows: 30 }),
    'terminal.start'
  );
  let inputLease = null;
  const initialLeaseDeadline = performance.now() + 5_000;
  do {
    inputLease = await unwrap(
      api.terminal.currentInputLease(started.terminalId),
      'terminal.currentInputLease'
    );
    if (inputLease) break;
    await sleep(50);
  } while (performance.now() < initialLeaseDeadline);
  if (!inputLease) {
    inputLease = await unwrap(
      api.terminal.acquireInputLease(started.terminalId, {
        deviceId: `browser-integration-${crypto.randomUUID()}`,
        deviceName: 'Browser integration'
      }, true),
      'terminal.acquireInputLease'
    );
  }
  const control = {
    sessionId: inputLease.sessionId,
    ownerDeviceId: inputLease.ownerDeviceId,
    controllerDeviceId: inputLease.controllerDeviceId,
    leaseId: inputLease.leaseId
  };
  await unwrap(
    api.terminal.setOutputDemand({ terminalId: started.terminalId, active: true }),
    'terminal.setOutputDemand'
  );
  const ansiColorOutput = `\u001b[31m${colorMarker}\u001b[0m`;
  const output = new Promise((resolve, reject) => {
    let observed = '';
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Terminal output marker timed out'));
    }, 10_000);
    const unsubscribe = api.terminal.onOutput((event) => {
      if (event.terminalId !== started.terminalId) return;
      observed += event.data;
      // The PTY echoes the command before executing it. Wait for the actual
      // SGR output so the retained-history assertion cannot race that echo.
      if (
        !observed.includes(ansiColorOutput)
        || !observed.includes(colorEnvMarker)
        || !observed.includes(marker)
      ) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
  await unwrap(
    api.terminal.input({
      terminalId: started.terminalId,
      data: input.runMode === 'windows'
        ? `if (Test-Path Env:NO_COLOR) { Write-Output 'soloe-color-env-blocked' } else { Write-Output '${colorEnvMarker}' }; 1..160 | ForEach-Object { Write-Output \"soloe-scroll-$($_)\" }; $e=[char]27; Write-Output \"$($e)[31m${colorMarker}$($e)[0m\"; Write-Output '${marker}'\r\n`
        : `if [ -z \"\${NO_COLOR+x}\" ]; then printf '${colorEnvMarker}\\n'; else printf 'soloe-color-env-blocked\\n'; fi; for i in $(seq 1 160); do printf 'soloe-scroll-%s\\n' \"$i\"; done; printf '\\033[31m${colorMarker}\\033[0m\\n'; printf '${marker}\\n'\n`,
      control
    }),
    'terminal.input'
  );
  await output;
  const history = await unwrap(api.terminal.historySnapshot(started.terminalId), 'terminal.historySnapshot');
  assert(
    history.data.includes(marker),
    'Terminal history did not include the output marker'
  );
  assert(
    history.data.includes(ansiColorOutput),
    'Terminal history did not preserve ANSI color sequences'
  );
  assert(
    history.data.includes(colorEnvMarker),
    'Terminal process inherited NO_COLOR and disabled application colors'
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

  await selectSession(input.sessionId, 'Browser fixture', input.projectId);
  const leaseDeadline = performance.now() + 5_000;
  do {
    inputLease = await unwrap(
      api.terminal.currentInputLease(started.terminalId),
      'terminal.currentInputLease restored selection'
    );
    if (inputLease) break;
    await sleep(50);
  } while (performance.now() < leaseDeadline);
  assert(inputLease, 'Selected terminal did not reacquire input control');

  return {
    transport: api.transport.kind,
    embeddedBrowserPaneHidden: true,
    panes: {
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
      colorMarker,
      colorEnvMarker,
      inputLease,
      outputObserved: true,
      historyObserved: true
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
  if (input.expectCustomWindowControls) {
    await waitUntil(
      () => ['Minimize', 'Maximize', 'Close'].every((label) =>
        document.querySelector(`button[aria-label="${label}"]`)
      ),
      10_000,
      'remote Electron custom window controls'
    );
  }
  const showSidebar = document.querySelector('button[aria-label="Show sidebar"]');
  if (showSidebar) showSidebar.click();
  await sleep(100);
  let sessionRow = document.querySelector(
    `[data-session-id="${CSS.escape(input.sessionId)}"], [data-session-id$="::${CSS.escape(input.sessionId)}"], [data-session-id$="/${CSS.escape(input.sessionId)}"]`
  );
  if (!sessionRow && document.querySelector('.app-sidebar')) {
    const isOpen = (button) => button.getAttribute('data-state') === 'open'
      || button.getAttribute('aria-expanded') === 'true';
    for (const project of document.querySelectorAll('[data-project-id]')) {
      const toggle = project.querySelector('button');
      if (toggle && !isOpen(toggle)) toggle.click();
    }
    await sleep(0);
    for (const worktreeToggle of document.querySelectorAll(
      'button[aria-label^="Toggle worktree "]'
    )) {
      if (!isOpen(worktreeToggle)) worktreeToggle.click();
    }
    await waitUntil(
      () => Boolean(document.querySelector(
        `[data-session-id="${CSS.escape(input.sessionId)}"], [data-session-id$="::${CSS.escape(input.sessionId)}"], [data-session-id$="/${CSS.escape(input.sessionId)}"]`
      )),
      5_000,
      'remote Electron session row'
    );
    sessionRow = document.querySelector(
      `[data-session-id="${CSS.escape(input.sessionId)}"], [data-session-id$="::${CSS.escape(input.sessionId)}"], [data-session-id$="/${CSS.escape(input.sessionId)}"]`
    );
  }
  if (sessionRow) {
    if (sessionRow.getAttribute('data-row-selected') !== 'true') sessionRow.click();
    await waitUntil(
      () => sessionRow.getAttribute('data-row-selected') === 'true',
      5_000,
      'remote Electron session selection'
    );
  } else {
    const state = await unwrap(api.sessions.deviceState(), 'remote sessions.deviceState');
    const projected = [
      ...state.unassigned,
      ...state.projects.flatMap((project) =>
        project.workspaces.flatMap((workspace) => workspace.sessions)
      )
    ];
    assert(
      projected.some((session) => session.ref.sessionId === input.sessionId),
      'Remote Electron could not load the server-owned session projection'
    );
  }
  try {
    await waitUntil(
      () => visible([...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Take Over'
      )) || Boolean(document.querySelector(
        '.terminal-surface[data-terminal-pane-role="full"] .ghostty-terminal-host[data-ghostty-ready="true"]'
      )),
      10_000,
      'remote Electron terminal control state'
    );
  } catch (error) {
    const running = await unwrap(api.terminal.listRunning(), 'remote terminal.listRunning diagnostic');
    const runningTerminal = running.find((terminal) => terminal.sessionId === input.sessionId);
    const lease = runningTerminal
      ? await unwrap(
        api.terminal.currentInputLease(runningTerminal.terminalId),
        'remote terminal.currentInputLease diagnostic'
      )
      : null;
    const diagnostics = {
      selected: sessionRow?.getAttribute('data-row-selected') ?? null,
      runningTerminal,
      lease,
      surfaces: [...document.querySelectorAll('.terminal-surface')].map((surface) => ({
        role: surface.getAttribute('data-terminal-pane-role'),
        visible: visible(surface),
        ghostty: Boolean(surface.querySelector('.ghostty-terminal-host canvas')),
        text: surface.textContent?.trim().slice(0, 160) ?? ''
      }))
    };
    throw new Error(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}`);
  }
  const takeoverButton = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Take Over'
  );
  const terminalControlTakeover = visible(takeoverButton);
  if (terminalControlTakeover) {
    takeoverButton.click();
    await waitUntil(
      () => !visible([...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Take Over'
      )),
      10_000,
      'remote Electron terminal control takeover'
    );
  }
  await waitUntil(
    () => Boolean(document.querySelector(
      '.terminal-surface[data-terminal-pane-role="full"] .ghostty-terminal-host[data-ghostty-ready="true"]'
    )),
    10_000,
    'remote Electron Ghostty surface'
  );
  const colorHistory = await unwrap(
    api.terminal.historySnapshot(input.terminalId),
    'remote terminal ANSI history'
  );
  assert(
    colorHistory.data.includes(`\u001b[31m${input.colorMarker}\u001b[0m`),
    'Remote Electron terminal history lost ANSI foreground sequences'
  );
  assert(
    colorHistory.data.includes(input.colorEnvMarker),
    'Remote Electron terminal inherited NO_COLOR from its launcher'
  );
  const colorCanvas = document.querySelector(
    '.terminal-surface[data-terminal-pane-role="full"] .ghostty-terminal-host canvas'
  );
  assert(colorCanvas, 'Remote Electron Ghostty canvas is missing');
  const ansiForegroundPixels = () => {
    const context = colorCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, colorCanvas.width, colorCanvas.height).data;
    let redPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      if (red >= green + 60 && red >= blue + 60) redPixels += 1;
    }
    return redPixels;
  };
  await waitUntil(
    () => ansiForegroundPixels() >= 100,
    5_000,
    'remote Electron ANSI foreground rendering'
  );

  const paneSelectors = {
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
    terminalControlTakeover,
    terminalControlReady: true,
    terminalColorEnvironment: true,
    ansiForegroundRender: true,
    nativeOverrides: input.expectCustomWindowControls ? ['window', 'browser'] : ['browser'],
    panes: {
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
