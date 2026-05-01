import { app, BrowserWindow, shell } from 'electron';
import * as path from 'node:path';
import { OUTPUT_BATCH_INTERVAL_MS } from '@shared/types/terminal.js';
import { SessionStore } from './sessions/SessionStore.js';
import { SessionCommandBuilder } from './sessions/SessionCommandBuilder.js';
import { ShellDetector } from './terminal/ShellDetector.js';
import { TerminalOutputBatcher } from './terminal/TerminalOutputBatcher.js';
import { PtyManager } from './terminal/PtyManager.js';
import { AgentObserverManager } from './agents/AgentObserverManager.js';
import { AgentObserverStore } from './agents/AgentObserverStore.js';
import { AgentRuntimeManager } from './agents/AgentRuntimeManager.js';
import { SoloeMcpServer, type SoloeMcpServerInfo } from './agents/SoloeMcpServer.js';
import { WindowsCommandBuilder } from './runtime/WindowsCommandBuilder.js';
import { WslCommandBuilder } from './runtime/WslCommandBuilder.js';
import { SessionsIpc } from './ipc/sessions.ipc.js';
import { TerminalIpc } from './ipc/terminal.ipc.js';
import { ObserverIpc } from './ipc/observer.ipc.js';
import { SystemIpc } from './ipc/system.ipc.js';

interface AppServices {
  store: SessionStore;
  pty: PtyManager;
  observer: AgentObserverManager;
  observerStore: AgentObserverStore;
  runtime: AgentRuntimeManager;
  mcp: SoloeMcpServer;
  sessionsIpc: SessionsIpc;
  terminalIpc: TerminalIpc;
  observerIpc: ObserverIpc;
  systemIpc: SystemIpc;
}

let services: AppServices | null = null;
let mainWindow: BrowserWindow | null = null;
let cleanedUp = false;

async function setupServices(): Promise<AppServices> {
  const userDataPath = app.getPath('userData');
  const sessionsFile = path.join(userDataPath, 'sessions.json');
  const observerFile = path.join(userDataPath, 'observer.json');

  const store = new SessionStore(sessionsFile);
  await store.init();
  const observerStore = new AgentObserverStore(observerFile);
  const persistedObserverState = await observerStore.load();
  const observer = new AgentObserverManager({
    initialSnapshots: persistedObserverState.snapshots,
    initialEvents: persistedObserverState.events
  });
  observerStore.attach(observer);
  for (const session of await store.list()) observer.registerTuiSession(session);
  const runtime = new AgentRuntimeManager({ observer });
  const mcp = new SoloeMcpServer({ observer, runtime });
  let mcpInfo: SoloeMcpServerInfo | null = await mcp.start();
  const getBridgeInfo = () => mcpInfo;

  const commandBuilder = new SessionCommandBuilder(
    new ShellDetector(),
    new WindowsCommandBuilder(),
    new WslCommandBuilder()
  );

  let manager: PtyManager;
  const batcher = new TerminalOutputBatcher(OUTPUT_BATCH_INTERVAL_MS, (events) => {
    manager.forwardBatchedOutput(events);
  });
  manager = new PtyManager({
    commandBuilder,
    store,
    batcher,
    observer,
    bridgeInfo: getBridgeInfo
  });

  const sessionsIpc = new SessionsIpc({
    store,
    commandBuilder,
    observer,
    bridgeInfo: getBridgeInfo
  });
  const terminalIpc = new TerminalIpc({
    pty: manager,
    getWindows: () => BrowserWindow.getAllWindows()
  });
  const observerIpc = new ObserverIpc({
    observer,
    runtime,
    getWindows: () => BrowserWindow.getAllWindows()
  });
  const systemIpc = new SystemIpc({ store });
  sessionsIpc.register();
  terminalIpc.register();
  observerIpc.register();
  systemIpc.register();

  return {
    store,
    pty: manager,
    observer,
    observerStore,
    runtime,
    mcp,
    sessionsIpc,
    terminalIpc,
    observerIpc,
    systemIpc
  };
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: 'Soloe',
    backgroundColor: '#0f0f10',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.on('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return win;
}

async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  if (services) {
    services.sessionsIpc.dispose();
    services.terminalIpc.dispose();
    services.observerIpc.dispose();
    services.systemIpc.dispose();
    services.observerStore.dispose();
    await services.observerStore.persist(services.observer);
    await services.pty.dispose();
    await services.runtime.dispose();
    await services.mcp.stop();
    services = null;
  }
}

function ensureSingleInstance(): boolean {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  return true;
}

if (ensureSingleInstance()) {
  app.whenReady().then(async () => {
    services = await setupServices();
    mainWindow = await createWindow();

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = await createWindow();
      }
    });
  }).catch((err) => {
    console.error('Failed to start app:', err);
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (cleanedUp) return;
    event.preventDefault();
    cleanup().finally(() => app.quit());
  });

  process.on('SIGINT', () => { void cleanup().then(() => app.exit(0)); });
  process.on('SIGTERM', () => { void cleanup().then(() => app.exit(0)); });
}
