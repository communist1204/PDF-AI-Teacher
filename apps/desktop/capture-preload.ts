import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('screenCrop', Object.freeze({
  onFrame: (callback: (value: { frameId: number; imageDataUrl: string } | null) => void) => {
    ipcRenderer.on('screen-crop:frame', (_event, value) => callback(value));
  },
  ready: (frameId: number) => ipcRenderer.invoke('screen-crop:ready', frameId),
  select: (frameId: number, rect: unknown) => ipcRenderer.invoke('screen-crop:select', frameId, rect),
  cancel: (frameId: number) => ipcRenderer.invoke('screen-crop:cancel', frameId),
}));
