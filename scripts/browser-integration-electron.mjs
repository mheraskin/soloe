import { app, BrowserWindow } from 'electron';

const targetUrl = process.env.SOLOE_BROWSER_INTEGRATION_URL;
if (!targetUrl) throw new Error('SOLOE_BROWSER_INTEGRATION_URL is required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.setUserAgent(
    window.webContents.getUserAgent().replace(/\sElectron\/\S+/u, '')
  );
  await window.loadURL(targetUrl).catch((error) => {
    process.stderr.write(`Browser integration navigation failed: ${error.stack ?? error}\n`);
    throw error;
  });
  process.stdout.write(`${JSON.stringify({
    ready: true,
    url: window.webContents.getURL()
  })}\n`);
}).catch((error) => {
  process.stderr.write(`Browser integration Electron failed: ${error.stack ?? error}\n`);
  app.exit(1);
});

process.once('SIGTERM', () => app.quit());
process.once('SIGINT', () => app.quit());
app.on('window-all-closed', () => app.quit());
