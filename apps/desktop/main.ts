/* eslint-disable preserve-caught-error -- IPC errors intentionally omit original causes that may contain credentials. */
import {app,BrowserWindow,ipcMain,safeStorage,shell,dialog,Menu,session,type IpcMainInvokeEvent} from 'electron';
import {createServer,type Server} from 'node:http';
import {join,resolve} from 'node:path';
import {access} from 'node:fs/promises';
import {mkdirSync} from 'node:fs';
import express from 'express';
import {createApp} from '../server/src/app';
import {SettingsVault,SaveSettingsSchema,serverConfigFor} from './settings';
import {ChatGptAuthManager,type AuthStore} from './auth';
import {createDesktopFetch} from './network';
import {QwenTtsProvider,qwenCudaRuntimeReady} from '../server/src/qwenTts';
import {LocalTtsProvider} from '../server/src/localTts';
import type {DesktopSettings} from '../../packages/shared/desktop';

app.setName('PDF AI Teacher');
app.setAppUserModelId('local.pdf-ai-teacher.desktop');
function configureUserData(){
 try{
  const directory=process.env.PDF_TEACHER_DATA_DIR?resolve(process.env.PDF_TEACHER_DATA_DIR):join(app.getPath('appData'),'PDF-AI-Teacher');
  mkdirSync(directory,{recursive:true});app.setPath('userData',directory);return true;
 }catch{
  const message='无法创建本软件的数据目录。请检查当前 Windows 账号的应用数据目录是否可写。';
  if(process.env.PDF_TEACHER_TEST_MODE==='1')console.error(message);else dialog.showErrorBox('PDF AI Teacher 无法启动',message);
  return false;
 }
}
let mainWindow:BrowserWindow|null=null;
let server:Server|undefined;
let localApp:ReturnType<typeof createApp>|undefined;
let localTts:LocalTtsProvider|undefined;
let qwenTts:QwenTtsProvider|undefined;
let auth:ChatGptAuthManager;
let vault:SettingsVault;
let origin='';
let restarting=false;
let shuttingDown=false;
let restartRequired=false;
let models:Array<{id:string;name:string}>=[];
const accountUrls={
 'api-keys':'https://platform.openai.com/api-keys',
 billing:'https://platform.openai.com/settings/organization/billing/overview',
 chatgpt:'https://chatgpt.com/',
 'doubao-guide':'https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh',
 'doubao-console':'https://console.volcengine.com/speech/new/setting/apikeys',
};
function assertSender(event:IpcMainInvokeEvent){
 if(!mainWindow||event.sender!==mainWindow.webContents||event.senderFrame!==mainWindow.webContents.mainFrame||event.senderFrame.url!==origin+'/')throw Error('拒绝非本软件设置页面的操作。');
}
async function openAuthorization(url:string){
 const parsed=new URL(url);if(parsed.origin!=='https://auth.openai.com'||parsed.pathname!=='/api/accounts/authorize')throw Error('拒绝非官方登录地址。');
 try{await shell.openExternal(url);}catch{throw Error('无法打开系统默认浏览器。请检查 Windows 的默认浏览器设置后重试。');}
}
async function publicSettings():Promise<DesktopSettings>{
 if(auth.snapshot().status==='signed_in'&&!models.length)await refreshModels();const data=vault.get();const snapshot=auth.snapshot();
 return {...data.preferences,hasApiKey:!!data.apiKey,hasDoubaoApiKey:!!data.doubaoApiKey,localTtsReady:localTts?.ready()??false,qwenTtsReady:qwenTts?.ready()??false,qwenCudaReady:qwenCudaRuntimeReady(app.isPackaged?join(process.resourcesPath,'qwen-tts-runtime'):resolve(app.getAppPath(),'../qwen-tts-runtime')),encryptionAvailable:vault.available(),auth:snapshot,models:[...models],restartRequired};
}
function handle(channel:string,action:(...args:unknown[])=>unknown){
 ipcMain.handle(channel,async(event,...args)=>{assertSender(event);try{if(shuttingDown)throw Error('软件正在退出，请重新打开后操作。');return await action(...args);}catch(error){
  // App-owned messages only; no raw network errors, credential values or IPC input in logs.
  if(error instanceof Error&&/^[\u3400-\u9fff]/.test(error.message)&&error.message.length<400)throw Error(error.message,{cause:undefined});
  throw Error('操作未完成。请检查本机设置或重新登录；未输出任何凭证。',{cause:undefined});
 }});
}
let modelRequest=0;
async function refreshModels(){const ticket=++modelRequest;const accountId=auth.snapshot().activeAccountId;const next=await auth.listModels().catch(()=>[]);if(ticket===modelRequest&&accountId===auth.snapshot().activeAccountId&&auth.snapshot().status==='signed_in')models=next;}
async function makeShortcut(){
 if(!app.isPackaged)throw Error('请先使用打包后的桌面软件创建快捷方式。');
 const path=join(app.getPath('desktop'),'PDF AI Teacher.lnk');
 try{await access(path);const existing=shell.readShortcutLink(path);if(existing.target!==process.execPath)throw Error('桌面已有同名快捷方式，未覆盖。');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(!shell.writeShortcutLink(path,'create',{target:process.execPath,cwd:app.getPath('exe').replace(/[^\\/]+$/,''),description:'PDF 阅读、理论解答与自然朗读',icon:process.execPath,iconIndex:0,appUserModelId:'local.pdf-ai-teacher.desktop'}))throw Error('无法创建桌面快捷方式。');
 return {path};
}
async function shutdown(){
 if(shuttingDown)return;shuttingDown=true;auth?.dispose();
 await Promise.race([(async()=>{await Promise.resolve(localApp?.locals.dispose?.()).catch(()=>{});await auth?.flush().catch(()=>{});await vault?.flush();})(),new Promise(resolve=>setTimeout(resolve,2500))]);
 if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
 app.exit(0);
}
async function start(){
 await app.whenReady();
 const desktopFetch=createDesktopFetch(session.fromPartition('pdf-teacher-provider',{cache:false}));
 vault=new SettingsVault(join(app.getPath('userData'),'private-settings.bin'),{available:()=>safeStorage.isEncryptionAvailable(),encrypt:value=>safeStorage.encryptString(value),decrypt:value=>safeStorage.decryptString(value)});
 await vault.load();
 auth=new ChatGptAuthManager({readAuth:async()=>vault.get().auth as AuthStore|null,writeAuth:async value=>{await vault.update({auth:value});},openExternal:openAuthorization,fetch:desktopFetch});
 await auth.initialize();
 const data=vault.get(),prefs=data.preferences;
 const config=serverConfigFor(prefs,data.apiKey,data.port,data.doubaoApiKey);
 config.authMode=prefs.mode==='chatgpt'?'chatgpt':'api_key';
 const runtimePath=app.isPackaged?join(process.resourcesPath,'local-tts-runtime'):resolve(app.getAppPath(),'../local-tts-runtime');
 localTts=new LocalTtsProvider({workerPath:join(runtimePath,'local-tts-worker.cjs'),runtimePath,modelDir:join(runtimePath,'model'),voice:prefs.localTtsVoice??'zf_001',threads:2});
 const qwenPath=app.isPackaged?join(process.resourcesPath,'qwen-tts-runtime'):resolve(app.getAppPath(),'../qwen-tts-runtime');
 qwenTts=new QwenTtsProvider({runtimePath:qwenPath,workPath:join(app.getPath('userData'),'voice-work'),device:config.qwenTtsDevice??'cpu',voice:prefs.qwenTtsVoice??'serena',instructions:config.qwenTtsInstructions??''});
 localApp=createApp({config,localTts,qwenTts,fetch:desktopFetch,chatGptAuth:prefs.mode==='chatgpt'?{getAccessToken:signal=>auth.getAccessToken(signal)}:undefined});
 const token=(await import('node:crypto')).randomBytes(32).toString('hex');
 const guarded=express();
 guarded.use((req,res,next)=>{if(req.header('x-desktop-instance')!==token){res.status(403).send('此地址仅供 PDF AI Teacher 桌面窗口使用。');return;}next();});
 guarded.use(localApp);
 const dist=join(app.getAppPath(),'dist');
 guarded.use((_req,res,next)=>{res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");next();});
 guarded.use(express.static(dist,{dotfiles:'deny'}));guarded.get('/',(_req,res)=>res.sendFile(join(dist,'index.html')));
 server=createServer(guarded);
 await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(data.port,'127.0.0.1',()=>resolve());});
 origin='http://127.0.0.1:'+data.port;
 mainWindow=new BrowserWindow({width:1500,height:960,minWidth:1050,minHeight:680,title:'PDF AI Teacher',backgroundColor:'#f5f7f2',icon:join(app.getAppPath(),'assets/app.png'),show:false,autoHideMenuBar:true,webPreferences:{preload:join(app.getAppPath(),'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,spellcheck:false,partition:'persist:pdf-teacher'}});
 Menu.setApplicationMenu(null);
 const windowSession=mainWindow.webContents.session;
 windowSession.webRequest.onBeforeSendHeaders({urls:[origin+'/*']},(details,callback)=>{if(details.webContentsId===mainWindow?.webContents.id)details.requestHeaders['x-desktop-instance']=token;callback({requestHeaders:details.requestHeaders});});
 mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 mainWindow.webContents.on('will-navigate',(event,url)=>{if(url!==origin+'/')event.preventDefault();});
 mainWindow.webContents.on('will-attach-webview',event=>event.preventDefault());
 let microphoneApproved=false;
 windowSession.setPermissionCheckHandler((contents,permission,requestingOrigin,details)=>contents===mainWindow?.webContents&&details.isMainFrame&&requestingOrigin===origin&&(permission==='clipboard-sanitized-write'||(permission==='media'&&microphoneApproved&&details.mediaType==='audio'&&details.securityOrigin===origin)));
 windowSession.setPermissionRequestHandler((contents,permission,callback,details)=>{
  if(contents!==mainWindow?.webContents||!details.isMainFrame||details.requestingUrl!==origin+'/'||contents.getURL()!==origin+'/'){callback(false);return;}
  if(permission==='clipboard-sanitized-write'){callback(true);return;}
  if(permission!=='media'||!('mediaTypes' in details)||!details.mediaTypes?.length||details.mediaTypes.some(type=>type!=='audio')){callback(false);return;}
  void dialog.showMessageBox(mainWindow!,{type:'question',buttons:['取消','允许麦克风'],defaultId:0,cancelId:0,title:'使用麦克风',message:'允许本软件使用麦克风吗？',detail:'打字提问和朗读不需要麦克风。仅在你主动开启语音功能时使用。'}).then(result=>{microphoneApproved=result.response===1;callback(microphoneApproved);}).catch(()=>callback(false));
 });
 handle('desktop:settings',publicSettings);
 handle('desktop:save',async input=>{
  const parsed=SaveSettingsSchema.safeParse(input);if(!parsed.success)throw Error('配置格式不正确，请检查模型名称与推理强度。');
  const {apiKey,clearApiKey,doubaoApiKey,clearDoubaoApiKey,...preferences}=parsed.data;
  const current=vault.get();const nextKey=clearApiKey?'':apiKey||current.apiKey;const nextDoubaoKey=clearDoubaoApiKey?'':doubaoApiKey||current.doubaoApiKey;
  if(preferences.mode==='api'&&!nextKey)throw Error('API 模式需要在本机填写 API Key。也可以选择 ChatGPT 登录。');
  if(preferences.mode==='chatgpt'&&auth.snapshot().status!=='signed_in')throw Error('请先使用 ChatGPT 账号登录。');
  serverConfigFor(preferences,nextKey,current.port,nextDoubaoKey);await vault.update({preferences,apiKey:nextKey,doubaoApiKey:nextDoubaoKey});restartRequired=true;return publicSettings();
 });
 handle('desktop:login',async accountId=>{if(accountId!==undefined&&(typeof accountId!=='string'||accountId.length>300))throw Error('账号选择无效。');await auth.login(accountId as string|undefined);await localApp?.locals.dispose?.();await refreshModels();const current=vault.get();await vault.update({preferences:{...current.preferences,mode:'chatgpt'}});restartRequired=true;return publicSettings();});
 handle('desktop:cancel-login',()=>auth.cancelLogin());
 handle('desktop:select-account',async accountId=>{if(typeof accountId!=='string'||accountId.length>300)throw Error('账号选择无效。');await auth.selectAccount(accountId);await localApp?.locals.dispose?.();await refreshModels();restartRequired=true;return publicSettings();});
 handle('desktop:logout',async()=>{modelRequest++;models=[];await localApp?.locals.dispose?.();await auth.logout();models=[];await vault.update({preferences:{...vault.get().preferences,mode:'demo'}});restartRequired=true;return publicSettings();});
 handle('desktop:account-page',async page=>{if(typeof page!=='string'||!Object.hasOwn(accountUrls,page))throw Error('不支持的账号页面。');await shell.openExternal(accountUrls[page as keyof typeof accountUrls]);});
 handle('desktop:shortcut',makeShortcut);
 handle('desktop:restart',async()=>{if(restarting)return;restarting=true;await mainWindow?.webContents.executeJavaScript("window.dispatchEvent(new Event('pagehide'))");app.relaunch();setTimeout(()=>app.quit(),300);});
 mainWindow.once('ready-to-show',()=>mainWindow?.show());
 mainWindow.on('closed',()=>{mainWindow=null;});
 await mainWindow.loadURL(origin+'/');
 if(auth.snapshot().status==='signed_in')void refreshModels();
}
if(!configureUserData()){app.exit(1);}else if(!app.requestSingleInstanceLock()){app.quit();}else{
 app.on('second-instance',()=>{if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}});
 app.on('window-all-closed',()=>app.quit());
 app.on('before-quit',event=>{if(!shuttingDown){event.preventDefault();void shutdown();}});
 void start().catch(async error=>{const code=(error as NodeJS.ErrnoException).code;const message=code==='EADDRINUSE'?'本软件需要的本机端口 4319 已被占用。请关闭之前的 PDF AI Teacher 窗口再试；没有停止其他进程。':error instanceof Error&&/^[\u3400-\u9fff]/.test(error.message)?error.message:'桌面应用启动失败。请检查本软件目录完整且可写，随后重新打开。';if(process.env.PDF_TEACHER_TEST_MODE==='1')console.error(message);else dialog.showErrorBox('PDF AI Teacher 无法启动',message);await shutdown();});
}
