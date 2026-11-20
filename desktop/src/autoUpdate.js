// electron-updater reads the "publish" config baked into package.json at build time (the
// GitHub repo releases produced by .github/workflows/build-desktop.yml's --publish step), so
// no URL/token wiring is needed here. checkForUpdatesAndNotify() downloads silently in the
// background and shows a native OS notification once ready; clicking it calls
// quitAndInstall() for us. A dev run (electron .) isn't packaged and has no update feed, so
// skip entirely rather than let it throw.
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;

function startAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const check = () => autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  check();
  setInterval(check, CHECK_INTERVAL_MS);
}

module.exports = { startAutoUpdate };
