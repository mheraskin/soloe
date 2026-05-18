import { app, BrowserWindow, Menu, Notification, shell } from 'electron';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
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
import { AutoRenameService } from './agents/AutoRenameService.js';
import { CommentsBridge } from './comments/CommentsBridge.js';
import { DiffBridge } from './agents/DiffBridge.js';
import { BridgePersistence, type BridgeConfig } from './integrations/BridgePersistence.js';
import { Notifier } from './notify/Notifier.js';
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
import { probeWslMcpHostname } from './integrations/WslHostDetector.js';
import { SessionTranscriptReader } from './overview/SessionTranscriptReader.js';
import { WorktreeFactsCollector } from './overview/WorktreeFactsCollector.js';
import { SummaryCacheStore } from './overview/SummaryCacheStore.js';
import { WorktreeOverviewService } from './overview/WorktreeOverviewService.js';
import { OverviewIpc } from './ipc/overview.ipc.js';

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
  commentsBridge: CommentsBridge;
  diffBridge: DiffBridge;
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
  overviewService: WorktreeOverviewService;
  overviewIpc: OverviewIpc;
}

let services: AppServices | null = null;
let mainWindow: BrowserWindow | null = null;
let cleanedUp = false;

interface DiffIntent {
  commits?: string[];
  base?: string;
  head?: string;
  cwd?: string;
  focusPath?: string;
}

// Populated when soloe is launched with `--diff …` argv. Drained after the
// renderer signals it's ready (via did-finish-load on the main window) so the
// diff bridge can route the intent through MCP-style dispatch.
let pendingDiffIntent: DiffIntent | null = null;

const PACKAGED_APP_ID = 'com.soloe.app';

function resolveAppId(): string {
  if (app.isPackaged) return PACKAGED_APP_ID;
  return process.platform === 'win32' ? process.execPath : `${PACKAGED_APP_ID}.dev`;
}

function resolveIconPath(iconFilenames: string[]): string {
  const candidates = app.isPackaged
    ? iconFilenames.flatMap((filename) => [
        path.join(process.resourcesPath, 'build', filename),
        path.join(app.getAppPath(), 'build', filename)
      ])
    : iconFilenames.flatMap((filename) => [
        path.join(process.cwd(), 'build', filename),
        path.join(app.getAppPath(), 'build', filename),
        path.join(__dirname, '../../build', filename)
      ]);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function resolveAppIcon(): string {
  return resolveIconPath(process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon.png', 'icon.ico']);
}

function resolveNotificationIcon(): string {
  return resolveIconPath(['icon.png', 'icon.ico']);
}

function quoteWindowsShortcutArg(value: string): string {
  if (!/[ \t"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/\\+$/u, '$&$&')}"`;
}

function windowsRelaunchCommand(): string {
  return [process.execPath, ...process.argv.slice(1)].map(quoteWindowsShortcutArg).join(' ');
}

function ensureWindowsDevShellShortcut(appIcon: string): void {
  if (process.platform !== 'win32' || app.isPackaged) return;

  const shortcutPath = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Soloe Dev.lnk'
  );
  const args = process.argv.slice(1).map(quoteWindowsShortcutArg).join(' ');

  try {
    mkdirSync(path.dirname(shortcutPath), { recursive: true });
    const written = shell.writeShortcutLink(shortcutPath, 'replace', {
      target: process.execPath,
      args,
      cwd: process.cwd(),
      description: 'Soloe development preview',
      icon: appIcon,
      iconIndex: 0,
      appUserModelId: resolveAppId()
    });
    if (!written) {
      console.warn(`[windows-shell] failed to create ${shortcutPath}`);
    }
  } catch (err) {
    console.warn('[windows-shell] failed to create development shortcut', err);
  }
}

if (process.platform === 'win32') {
  app.setAppUserModelId(resolveAppId());
}

async function setupServices(): Promise<AppServices> {
  const userDataPath = app.getPath('userData');
  const sessionsFile = path.join(userDataPath, 'sessions.json');
  const observerFile = path.join(userDataPath, 'observer.json');
  const settingsFile = path.join(userDataPath, 'settings.json');
  const projectsFile = path.join(userDataPath, 'projects.json');
  const notesDir = path.join(userDataPath, 'notes');
  const crashDir = path.join(userDataPath, 'crashes');
  const overviewCacheFile = path.join(userDataPath, 'overview-cache.json');
  const bridgeFile = path.join(userDataPath, 'bridge.json');
  const bridgePersistence = new BridgePersistence(bridgeFile);

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
  const notifier = new Notifier({
    getWindows: () => BrowserWindow.getAllWindows(),
    nativeFactory: (notification) => new Notification(notification),
    defaultNativeIcon: resolveNotificationIcon(),
    isNativeSupported: () => Notification.isSupported(),
    shouldShowNative: () => !BrowserWindow.getAllWindows().some((win) => win.isFocused()),
    focusApp: () => app.focus({ steal: true }),
    log: (message, detail) => console.warn(`[notifier] ${message}`, detail)
  });
  notifier.attachAgentObserver(observer, store);

  const commandBuilder = new SessionCommandBuilder(
    new ShellDetector(),
    new WindowsCommandBuilder(),
    new WslCommandBuilder()
  );

  let mcpInfo: SoloeMcpServerInfo | null = null;
  const getBridgeInfo = () => mcpInfo;

  const sessionsIpc = new SessionsIpc({
    store,
    commandBuilder,
    observer,
    bridgeInfo: getBridgeInfo,
    getBinaries,
    getWindows: () => BrowserWindow.getAllWindows()
  });

  const autoRename = new AutoRenameService({
    sessionStore: store,
    settings,
    notifier,
    onSessionChange: (session) => sessionsIpc.broadcastChange(session),
    log: (message, detail) => console.warn(`[auto-rename] ${message}`, detail)
  });
  const hookDispatcher = new AgentHookDispatcher({
    observer,
    sessionStore: store,
    autoRename,
    onSessionChange: (session) => sessionsIpc.broadcastChange(session),
    log: (message, detail) => console.warn(`[hook-dispatcher] ${message}`, detail)
  });
  const commentsBridge = new CommentsBridge({
    getWindows: () => BrowserWindow.getAllWindows()
  });
  commentsBridge.start();
  const diffBridge = new DiffBridge({
    getWindows: () => BrowserWindow.getAllWindows()
  });
  diffBridge.start();
  // Built early so the MCP server can call into it for open_diff_for_commits.
  // The GitIpc wrapper is constructed later once windows are available.
  const git = new GitService({
    getGitBinary: async () => (await settings.get()).binaries.git
  });

  const initialBridgeConfig = await bridgePersistence.loadOrCreate();
  const { mcp, info: startedInfo, config: effectiveBridgeConfig } = await startMcp({
    observer,
    runtime,
    onHookEvent: (event) => hookDispatcher.dispatch(event),
    commentsBridge,
    diffBridge,
    git,
    resolveSessionCwd: async (id) => {
      const session = await store.get(id);
      return session ? session.cwd : null;
    },
    initialConfig: initialBridgeConfig
  });
  if (effectiveBridgeConfig.port !== initialBridgeConfig.port) {
    await bridgePersistence.save(effectiveBridgeConfig).catch((err) => {
      console.warn('[bridge] failed to persist bridge config:', err);
    });
  }
  mcpInfo = startedInfo;

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
  const gitIpc = new GitIpc({
    service: git,
    getWindows: () => BrowserWindow.getAllWindows()
  });
  const files = new FileSearchService({ getBinaries });
  const filesIpc = new FilesIpc({
    service: files,
    store,
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
  const hookInstaller = new HookInstaller({
    bridge: effectiveBridgeConfig,
    wslHostnameProbe: probeWslMcpHostname
  });
  await hookInstaller.refresh().catch((err) => {
    console.warn('failed to detect WSL hosts for hook installer:', err);
  });
  // After WSL hosts are known, repair any stale MCP URL in already-installed
  // configs. Off by default for users who explicitly opt out — they have to
  // re-click Install themselves after WSL reboots / port shifts.
  const integrationSettings = (await settings.get()).integrations;
  if (integrationSettings.autoRefreshMcpUrl) {
    void hookInstaller.refreshMcpForInstalledHosts().then((res) => {
      if (res.rewritten.length > 0) {
        console.log(
          '[hooks] refreshed MCP URL for hosts:',
          res.rewritten.map((h) => (h.kind === 'wsl' ? `wsl:${h.distro}` : 'windows')).join(', ')
        );
      }
      for (const e of res.errors) {
        console.warn('[hooks] MCP refresh failed:', e.host, e.error);
      }
    });
  }
  const agentIntegrationIpc = new AgentIntegrationIpc({
    installer: hookInstaller,
    getWindows: () => BrowserWindow.getAllWindows()
  });

  const overviewReader = new SessionTranscriptReader();
  const overviewFacts = new WorktreeFactsCollector({
    gitBinary: (await settings.get()).binaries.git ?? 'git'
  });
  const overviewCache = new SummaryCacheStore(overviewCacheFile);
  await overviewCache.init();
  const overviewService = new WorktreeOverviewService({
    reader: overviewReader,
    facts: overviewFacts,
    cache: overviewCache,
    getSettings: () => settings.get()
  });
  const overviewIpc = new OverviewIpc({
    service: overviewService,
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
  overviewIpc.register();

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
    commentsBridge,
    diffBridge,
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
    agentIntegrationIpc,
    overviewService,
    overviewIpc
  };
}

interface StartMcpDeps {
  observer: AgentObserverManager;
  runtime: AgentRuntimeManager;
  onHookEvent: (event: import('./agents/SoloeMcpServer.js').HookEvent) => void | Promise<void>;
  commentsBridge: CommentsBridge;
  diffBridge: DiffBridge;
  git: GitService;
  resolveSessionCwd: (sessionId: string) => Promise<string | null>;
  initialConfig: BridgeConfig;
}

interface StartMcpResult {
  mcp: SoloeMcpServer;
  info: SoloeMcpServerInfo;
  config: BridgeConfig;
}

// Start the MCP bridge using a persisted port. If the saved port is already
// taken (another instance, or the user manually grabbed it), retry with port=0
// so the OS assigns one and report the new port back so it can be persisted.
async function startMcp(deps: StartMcpDeps): Promise<StartMcpResult> {
  const tryStart = async (port: number): Promise<StartMcpResult> => {
    const mcp = new SoloeMcpServer({
      observer: deps.observer,
      runtime: deps.runtime,
      onHookEvent: deps.onHookEvent,
      commentsBridge: deps.commentsBridge,
      diffBridge: deps.diffBridge,
      git: deps.git,
      resolveSessionCwd: deps.resolveSessionCwd,
      port,
      token: deps.initialConfig.token
    });
    const info = await mcp.start();
    const finalPort = portFromUrl(info.url) ?? port;
    return { mcp, info, config: { port: finalPort, token: deps.initialConfig.token } };
  };
  try {
    return await tryStart(deps.initialConfig.port);
  } catch (err) {
    if (deps.initialConfig.port === 0) throw err;
    console.warn(
      `[bridge] persisted port ${deps.initialConfig.port} unavailable, falling back to OS-assigned`,
      err
    );
    return tryStart(0);
  }
}

function portFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const appIcon = resolveAppIcon();
  const appId = resolveAppId();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    autoHideMenuBar: true,
    frame: false,
    show: false,
    title: 'Soloe',
    icon: appIcon,
    backgroundColor: '#0f0f10',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.platform === 'win32') {
    win.setIcon(appIcon);
    win.setAppDetails({
      appId,
      appIconPath: appIcon,
      appIconIndex: 0,
      relaunchCommand: windowsRelaunchCommand(),
      relaunchDisplayName: app.isPackaged ? 'Soloe' : 'Soloe Dev'
    });
  }

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
      return;
    }
    const isCloseWindowCombo =
      (input.key === 'W' || input.key === 'w') &&
      !input.alt &&
      !input.shift &&
      (process.platform === 'darwin' ? input.meta : input.control);
    if (isCloseWindowCombo) {
      event.preventDefault();
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
    services.overviewIpc.dispose();
    services.git.dispose();
    services.observerStore.dispose();
    await services.observerStore.persist(services.observer);
    await services.pty.dispose();
    await services.runtime.dispose();
    services.commentsBridge.stop();
    services.diffBridge.stop();
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
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const intent = parseDiffArgv(argv);
    if (intent) void applyDiffIntent(intent);
  });
  return true;
}

if (ensureSingleInstance()) {
  pendingDiffIntent = parseDiffArgv(process.argv);
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    ensureWindowsDevShellShortcut(resolveAppIcon());
    services = await setupServices();
    mainWindow = await createWindow();
    if (pendingDiffIntent) {
      const intent = pendingDiffIntent;
      pendingDiffIntent = null;
      // Defer until after the renderer has mounted and registered the diff
      // bridge listener. did-finish-load is the latest reliable signal we
      // get from the main-process side of the bridge boundary.
      mainWindow.webContents.once('did-finish-load', () => {
        void applyDiffIntent(intent);
      });
    }

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

// Minimal argv parser for `--diff` invocations. Accepts either:
//   --diff --commits <csv-of-shas-or-refs>
//   --diff --range <base>..<head>
// optionally with --cwd <path> and --focus <path>. Returns null when --diff
// isn't present, so the normal launch path runs unchanged.
function parseDiffArgv(argv: string[]): DiffIntent | null {
  if (!argv.includes('--diff')) return null;
  const intent: DiffIntent = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--commits' && next) {
      intent.commits = next.split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--range' && next) {
      const dots = next.indexOf('..');
      if (dots > 0) {
        intent.base = next.slice(0, dots).trim();
        intent.head = next.slice(dots + 2).trim();
      }
      i += 1;
    } else if (arg === '--cwd' && next) {
      intent.cwd = next;
      i += 1;
    } else if (arg === '--focus' && next) {
      intent.focusPath = next;
      i += 1;
    }
  }
  if (!intent.commits && !(intent.base && intent.head)) return null;
  return intent;
}

// Route a parsed CLI intent through the same MCP-style handler the renderer
// uses. Falls back to the first open session's cwd when none is provided.
async function applyDiffIntent(intent: DiffIntent): Promise<void> {
  if (!services) return;
  const { diffBridge, git, store } = services;
  let cwd = intent.cwd ?? null;
  if (!cwd) {
    const list = await store.list();
    cwd = list[0]?.cwd ?? null;
  }
  if (!cwd) {
    console.warn('[diff-intent] no cwd available; skipping');
    return;
  }
  try {
    let baseSha: string | null = null;
    let headSha: string | null = null;
    let commitShas: string[] = [];
    if (intent.base && intent.head) {
      const resolved = await git.resolveCommitRefs(cwd, [intent.base, intent.head]);
      baseSha = resolved[0] ?? null;
      headSha = resolved[1] ?? null;
    } else if (intent.commits && intent.commits.length > 0) {
      const headRef = 'HEAD';
      const refs = [headRef, ...intent.commits];
      const resolved = await git.resolveCommitRefs(cwd, refs);
      headSha = resolved[0] ?? null;
      commitShas = resolved.slice(1).filter((s): s is string => !!s);
      const earliest = commitShas[commitShas.length - 1];
      if (earliest) {
        const parent = await git.resolveCommitRefs(cwd, [`${earliest}~1`]);
        baseSha = parent[0] ?? null;
      }
    }
    if (!baseSha || !headSha) {
      console.warn('[diff-intent] could not resolve base/head from argv');
      return;
    }
    const between = await git.getCommitsBetween(cwd, baseSha, headSha);
    if (between.commits.length === 0) {
      console.warn('[diff-intent] resolved range is empty');
      return;
    }
    await diffBridge.openForCommits({
      cwd,
      base: baseSha,
      head: headSha,
      commits: between.commits.map((c) => c.hash),
      includeWorkingTree: true,
      ...(intent.focusPath ? { focusPath: intent.focusPath } : {})
    });
  } catch (err) {
    console.warn('[diff-intent] failed:', err);
  }
}
