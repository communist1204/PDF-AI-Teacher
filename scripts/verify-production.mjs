import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
const port=4318;
const child=spawn(process.execPath,['--import','tsx','apps/server/src/index.ts','--production'],{cwd:process.cwd(),env:{...process.env,APP_PORT:String(port),DEMO_MODE:'true'},windowsHide:true,stdio:'pipe'});
let startup='';
child.stdout.on('data',chunk=>{startup+=chunk.toString();});
child.stderr.on('data',chunk=>{startup+=chunk.toString();});
let browser;
try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:'+port+'/api/config')).ok)break;}catch{/* server is still starting */}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+port);
  await page.getByRole('button',{name:/示例/}).click();
  const span=page.locator('.textLayer span').filter({hasText:'这是一份用于测试阅读器'}).first();
  await span.waitFor({state:'visible'});
  const box=await span.boundingBox();
  await page.mouse.move(box.x+1,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width-1,box.y+box.height/2,{steps:12});await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('.selection-preview')?.textContent?.includes('自制练习'));
  await page.evaluate(()=>{
    const events=[];
    Object.defineProperty(window,'__audioEvents',{value:events});
    new MutationObserver(()=>events.push(document.querySelector('.audio-source strong')?.textContent)).observe(document.querySelector('.audio-source'),{childList:true,subtree:true,characterData:true});
  });
  await page.getByRole('button',{name:'朗读所选',exact:true}).click();
  await page.waitForTimeout(2200);
  const voices=await page.evaluate(()=>speechSynthesis.getVoices().filter(v=>v.localService).map(v=>({name:v.name,lang:v.lang})));
  const events=await page.evaluate(()=>window.__audioEvents);
  const subtitle=await page.getByTestId('reading-subtitle').textContent();
  await page.getByRole('button',{name:'停止',exact:true}).click();
  const stopped=await page.locator('.audio-source strong').textContent();
  await page.getByRole('button',{name:'讲解这里',exact:true}).click();
  await page.getByTestId('board-step').first().waitFor({state:'visible'});
  await mkdir('docs/screenshots',{recursive:true});
  await page.screenshot({path:'docs/screenshots/production.png',fullPage:true});
  const result={date:new Date().toISOString(),browser:await browser.version(),productionPort:port,mode:'demo',pdfPages:2,realBrowserSpeech:{mock:false,localVoices:voices,selectedText:subtitle,observedStates:events,stoppedState:stopped,humanListening:'未测，事件不代表实际听感'},pageErrors:errors,providerCalls:0};
  await writeFile('docs/production-smoke.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  if(errors.length)process.exitCode=1;
}catch(error){console.error(startup);console.error(error);process.exitCode=1;}
finally{await browser?.close();child.kill();}
