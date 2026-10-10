import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Api } from './api.ts';

const api: Api = {
  pickFile: () => ipcRenderer.invoke('pick-file'),
  initialFile: () => ipcRenderer.invoke('initial-file'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  measure: (path) => ipcRenderer.invoke('measure', path),
  mediaUrl: (path) => ipcRenderer.invoke('media-url', path),
  pickOutput: (suggested) => ipcRenderer.invoke('pick-output', suggested),
  render: (request) => ipcRenderer.invoke('render', request),
  reveal: (path) => ipcRenderer.send('reveal', path),
  onProgress: (listener) => ipcRenderer.on('progress', (_event, fraction: number) => listener(fraction)),
  painted: () => ipcRenderer.send('painted'),
};

contextBridge.exposeInMainWorld('api', api);
