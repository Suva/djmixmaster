import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Api, MenuCommand } from './api.ts';

const api: Api = {
  pickFile: () => ipcRenderer.invoke('pick-file'),
  initialFile: () => ipcRenderer.invoke('initial-file'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  measure: (path) => ipcRenderer.invoke('measure', path),
  recall: (path) => ipcRenderer.invoke('recall', path),
  remember: (path, remembered) => ipcRenderer.send('remember', path, remembered),
  mediaUrl: (path) => ipcRenderer.invoke('media-url', path),
  pickOutput: (suggested) => ipcRenderer.invoke('pick-output', suggested),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  existing: (paths) => ipcRenderer.invoke('existing', paths),
  confirm: (message, detail, action) => ipcRenderer.invoke('confirm', message, detail, action),
  render: (request) => ipcRenderer.invoke('render', request),
  reveal: (path) => ipcRenderer.send('reveal', path),
  onProgress: (listener) => ipcRenderer.on('progress', (_event, fraction: number) => listener(fraction)),
  onMenu: (listener) => ipcRenderer.on('menu', (_event, command: MenuCommand) => listener(command)),
  onOpenFile: (listener) => ipcRenderer.on('open-file', (_event, path: string) => listener(path)),
  painted: () => ipcRenderer.send('painted'),
};

contextBridge.exposeInMainWorld('api', api);
