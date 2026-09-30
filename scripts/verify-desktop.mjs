/* global AbortSignal */
import {_electron as electron,expect} from '@playwright/test';
import electronPath from 'electron';
import {spawn} from 'node:child_process';
import {clearTimeout} from 'node:timers';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const packaged=process.argv.includes('--packaged');
const profile=resolve('test-results','desktop-profile-'+Date.now());
const env={...process.env,PDF_TEACHER_DATA_DIR:profile,PDF_TEACHER_TEST_MODE:'1'};delete env.ELECTRON_RUN_AS_NODE;
const options={executablePath:packaged?resolve('release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe'):electronPath,args:packaged?[]:[resolve('desktop-build')],env,timeout:45000};
let application;const errors=[];let url;const secret='fake-desktop-test-key-not-a-real-credential';
async function launch(){const instance=await electron.launch(options);application=instance;const page=await instance.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForLoadState('domcontentloaded');await expect(page.locator('.teaching-route')).toContainText('打字提问');return {instance,page};}
try{
 let current=await launch();application=current.instance;let page=current.page;url=page.url();
 const native=await application.evaluate(({app,BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];const preferences=window.webContents.getLastWebPreferences();return {packaged:app.isPackaged,version:app.getVersion(),windows:BrowserWindow.getAllWindows().length,nodeIntegration:preferences.nodeIntegration,contextIsolation:preferences.contextIsolation,sandbox:preferences.sandbox};});
 expect(native.windows).toBe(1);expect(native.nodeIntegration).toBe(false);expect(native.contextIsolation).toBe(true);expect(native.sandbox).toBe(true);expect(native.packaged).toBe(packaged);
 const second=spawn(options.executablePath,options.args,{env,windowsHide:true,stdio:'ignore'});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Second instance did not exit')),10000);second.once('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('Second instance failed'));});second.once('error',reject);});expect(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)).toBe(1);
 expect((await fetch(url)).status).toBe(403);
 expect(await page.evaluate(()=>typeof window.require)).toBe('undefined');
 const settings=await page.evaluate(()=>window.desktopTeacher.getSettings());expect(settings.mode).toBe('demo');expect(settings.encryptionAvailable).toBe(true);expect(settings.auth.status).toBe('signed_out');
 await page.getByRole('button',{name:/示例/}).first().click();const span=page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first();await expect(span).toBeVisible();const b=await span.boundingBox();await page.mouse.move(b.x+1,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width-1,b.y+b.height/2,{steps:12});await page.mouse.up();await expect(page.locator('.selection-preview')).toContainText('指数移动平均');
 await page.getByRole('textbox',{name:'输入文字问题'}).fill('解释本段的符号与零初始化。');await page.getByRole('button',{name:'发送问题',exact:true}).click();await expect(page.getByTestId('board-step').first()).toBeVisible();await expect(page.locator('.katex').first()).toBeVisible();
 await page.locator('.notes summary').click();await page.getByRole('textbox',{name:'本书本地笔记',exact:true}).fill('桌面关闭重开保留这条笔记');
 await page.screenshot({path:'docs/screenshots/desktop-workspace.png',fullPage:true});
 await page.getByRole('button',{name:'设置与用量',exact:true}).click();await expect(page.getByRole('button',{name:'使用 ChatGPT 登录',exact:true})).toBeVisible();await page.screenshot({path:'docs/screenshots/desktop-settings.png',fullPage:true});await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1280,720));await page.getByRole('button',{name:'应用并重启',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/desktop-settings-720.png',fullPage:true});
 const saved=await page.evaluate(async key=>{const value=await window.desktopTeacher.getSettings();const {mode,chatModel,visionModel,reasoningEffort,ttsModel,ttsVoice,ttsInstructions}=value;return window.desktopTeacher.saveSettings({mode,chatModel,visionModel,reasoningEffort,ttsModel,ttsVoice,ttsInstructions,apiKey:key});},secret);
 expect(saved.hasApiKey).toBe(true);expect(JSON.stringify(saved)).not.toContain(secret);const stored=await readFile(resolve(profile,'private-settings.bin'));expect(stored.includes(Buffer.from(secret))).toBe(false);
 // Close the native window: exercise real unload/recovery rather than a synthetic pagehide.
 const closedEvent=application.waitForEvent('close');await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closedEvent;application=null;
 let closed=false;try{await fetch(url,{signal:AbortSignal.timeout(1500)});}catch{closed=true;}expect(closed).toBe(true);
 current=await launch();application=current.instance;page=current.page;expect(page.url()).toBe(url);const restored=await page.evaluate(()=>window.desktopTeacher.getSettings());expect(restored.hasApiKey).toBe(true);expect(JSON.stringify(restored)).not.toContain(secret);
 await page.getByRole('button',{name:/示例/}).first().click();await page.locator('.notes summary').click();await expect(page.getByRole('textbox',{name:'本书本地笔记',exact:true})).toHaveValue('桌面关闭重开保留这条笔记');
 await page.evaluate(async()=>{const value=await window.desktopTeacher.getSettings();const {mode,chatModel,visionModel,reasoningEffort,ttsModel,ttsVoice,ttsInstructions}=value;await window.desktopTeacher.saveSettings({mode,chatModel,visionModel,reasoningEffort,ttsModel,ttsVoice,ttsInstructions,clearApiKey:true});});
 const result={date:new Date().toISOString(),kind:packaged?'packaged-windows-exe':'electron-development',native,firstLaunchCreatesDataDirectory:true,secondInstanceKeepsSingleWindow:true,loopbackBlockedOutsideWindow:true,pdfSelection:true,demoQuestionAndFormula:true,realWindowsEncryption:true,keyNeverReturned:true,restartRestoresNotes:true,serviceClosedWithApp:closed,pageErrors:errors,officialLogin:'未测；没有真实账号授权',realModelAndTts:'未测；未调用任何付费模型'};
 await writeFile('docs/desktop-smoke.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));expect(errors).toEqual([]);
}finally{await application?.close();}
