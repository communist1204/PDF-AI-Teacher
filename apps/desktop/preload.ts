import { contextBridge,ipcRenderer } from 'electron';
import type { DesktopTeacherBridge } from '../../packages/shared/desktop';
const bridge:DesktopTeacherBridge={
 screenReading:Object.freeze({capture:()=>ipcRenderer.invoke('desktop:screen-capture'),recognize:(id:string)=>ipcRenderer.invoke('desktop:screen-recognize',id),cancel:()=>ipcRenderer.invoke('desktop:screen-cancel')}),
 getSettings:()=>ipcRenderer.invoke('desktop:settings'),
 saveSettings:input=>ipcRenderer.invoke('desktop:save',input),
 login:accountId=>ipcRenderer.invoke('desktop:login',accountId),
 selectAccount:accountId=>ipcRenderer.invoke('desktop:select-account',accountId),
 cancelLogin:()=>ipcRenderer.invoke('desktop:cancel-login'),
 logout:()=>ipcRenderer.invoke('desktop:logout'),
 restart:()=>ipcRenderer.invoke('desktop:restart'),
 openAccountPage:page=>ipcRenderer.invoke('desktop:account-page',page),
 createShortcut:()=>ipcRenderer.invoke('desktop:shortcut'),
};
contextBridge.exposeInMainWorld('desktopTeacher',Object.freeze(bridge));
