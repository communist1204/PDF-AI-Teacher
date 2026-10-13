import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('screenCrop', Object.freeze({
  image: () => ipcRenderer.invoke('screen-crop:image'),
  select: (rect: unknown) => ipcRenderer.invoke('screen-crop:select', rect),
  cancel: () => ipcRenderer.invoke('screen-crop:cancel'),
}));
