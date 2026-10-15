const { contextBridge, ipcRenderer } = require('electron/renderer')

contextBridge.exposeInMainWorld('capture', {
  onStart: callback => ipcRenderer.on('capture-start', (_event, emptyShop) => callback(emptyShop)),
  onStop: callback => ipcRenderer.on('capture-stop', () => callback()),
  onRecheck: callback => ipcRenderer.on('island-recheck', () => callback()),
  started: () => ipcRenderer.send('capture-started'),
  ended: reason => ipcRenderer.send('capture-ended', reason || ''),
  shopOpened: frame => ipcRenderer.send('shop-opened', frame),
  shopClosed: info => ipcRenderer.send('shop-closed', info),
  islandSeen: frame => ipcRenderer.send('island-seen', frame),
  unitCard: card => ipcRenderer.send('unit-card', card),
  round: n => ipcRenderer.send('screen-round', n),
  debug: info => ipcRenderer.send('capture-debug', info)
})
