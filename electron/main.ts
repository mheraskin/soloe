import { app, BrowserWindow, Menu, shell } from 'electron';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { OUTPUT_BATCH_INTERVAL_MS } from '@shared/types/terminal.js';
import { SessionStore } from './sessions/SessionStore.js';
import { SessionCommandBuilder } from './sessions/SessionCommandBuilder.js';
import { ShellDetector } from './terminal/ShellDetector.js';
import { TerminalOutputBatcher } from './terminal/TerminalOutputBatcher.js';
import { PtyManager } from './terminal/PtyManager.js';
import { SettingsStore } from './settings/SettingsStore.js';
import { ProjectStore } from './projects/ProjectStore.js';
import { NotesStore } from './notes/NotesStore.js';
import { AgentObserverManager } from './agents/AgentObserverManager.js';
import { AgentObserverStore } from './agents/AgentObserverStore.js';
import { AgentRuntimeManager } from './agents/AgentRuntimeManager.js';
import { SoloeMcpServer, type SoloeMcpServerInfo } from './agents/SoloeMcpServer.js';
import { AgentHookDispatcher } from './agents/AgentHookDispatcher.js';
import { WindowsCommandBuilder } from './runtime/WindowsCommandBuilder.js';
import { WslCommandBuilder } from './runtime/WslCommandBuilder.js';
import { GitService } from './git/GitService.js';
import { FileSearchService } from './files/FileSearchService.js';
import { DiagnosticsService } from './diagnostics/DiagnosticsService.js';
import { SessionsIpc } from './ipc/sessions.ipc.js';
import { TerminalIpc } from './ipc/terminal.ipc.js';
import { ObserverIpc } from './ipc/observer.ipc.js';
import { SystemIpc } from './ipc/system.ipc.js';
import { SettingsIpc } from './ipc/settings.ipc.js';
import { ProjectsIpc } from './ipc/projects.ipc.js';
import { NotesIpc } from './ipc/notes.ipc.js';
import { GitIpc } from './ipc/git.ipc.js';
import { FilesIpc } from './ipc/files.ipc.js';
import { DiagnosticsIpc } from './ipc/diagnostics.ipc.js';
import { WindowIpc } from './ipc/window.ipc.js';
import { AgentIntegrationIpc } from './ipc/agent-integration.ipc.js';
import { HookInstaller } from './integrations/HookInstaller.js';

interface AppServices {
  store: SessionStore;
  settings: SettingsStore;
  projects: ProjectStore;
  notes: NotesStore;
  pty: PtyManager;
  observer: AgentObserverManager;
  observerStore: AgentObserverStore;
  runtime: AgentRuntimeManager;
  mcp: SoloeMcpServer;
  git: GitService;
  files: FileSearchService;
  diagnostics: DiagnosticsService;
  sessionsIpc: SessionsIpc;
  terminalIpc: TerminalIpc;
  observerIpc: ObserverIpc;
  systemIpc: SystemIpc;
  settingsIpc: SettingsIpc;
  projectsIpc: ProjectsIpc;
  notesIpc: NotesIpc;
  gitIpc: GitIpc;
  filesIpc: FilesIpc;
  diagnosticsIpc: DiagnosticsIpc;
  windowIpc: WindowIpc;
  agentIntegrationIpc: AgentIntegrationIpc;
}

let services: AppServices | null = null;
let mainWindow: BrowserWindow | null = null;
let cleanedUp = false;

async function setupServices(): Promise<AppServices> {
  const userDataPath = app.getPath('userData');
  const sessionsFile = path.join(userDataPath, 'sessions.json');
  const observerFile = path.join(userDataPath, 'observer.json');
  const settingsFile = path.join(userDataPath, 'settings.json');
  const projectsFile = path.join(userDataPath, 'projects.json');
  const notesDir = path.join(userDataPath, 'notes');
  const crashDir = path.join(userDataPath, 'crashes');

  const store = new SessionStore(sessionsFile);
  await store.init();
  const settings = new SettingsStore(settingsFile);
  await settings.init();
  const getBinaries = async () => (await settings.get()).binaries;
  const projects = new ProjectStore(projectsFile, {
    gitBinary: (await settings.get()).binaries.git ?? 'git'
  });
  await projects.init();
  const notes = new NotesStore(notesDir);
  const observerStore = new AgentObserverStore(observerFile);
  const persistedObserverState = await observerStore.load();
  const observer = new AgentObserverManager({
    initialSnapshots: persistedObserverState.snapshots,
    initialEvents: persistedObserverState.events
  });
  observerStore.attach(observer);
  for (const session of await store.list()) observer.registerTuiSession(session);
  const runtime = new AgentRuntimeManager({ observer });
  const hookDispatcher = new AgentHookDispatcher({
    observer,
    sessionStore: store,
    log: (message, detail) => console.warn(`[hook-dispatcher] ${message}`, detail)
  });
  const mcp = new SoloeMcpServer({
    observer,
    runtime,
    onHookEvent: (event) => hookDispatcher.dispatch(event)
  });
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
    bridgeInfo: getBridgeInfo,
    getBinaries
  });

  const sessionsIpc = new SessionsIpc({
    store,
    commandBuilder,
    observer,
    bridgeInfo: getBridgeInfo,
    getBinaries
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
  const settingsIpc = new SettingsIpc({
    store: settings,
    getWindows: () => BrowserWindow.getAllWindows()
  });
  const projectsIpc = new ProjectsIpc({
    store: projects,
    getWindows: () => BrowserWindow.getAllWindows()
  });
  const notesIpc = new NotesIpc({
    store: notes,
    getWindows: () => BrowserWindow.getAllWindows()
  });
  const git = new GitService({
    getGitBinary: async () => (await settings.get()).binaries.git
  });
  const gitIpc = new GitIpc({
    service: git,
    getWindows: () => BrowserWindow.getAllWindows()
  });
  const files = new FileSearchService({ getBinaries });
  const filesIpc = new FilesIpc({
    service: files,
    pty: manager,
    getBinaries
  });
  const diagnostics = new DiagnosticsService({
    settings,
    projects,
    git,
    crashDir
  });
  const diagnosticsIpc = new DiagnosticsIpc({ service: diagnostics });
  const windowIpc = new WindowIpc();
  const hookInstaller = new HookInstaller();
  await hookInstaller.refresh().catch((err) => {
    console.warn('failed to detect WSL hosts for hook installer:', err);
  });
  const agentIntegrationIpc = new AgentIntegrationIpc({
    installer: hookInstaller,
    getWindows: () => BrowserWindow.getAllWindows()
  });
  sessionsIpc.register();
  terminalIpc.register();
  observerIpc.register();
  systemIpc.register();
  settingsIpc.register();
  projectsIpc.register();
  notesIpc.register();
  gitIpc.register();
  filesIpc.register();
  diagnosticsIpc.register();
  windowIpc.register();
  agentIntegrationIpc.register();

  return {
    store,
    settings,
    projects,
    notes,
    pty: manager,
    observer,
    observerStore,
    runtime,
    mcp,
    git,
    files,
    diagnostics,
    sessionsIpc,
    terminalIpc,
    observerIpc,
    systemIpc,
    settingsIpc,
    projectsIpc,
    notesIpc,
    gitIpc,
    filesIpc,
    diagnosticsIpc,
    windowIpc,
    agentIntegrationIpc
  };
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    autoHideMenuBar: true,
    frame: false,
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

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isToggleCombo =
      (input.key === 'I' || input.key === 'i') &&
      input.shift &&
      (process.platform === 'darwin' ? input.meta && input.alt : input.control);
    if (isF12 || isToggleCombo) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

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
    services.settingsIpc.dispose();
    services.projectsIpc.dispose();
    services.notesIpc.dispose();
    services.gitIpc.dispose();
    services.filesIpc.dispose();
    services.diagnosticsIpc.dispose();
    services.windowIpc.dispose();
    services.agentIntegrationIpc.dispose();
    services.git.dispose();
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
    Menu.setApplicationMenu(null);
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
  process.on('uncaughtException', (err) => {
    void writeCrashLog(err).catch(() => {});
    console.error('Uncaught exception:', err);
  });
}

async function writeCrashLog(err: unknown): Promise<void> {
  const crashDir = path.join(app.getPath('userData'), 'crashes');
  await fs.mkdir(crashDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const message = err instanceof Error ? `${err.stack ?? err.message}\n` : `${String(err)}\n`;
  await fs.writeFile(path.join(crashDir, `${stamp}.log`), message, 'utf8');
}
