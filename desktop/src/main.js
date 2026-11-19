const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startLocalServer } = require('./localServer');
const { startSyncLoop } = require('./syncLoop');
const authStore = require('./authStore');
const config = require('./config');

let mainWindow;
let stopSync;

async function createWindow() {
  const { port } = await startLocalServer({ getToken: authStore.getToken, getBaseUrl: config.getBaseUrl });

  stopSync = startSyncLoop({ getToken: authStore.getToken, getBaseUrl: config.getBaseUrl });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: 'Whizz',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  const hasToken = !!authStore.getToken();
  mainWindow.loadURL(`http://127.0.0.1:${port}/${hasToken ? 'index.html' : 'pairing.html'}`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (stopSync) stopSync();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
