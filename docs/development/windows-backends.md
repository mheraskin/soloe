# Windows development with Windows or WSL backends

Soloe has one Windows client side and a selectable backend side:

| Component | Always runs on |
| --- | --- |
| Tauri tray/supervisor | Windows |
| Web/PWA host and hot reload | Windows |
| Electron client | Windows |
| Application Server | Selected Windows or WSL backend |
| Environment Runtime, PTYs, and agents | Selected Windows or WSL backend |

There is no Docker dependency. Node.js 22 or newer is required and is not
bundled.

## One-time Windows setup

Install:

- Node.js 22 or newer;
- Corepack and the pinned PNPM version;
- Git;
- Rust stable with the MSVC toolchain;
- Visual Studio 2022 Build Tools with **Desktop development with C++**;
- WebView2 Runtime (normally present on Windows 10/11);
- WSL and the desired distribution when using a WSL backend.

Open Developer PowerShell for Visual Studio and verify:

```powershell
node --version
corepack --version
git --version
rustc --version
cargo --version
wsl --list --verbose
```

If `rustc` or `cargo` is not found after installing Rust, open a new Developer
PowerShell or add Rustup to the current shell:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```

Prepare the Windows checkout:

```powershell
Set-Location D:\projects\soloe-win-2
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install
```

The Windows checkout owns the tray, Electron dependencies, and browser/PWA
dependencies. Do not install them from WSL into this checkout.

## One-time WSL setup

Skip this section for a Windows backend.

The current Ubuntu development checkout is:

```text
/home/user/projects/soloe-2
```

Inside Ubuntu, install Node.js 22 or newer, Corepack/PNPM, and Git. Rust and
Visual Studio are not needed inside WSL because the tray remains on Windows.

Verify the exact non-interactive login environment used by the tray:

```powershell
wsl --distribution Ubuntu -- bash -lc 'node --version && pnpm --version && git --version'
```

Install the Linux-native dependencies once:

```powershell
wsl --distribution Ubuntu -- bash -lc 'cd /home/user/projects/soloe-2 && pnpm install'
```

Windows and WSL must not share `node_modules`; `node-pty` is
platform-specific.

## Select the backend

For Ubuntu WSL:

```powershell
Set-Location D:\projects\soloe-win-2
pnpm configure:backend -- --placement wsl --distro Ubuntu --root /home/user/projects/soloe-2
```

For native Windows:

```powershell
Set-Location D:\projects\soloe-win-2
pnpm configure:backend -- --placement windows
```

The setting is stored at `%LOCALAPPDATA%\Soloe\settings.json`. A placement
change applies after choosing **Stop**, then using the same action when it
changes to **Start**.

## Everyday startup

From the Windows checkout:

```powershell
Set-Location D:\projects\soloe-win-2
pnpm dev
```

That is the normal startup command. It:

1. starts the lightweight Windows tray;
2. validates Windows Node/PNPM and client dependencies;
3. validates the selected Windows or WSL backend and `node-pty`;
4. starts the Environment Runtime;
5. starts the Application Server;
6. starts the Windows Web Host with hot reload;
7. enables **Open in browser** only after the authenticated PWA is ready.

No routine web build is required in either checkout. The Windows Web Host
proxies authenticated `/api` HTTP/WebSocket traffic to the selected backend.

Right-click the Soloe tray icon and choose:

- the single **Start** or **Stop** action;
- **Open in browser** for the Windows PWA;
- **Open Electron client** for the disposable Windows desktop client;
- **Open Soloe logs** for diagnostics.

## Client-only development

Closing or rebuilding Electron or the browser does not affect runtime-owned
agents. The tray-managed web host provides hot reload automatically.

Electron can be built separately:

```powershell
pnpm --filter @soloe/desktop-electron build
```

The Application Server can be restarted independently while the Environment
Runtime remains running. Reconnected clients request terminal replay from the
last observed output sequence.

## Stop versus Quit Soloe

The tray has one dynamic lifecycle action, not separate start, stop, and status
rows. **Stop** keeps the tray running but stops:

1. the Windows Web Host;
2. the Application Server;
3. the Environment Runtime;
4. all runtime-owned PTYs and agents.

After shutdown, that same item becomes **Start** and starts the placement
currently selected in Settings. While transitioning it remains disabled and
displays **Starting…** or **Stopping…**.

**Quit Soloe** is a complete shutdown. It stops tray-launched Electron
processes, the Web Host, the Application Server, and the Environment Runtime
before exiting. When the runtime may own active agents, the tray asks for a
second confirmation.

The tray is the definitive owner. A killed/crashed Windows tray closes its Job
Object, terminating native process trees. For WSL, a heartbeat lease expires
and the WSL supervisor stops server then runtime within a bounded interval.
Soloe currently has no tray ownership-handoff mode.

## Validation

Run from Developer PowerShell:

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @soloe/web build
pnpm --filter @soloe/desktop-electron build
cargo fmt --check
cargo test --workspace
pnpm --filter @soloe/tray exec tauri build --no-bundle
git diff --check
```

Smoke-test both placements:

1. run `pnpm dev`;
2. confirm the single tray action changes between **Start** and **Stop**;
3. open the browser and confirm initial loading has no unsupported startup RPC;
4. create a project/session and start a terminal;
5. close and reopen browser and Electron; confirm output replay;
6. rebuild either client; confirm the terminal remains;
7. restart only the Application Server; confirm the terminal remains;
8. choose **Stop**; confirm the terminal stops;
9. restart, then choose **Quit Soloe**; confirm every managed process stops;
10. restart, kill the tray process, and confirm no managed Windows/WSL process
    remains after the ownership timeout.

## Logs and troubleshooting

The tray menu opens this directory:

```text
%LOCALAPPDATA%\Soloe
```

Important files:

```text
settings.json
active-backend.json
tray-lease.json
runtime.log
server.log
web.log
supervisor.log
```

Useful checks:

```powershell
Test-NetConnection 127.0.0.1 -Port 4317
Test-NetConnection 127.0.0.1 -Port 4318
Get-Content "$env:LOCALAPPDATA\Soloe\runtime.log" -Tail 100
Get-Content "$env:LOCALAPPDATA\Soloe\server.log" -Tail 100
Get-Content "$env:LOCALAPPDATA\Soloe\web.log" -Tail 100
Get-Content "$env:LOCALAPPDATA\Soloe\supervisor.log" -Tail 100
wsl --distribution Ubuntu -- bash -lc 'node --version && pnpm --version'
```

Tray failures include actionable diagnostics for missing Windows or WSL
Node/PNPM, invalid WSL source paths, missing platform dependencies, failed
runtime/server/web startup, graceful shutdown fallback, and incomplete cleanup.
A port 4317 or 4318 conflict is recorded in `server.log` or `web.log`.

The Windows checkout in this development setup is a WSL-created linked
worktree. Use PowerShell for PNPM, Cargo, Electron, and Tauri commands. Perform
Git operations through WSL:

```powershell
wsl --distribution Ubuntu -- git -C /mnt/d/projects/soloe-win-2 status
```
