/* global AbortSignal */
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
const profile=resolve('test-results','desktop-restart-'+Date.now());
const port=await new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const env={...process.env,PDF_TEACHER_DATA_DIR:profile,PDF_TEACHER_TEST_MODE:'1'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(resolve('release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe'),['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{env,windowsHide:true,stdio:'ignore'});
let browser;let page;
async function connect(){for(let i=0;i<150;i++){try{const response=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(1000)});if(response.ok){const data=await response.json();return await chromium.connectOverCDP(data.webSocketDebuggerUrl);}}catch{/* Startup/relaunch in progress. */}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Desktop debugging endpoint not ready');}
try{
 browser=await connect();page=browser.contexts()[0].pages()[0];await expect(page.locator('.teaching-route')).toBeVisible();
 await page.evaluate(()=>window.localStorage.setItem('desktop-restart-proof','saved-before-relaunch'));
 const settings=await page.evaluate(()=>window.desktopTeacher.getSettings());
 await page.evaluate(async value=>{const {mode,chatModel,visionModel,reasoningEffort,ttsModel,ttsVoice,ttsInstructions}=value;await window.desktopTeacher.saveSettings({mode,chatModel,visionModel,reasoningEffort,ttsModel,ttsVoice,ttsInstructions});},settings);
 const disconnected=new Promise(resolve=>browser.once('disconnected',resolve));const oldPid=child.pid;
 await page.evaluate(()=>window.desktopTeacher.restart());await disconnected;
 browser=await connect();page=browser.contexts()[0].pages()[0];await expect(page.locator('.teaching-route')).toBeVisible();
 expect(await page.evaluate(()=>window.localStorage.getItem('desktop-restart-proof'))).toBe('saved-before-relaunch');expect((await page.evaluate(()=>window.desktopTeacher.getSettings())).restartRequired).toBe(false);
 await page.close();await browser.close();browser=null;
 let stopped=false;for(let i=0;i<50;i++){try{await fetch('http://127.0.0.1:4319',{signal:AbortSignal.timeout(500)});}catch{stopped=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}expect(stopped).toBe(true);
 const result={date:new Date().toISOString(),realAppRelaunch:true,oldPid,settingsApplied:true,localStoragePreserved:true,serviceClosedWithWindow:stopped,realApiCalls:0};await writeFile('docs/desktop-restart.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{if(page&&!page.isClosed())await page.close().catch(()=>{});await browser?.close();if(child.exitCode===null)child.kill();}
