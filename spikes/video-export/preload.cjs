const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('spike', {
  config: () => ipcRenderer.invoke('config'),
  log: (text) => ipcRenderer.send('log', text),
  chunk: (data) => ipcRenderer.invoke('chunk', data),
  done: (summary) => ipcRenderer.invoke('done', summary),
});
