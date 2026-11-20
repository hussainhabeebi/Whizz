const { app, BrowserWindow, Menu, Notification, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { startLocalServer } = require('./localServer');
const { startSyncLoop } = require('./syncLoop');
const { createTray } = require('./tray');
const authStore = require('./authStore');
const config = require('./config');
const { startAutoUpdate } = require('./autoUpdate');

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');

let mainWindow;
let stopSync;
let lastStatus = { online: true, outboxCount: 0 };

// Only the tray's own "Quit Whizz" sets this — an ordinary window close (the X button)
// minimizes to the tray instead, same as most native Windows apps with a tray presence.
app.isQuitting = false;

async function createWindow() {
  const { port } = await startLocalServer({ getToken: authStore.getToken, getBaseUrl: config.getBaseUrl });

  stopSync = startSyncLoop({
    getToken: authStore.getToken,
    getBaseUrl: config.getBaseUrl,
    onStatusChange: (status) => { lastStatus = status; },
  });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: 'Whizz',
    icon: nativeImage.createFromPath(ICON_PATH),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit', label: 'Quit Whizz', click: () => { app.isQuitting = true; app.quit(); } }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));

  createTray(mainWindow);

  mainWindow.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  const hasToken = !!authStore.getToken();
  mainWindow.loadURL(`http://127.0.0.1:${port}/${hasToken ? 'index.html' : 'pairing.html'}`);

  startAutoUpdate();
}

ipcMain.on('whizz-notify', (event, { title, body }) => {
  if (!Notification.isSupported()) return;
  new Notification({ title: title || 'Whizz', body: body || '', icon: nativeImage.createFromPath(ICON_PATH) }).show();
});
ipcMain.handle('whizz-get-status', () => lastStatus);

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Only actually happens post-quit (the 'close' handler above hides instead of closing in
  // the normal case) — nothing left to clean up differently here, but stop the sync loop's
  // timer so it isn't left running past app exit.
  if (stopSync) stopSync();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow.show();
});
