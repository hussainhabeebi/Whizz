// Exposes a tiny, explicit bridge into the renderer (index.html, running completely
// unmodified otherwise) — contextIsolation stays on and nodeIntegration stays off in
// main.js, so this is the only thing the page can reach into Node/Electron through.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whizzDesktop', {
  // Lets index.html's existing addNotif() (the single place every in-app notification is
  // already created) also surface a native OS toast when running inside this app, with no
  // duplicated "what counts as new" logic on either side.
  notify: (title, body) => ipcRenderer.send('whizz-notify', { title, body }),
  getStatus: () => ipcRenderer.invoke('whizz-get-status'),
});
