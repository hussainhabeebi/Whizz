const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

function createTray(mainWindow) {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon-tray.png'));
  const tray = new Tray(icon);
  tray.setToolTip('Whizz');

  function buildMenu() {
    const openAtLogin = app.getLoginItemSettings().openAtLogin;
    return Menu.buildFromTemplate([
      { label: 'Show Whizz', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { type: 'separator' },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      { label: 'Quit Whizz', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
  }

  tray.setContextMenu(buildMenu());
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
  return tray;
}

module.exports = { createTray };
