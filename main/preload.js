const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  winMinimize: () => ipcRenderer.invoke('win-minimize'),
  winClose: () => ipcRenderer.invoke('win-close'),
  togglePin: () => ipcRenderer.invoke('toggle-pin'),
  getPin: () => ipcRenderer.invoke('get-pin'),
  resize: (w, h) => ipcRenderer.sendSync('win-resize', w, h),
  getLocalData: () => ipcRenderer.invoke('get-local-data'),
  saveLocalData: (data) => ipcRenderer.invoke('save-local-data', data),
  onBlur: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('win-blur', handler)
    return () => ipcRenderer.removeListener('win-blur', handler)
  },
  onFocus: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('win-focus', handler)
    return () => ipcRenderer.removeListener('win-focus', handler)
  },
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  toggleAutoLaunch: () => ipcRenderer.invoke('toggle-auto-launch'),
  onHandleDblClick: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('handle-dblclick', handler)
    return () => ipcRenderer.removeListener('handle-dblclick', handler)
  },
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateStatus: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('update-status', handler)
    return () => ipcRenderer.removeListener('update-status', handler)
  }
})
