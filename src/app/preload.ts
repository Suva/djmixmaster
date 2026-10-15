import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Api, MenuCommand } from './api.ts';

const api: Api = {
  pickFiles: () => ipcRenderer.invoke('pick-file'),
  recordingOf: (files) => ipcRenderer.invoke('recording-of', files),
  initialFile: () => ipcRenderer.invoke('initial-file'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  measure: (path) => ipcRenderer.invoke('measure', path),
  recall: (path) => ipcRenderer.invoke('recall', path),
  remember: (path, remembered) => ipcRenderer.send('remember', path, remembered),
  mediaUrl: (path) => ipcRenderer.invoke('media-url', path),
  fineWave: (path, start, end, sampleRate, perSecond) => ipcRenderer.invoke('fine-wave', path, start, end, sampleRate, perSecond),
  pickOutput: (suggested) => ipcRenderer.invoke('pick-output', suggested),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  existing: (paths) => ipcRenderer.invoke('existing', paths),
  confirm: (message, detail, action) => ipcRenderer.invoke('confirm', message, detail, action),
  render: (request) => ipcRenderer.invoke('render', request),
  cancel: () => ipcRenderer.send('cancel'),
  reveal: (path) => ipcRenderer.send('reveal', path),
  onProgress: (listener) => ipcRenderer.on('progress', (_event, fraction: number) => listener(fraction)),
  onUpdateAvailable: (listener) => ipcRenderer.on('update-available', (_event, version: string) => listener(version)),
  openDownloadPage: () => ipcRenderer.send('open-download-page'),
  skipVersion: (version) => ipcRenderer.send('skip-version', version),
  onMenu: (listener) => ipcRenderer.on('menu', (_event, command: MenuCommand) => listener(command)),
  onOpenFiles: (listener) => ipcRenderer.on('open-files', (_event, paths: string[]) => listener(paths)),
  painted: (path: string) => ipcRenderer.send('painted', path),
  closed: () => ipcRenderer.send('closed'),
  features: (path) => ipcRenderer.invoke('features', path),
  onListening: (listener) => ipcRenderer.on('listening', (_event, path: string, fraction: number) => listener(path, fraction)),
  recent: () => ipcRenderer.invoke('recent'),
  onRecentChanged: (listener) => ipcRenderer.on('recent-changed', () => listener()),
};

contextBridge.exposeInMainWorld('api', api);
