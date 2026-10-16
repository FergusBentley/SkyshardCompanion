const { contextBridge, ipcRenderer } = require('electron/renderer')

contextBridge.exposeInMainWorld('skyshard', {
  getState: () => ipcRenderer.invoke('get-state'),
  chooseLog: () => ipcRenderer.invoke('choose-log'),
  resetLog: () => ipcRenderer.invoke('reset-log'),
  setReadShops: on => ipcRenderer.invoke('set-read-shops', on),
  onVision: callback => ipcRenderer.on('vision', (_event, state) => callback(state)),
  labelShop: label => ipcRenderer.send('shop-label', label),
  setSaveCaptures: on => ipcRenderer.invoke('set-save-captures', on),
  openCaptures: () => ipcRenderer.invoke('open-captures'),
  onShop: callback => ipcRenderer.on('shop', (_event, event) => callback(event)),
  onIsland: callback => ipcRenderer.on('island', (_event, seen) => callback(seen)),
  onUnitCard: callback => ipcRenderer.on('unit-card', (_event, spot) => callback(spot)),
  lookFor: look => ipcRenderer.send('island-look-for', look),
  newRun: () => ipcRenderer.send('island-new-run'),
  labelIsland: label => ipcRenderer.send('island-label', label),
  probeTile: tile => ipcRenderer.invoke('island-probe', tile),
  onRound: callback => ipcRenderer.on('screen-round', (_event, n) => callback(n)),
  onLog: callback => ipcRenderer.on('log', (_event, state) => callback(state)),
  onData: callback => ipcRenderer.on('data', (_event, data) => callback(data))
})
