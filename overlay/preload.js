const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['sfl', 'status', 'hover'];

contextBridge.exposeInMainWorld('overlay', {
  on: (channel, fn) => {
    if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
  command: (cmd) => ipcRenderer.send('command', cmd),
  setFont: (size) => ipcRenderer.send('font', size),
  setHitRect: (rect) => ipcRenderer.send('hit-rect', rect),
  getConfig: () => ipcRenderer.invoke('config'),
});
