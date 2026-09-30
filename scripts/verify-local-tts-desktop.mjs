/* global Audio */
import {_electron as electron,expect} from '@playwright/test';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
const env={...process.env,PDF_TEACHER_DATA_DIR:resolve('test-results','real-local-voice-'+Date.now()),PDF_TEACHER_TEST_MODE:'1'};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
 app=await electron.launch({executablePath:resolve('release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe'),args:[],env,timeout:45000});
 const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');
 const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('response',async response=>{if(response.url().endsWith('/api/tts')&&response.status()>=400){const body=await response.json().catch(()=>({}));console.log(JSON.stringify({status:response.status(),error:body.error,message:body.message}));}});
 await expect(page.locator('.audio-kind')).toHaveText('免费本地 AI 合成语音');
 const prefs=await page.evaluate(()=>window.desktopTeacher.getSettings());expect(prefs.hasApiKey).toBe(false);expect(prefs.localTtsReady).toBe(true);expect(prefs.ttsEngine).toBe('local');
 await page.evaluate(()=>{window.__actualSpeech=[];const NativeAudio=Audio;window.Audio=class extends NativeAudio{constructor(src){super(src);window.__actualSpeech.push(this);}};});
 await page.getByRole('button',{name:/示例/}).first().click();await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
 const span=page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first();await expect(span).toBeVisible();const b=await span.boundingBox();const end=await page.locator('.textLayer span').filter({hasText:'合适的尺度'}).first().boundingBox();await page.mouse.move(b.x+1,b.y+b.height/2);await page.mouse.down();await page.mouse.move(end.x+end.width-1,end.y+end.height/2,{steps:12});await page.mouse.up();await expect(page.locator('.selection-preview')).toContainText('指数移动平均');
 await page.getByRole('combobox',{name:'语速',exact:true}).selectOption('0.25');
 // Check real audio decoding/time progression without playing test sounds through the user's speakers.
 await page.getByRole('slider',{name:'音量',exact:true}).fill('0');
 const start=Date.now();await page.getByRole('button',{name:'朗读所选',exact:true}).click();await Promise.race([expect(page.locator('.audio-source strong')).toContainText('正在朗读',{timeout:30000}),page.locator('.error-banner').waitFor({state:'visible',timeout:30000}).then(async()=>{await page.screenshot({path:'docs/screenshots/local-tts-desktop-failure.png',fullPage:true});throw Error(await page.locator('.error-banner').textContent());})]);
 const firstAudioMs=Date.now()-start;
 const get=()=>page.evaluate(()=>{const a=window.__actualSpeech.at(-1);return a?{rate:a.playbackRate,pitch:a.preservesPitch,seconds:a.duration,time:a.currentTime,paused:a.paused}:null;});
 await expect.poll(async()=>(await get())?.time).toBeGreaterThan(0);
 const playing=await get();expect(playing.rate).toBe(0.25);expect(playing.pitch).toBe(true);expect(playing.seconds).toBeGreaterThan(1);
 const subtitle=await page.getByTestId('reading-subtitle').textContent();await page.getByRole('button',{name:'暂停朗读',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('已暂停');expect((await get()).paused).toBe(true);
 await page.getByRole('button',{name:'继续朗读',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');await expect(page.getByTestId('reading-subtitle')).toHaveText(subtitle);
 // Seek the real decoded element to its end so the test reaches the next sentence at 0.25x promptly.
 await page.evaluate(()=>{const a=window.__actualSpeech.at(-1);a.currentTime=Math.max(0,a.duration-0.05);});
 await expect.poll(()=>page.getByTestId('reading-subtitle').textContent(),{timeout:30000}).not.toBe(subtitle);
 await expect(page.locator('.audio-source strong')).toContainText('正在朗读',{timeout:30000});
 await expect.poll(()=>page.evaluate(()=>window.__actualSpeech.length)).toBeGreaterThan(1);
 expect(await page.evaluate(()=>window.__actualSpeech.filter(a=>!a.paused&&a.getAttribute('src')).length)).toBe(1);
 await page.screenshot({path:'docs/screenshots/local-tts-real-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'停止',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('待机');
 expect(await page.evaluate(()=>window.__actualSpeech.every(a=>a.paused&&!a.getAttribute('src')))).toBe(true);
 await page.getByRole('button',{name:'声音设置',exact:true}).click();await page.getByRole('combobox',{name:'朗读方式',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/local-tts-settings.png',fullPage:true});
 await page.setViewportSize({width:1280,height:720});await page.locator('.desktop-speech-fields').scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/local-tts-settings-720.png',fullPage:true});
 const result={nextSentenceRealAudio:true,singleOutput:true,date:new Date().toISOString(),packaged:true,model:'Kokoro-82M-v1.1-zh',realCPUInference:true,realHTMLAudioDecode:true,noApiKey:true,firstAudioMs,playing,pauseResumeSameSentence:true,stopClearsAllAudio:true,pageErrors:errors,humanListening:'未验收；自动播放检查使用静音，不代表用户认可听感'};
 await writeFile('docs/local-tts-desktop-smoke.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));expect(errors).toEqual([]);
}finally{await app?.close();}
