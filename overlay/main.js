// Transparent, always-on-top, click-through lyrics overlay for the Spotify Lyrics Overlay extension.
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const PORT = 47823;
const WIDTHS = { Small: 600, Medium: 900, Large: 1200 };
const HOVER_PAD = 8;

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let tray = null;
let hovered = false;
let hitRect = null; // panel rect inside the window, reported by the renderer
const clients = new Set();

const config = { width: WIDTHS.Medium, fontSize: 34, x: undefined, y: undefined };
const configPath = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { Object.assign(config, JSON.parse(fs.readFileSync(configPath(), 'utf8'))); } catch {}
}
function saveConfig() {
  try { fs.writeFileSync(configPath(), JSON.stringify(config)); } catch {}
}

const heightFor = (fontSize) => Math.round(fontSize * 3.8 + 80);

function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = config.width;
  const height = heightFor(config.fontSize);
  return { x: Math.round(wa.x + (wa.width - width) / 2), y: wa.y + wa.height - height - 30, width, height };
}

function initialBounds() {
  const b = defaultBounds();
  if (config.x == null || config.y == null) return b;
  const saved = { ...b, x: config.x, y: config.y };
  const onScreen = screen.getAllDisplays().some(({ workArea: w }) =>
    saved.x + 40 > w.x && saved.x + 40 < w.x + w.width && saved.y + 20 > w.y && saved.y + 20 < w.y + w.height);
  return onScreen ? saved : b;
}

function setBounds(bounds) {
  // Some platforms ignore programmatic resizes on non-resizable windows.
  win.setResizable(true);
  win.setBounds(bounds);
  win.setResizable(false);
}

function applySize() {
  // Keep the bottom-centre anchored so the lyrics stay where you put them.
  const b = win.getBounds();
  const width = config.width;
  const height = heightFor(config.fontSize);
  setBounds({ x: Math.round(b.x + (b.width - width) / 2), y: b.y + b.height - height, width, height });
}

function createWindow() {
  win = new BrowserWindow({
    ...initialBounds(),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  win.setIgnoreMouseEvents(true);
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.showInactive());
  win.on('moved', () => {
    const b = win.getBounds();
    config.x = b.x;
    config.y = b.y;
    saveConfig();
  });
  win.webContents.on('did-finish-load', notifyStatus);
}

// Click-through everywhere except while the cursor is over the lyrics panel.
function pollHover() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const r = hitRect || { x: 0, y: 0, width: b.width, height: b.height };
  const inside =
    p.x >= b.x + r.x - HOVER_PAD && p.x <= b.x + r.x + r.width + HOVER_PAD &&
    p.y >= b.y + r.y - HOVER_PAD && p.y <= b.y + r.y + r.height + HOVER_PAD;
  if (inside === hovered) return;
  hovered = inside;
  win.setIgnoreMouseEvents(!inside);
  win.webContents.send('hover', inside);
}

function startServer() {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: PORT,
    // Only browser extensions may connect (blocks random web pages talking to localhost).
    verifyClient: ({ origin }) => !origin || origin.startsWith('chrome-extension://'),
  });
  wss.on('connection', (sock) => {
    clients.add(sock);
    notifyStatus();
    sock.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (win && !win.isDestroyed()) win.webContents.send('sfl', msg);
    });
    sock.on('close', () => {
      clients.delete(sock);
      notifyStatus();
    });
  });
  wss.on('error', (err) => {
    dialog.showErrorBox('Lyrics Overlay', `Could not open port ${PORT}: ${err.message}`);
    app.quit();
  });
}

function notifyStatus() {
  if (win && !win.isDestroyed()) win.webContents.send('status', { connected: clients.size > 0 });
}

ipcMain.on('command', (_e, cmd) => {
  const data = JSON.stringify({ ...cmd, type: 'command' });
  for (const c of clients) c.send(data);
});
ipcMain.on('hit-rect', (_e, rect) => {
  hitRect = rect;
});
ipcMain.on('font', (_e, size) => {
  config.fontSize = size;
  saveConfig();
  applySize();
});
ipcMain.handle('config', () => ({ fontSize: config.fontSize }));

const loginOptions = () => (app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(app.getAppPath())] });

function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Show lyrics',
      type: 'checkbox',
      checked: win.isVisible(),
      click: (item) => {
        if (item.checked) win.showInactive();
        else win.hide();
      },
    },
    {
      label: 'Width',
      submenu: Object.entries(WIDTHS).map(([label, width]) => ({
        label,
        type: 'radio',
        checked: config.width === width,
        click: () => {
          config.width = width;
          saveConfig();
          applySize();
        },
      })),
    },
    {
      label: 'Reset position',
      click: () => {
        config.x = config.y = undefined;
        saveConfig();
        setBounds(defaultBounds());
      },
    },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings(loginOptions()).openAtLogin,
      click: (item) => app.setLoginItemSettings({ ...loginOptions(), openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Spotify Lyrics Overlay');
  tray.on('click', () => {
    if (win.isVisible()) win.hide();
    else win.showInactive();
    buildTrayMenu();
  });
  buildTrayMenu();
}

app.whenReady().then(() => {
  loadConfig();
  createWindow();
  createTray();
  startServer();
  setInterval(pollHover, 80);
});

app.on('window-all-closed', () => app.quit());
