import { contextBridge, ipcRenderer } from 'electron';
import type { ReaderBridge } from '../../packages/shared/reader';

const bridge: ReaderBridge = {
  getSettings: () => ipcRenderer.invoke('reader:settings'),
  saveSettings: value => ipcRenderer.invoke('reader:save-settings', value),
  capture: () => ipcRenderer.invoke('reader:capture'),
  recognize: id => ipcRenderer.invoke('reader:recognize', id),
  beginSpeech: id => ipcRenderer.invoke('reader:begin-speech', id),
  speak: request => ipcRenderer.invoke('reader:speak', request),
  cancel: () => ipcRenderer.invoke('reader:cancel'),
  setPanel: panel => ipcRenderer.invoke('reader:panel', panel),
  minimize: () => ipcRenderer.invoke('reader:minimize'),
  quit: () => ipcRenderer.invoke('reader:quit'),
  openHelp: () => ipcRenderer.invoke('reader:help'),
  onCaptureRequested: callback => {
    const listener = () => callback(); ipcRenderer.on('reader:capture-requested', listener);
    return () => ipcRenderer.removeListener('reader:capture-requested', listener);
  },
};
contextBridge.exposeInMainWorld('reader', Object.freeze(bridge));
