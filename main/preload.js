const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  winMinimize: () => ipcRenderer.invoke('win-minimize'),
  winClose: () => ipcRenderer.invoke('win-close'),
  togglePin: () => ipcRenderer.invoke('toggle-pin'),
  getPin: () => ipcRenderer.invoke('get-pin'),
  resize: (w, h) => ipcRenderer.sendSync('win-resize', w, h),
  getLocalData: () => ipcRenderer.invoke('get-local-data'),
  saveLocalData: (data) => ipcRenderer.invoke('save-local-data', data)
})
