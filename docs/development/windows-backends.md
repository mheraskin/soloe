# Windows development with Windows or WSL backends

This is the supported source-development arrangement:

| Component | Windows backend | WSL backend |
| --- | --- | --- |
| Tauri Tray Host | Windows | Windows |
| Electron client | Windows | Windows |
| Browser/PWA client | Windows browser | Windows browser |
| Application Server | Windows | selected WSL distribution |
| Environment Runtime | Windows | selected WSL distribution |
| PTYs and agents | Windows | selected WSL distribution |

There is no Docker dependency. Node.js is required and is not bundled.

## 1. Install the Windows prerequisites

Install:

- Node.js 22 or newer
- Corepack and PNPM
- Git
- Rust with the stable MSVC toolchain
- Visual Studio 2022 Build Tools with **Desktop development with C++**
- WebView2 Runtime (normally already present on Windows 10/11)
- WSL and a distribution such as Ubuntu, if the WSL backend will be used

Open a new PowerShell and verify:

```powershell
node --version
corepack --version
git --version
rustc --version
cargo --version
wsl --status
```

The Node version must be at least 22.

## 2. Prepare the Windows checkout

Use a normal Windows path, not `\\wsl$`:

```powershell
git clone https://github.com/mheraskin/soloe.git C:\src\soloe
Set-Location C:\src\soloe
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install
pnpm --filter @soloe/web build
```

Verify the Windows toolchain:

```powershell
pnpm typecheck
pnpm --filter @soloe/desktop-electron build
pnpm --filter @soloe/tray exec tauri build --no-bundle
```

## 3. Prepare the WSL checkout

Skip this section if only the Windows backend is needed.

Open the selected distribution:

```powershell
wsl --distribution Ubuntu
```

Inside WSL, install Node.js 22 or newer, Corepack/PNPM, and Git. Rust and Visual
Studio are not needed inside WSL because the tray remains a Windows program.

Verify that a non-interactive login shell can find the tools:

```bash
bash -lc 'node --version && pnpm --version && git --version'
```

This exact check matters because the Windows tray starts WSL services through
`bash -lc`. If it fails, add the Node/PNPM initialization to the WSL login
profile and repeat the check.

Create a separate WSL-native checkout and install its Linux dependencies:

```bash
mkdir -p ~/src
git clone https://github.com/mheraskin/soloe.git ~/src/soloe
cd ~/src/soloe
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install
pnpm --filter @soloe/web build
```

Do not share `node_modules` between Windows and WSL. `node-pty` is
platform-specific, which is why the two checkouts need separate installs.

## 4. Select the WSL backend before first launch

From the Windows checkout in PowerShell:

```powershell
Set-Location C:\src\soloe
pnpm configure:backend -- --placement wsl --distro Ubuntu --root /home/YOUR_WSL_USER/src/soloe
```

Use the exact Linux path printed by this WSL command if unsure:

```powershell
wsl --distribution Ubuntu -- bash -lc 'printf "%s\n" "$HOME/src/soloe"'
```

The configuration command writes the shared launcher setting to
`%LOCALAPPDATA%\Soloe\settings.json`.

## 5. Start Soloe with the WSL backend

Still in the Windows checkout:

```powershell
pnpm dev:tray
```

The tray starts on Windows and automatically launches, in order:

1. the Environment Runtime inside the selected WSL distribution;
2. the Application Server inside the same distribution.

Right-click the Soloe tray icon. Its status should say
`Backend: running on WSL`.

Then choose either:

- **Open Electron client** — starts Electron on Windows, connected to the WSL
  Application Server;
- **Open in browser** — opens the authenticated PWA in the Windows browser.

The WSL Unix socket is never exposed to Windows. Only the token-protected
localhost server on port 4317 crosses the Windows/WSL boundary.

## 6. Change placement from Settings

Open **Settings → Backend** in either client.

Choose:

- **Windows**, or
- **WSL**, then enter the distribution and absolute WSL repository path.

The change is intentionally restart-applied:

1. right-click the tray;
2. choose **Stop backend**;
3. choose **Start backend**.

Stop uses the recorded active placement, not the newly selected placement. This
prevents a settings change from leaving the old agent-owning runtime behind.

## 7. Run with the Windows backend

The Windows checkout already contains the required Windows dependencies. Select
Windows from Settings and use Stop then Start, or configure it before launch:

```powershell
Set-Location C:\src\soloe
pnpm configure:backend -- --placement windows
pnpm dev:tray
```

The tray, server, runtime, PTYs, Electron, and browser transport now all run
natively on Windows. Electron and the browser still connect to the Application
Server rather than owning PTYs.

## 8. Confirm agent continuity

Start a terminal, Codex, or Claude session, then:

1. close Electron;
2. rebuild a client with `pnpm --filter @soloe/desktop-electron build` or
   `pnpm --filter @soloe/web build`;
3. reopen Electron or the browser from the tray.

The agent continues because its PTY belongs to the Environment Runtime.
Rebuilding a client does not touch that process. Rebuilding or restarting the
Application Server also does not stop the runtime.

Only these actions stop running agents:

- explicitly stopping their terminal/session;
- choosing **Stop backend**;
- choosing **Quit Soloe**, which performs a backend stop before exiting.

## 9. Logs and troubleshooting

Windows-side shared state and logs:

```text
%LOCALAPPDATA%\Soloe\settings.json
%LOCALAPPDATA%\Soloe\active-backend.json
%LOCALAPPDATA%\Soloe\runtime.log
%LOCALAPPDATA%\Soloe\server.log
```

If WSL startup times out:

```powershell
wsl --distribution Ubuntu -- bash -lc 'node --version && pnpm --version'
wsl --distribution Ubuntu -- bash -lc 'test -f /home/YOUR_WSL_USER/src/soloe/package.json && echo ok'
Get-Content "$env:LOCALAPPDATA\Soloe\runtime.log" -Tail 100
Get-Content "$env:LOCALAPPDATA\Soloe\server.log" -Tail 100
```

If the tray says the backend is running but a Windows client cannot connect,
verify that `http://127.0.0.1:4317` is reachable from Windows and that WSL
localhost forwarding has not been disabled.
