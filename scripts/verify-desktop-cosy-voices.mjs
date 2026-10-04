// Real packaged desktop + local GPU. Separate profile; no user credentials or cloud calls.
import { _electron as electron, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const voices = ['local_longanyang','local_longanhuan_v3','local_longfei_v3','local_longxiaochun_v3','local_longxiaoxia_v3','local_longanyun_v3'];
const env = { ...process.env, PDF_TEACHER_DATA_DIR: resolve('test-results', `cosy-voices-desktop-${Date.now()}`), PDF_TEACHER_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const options = { executablePath: resolve('release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe'), args: [], env, timeout: 45000 };
let app;
const errors = [];
const requests = [];
async function launch() {
  app = await electron.launch(options);
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/api/tts')) requests.push({ at:Date.now(), voice:request.postDataJSON().cosyVoice, lane:request.headers()['x-task-lane'] }); });
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.teaching-route')).toContainText('打字提问');
  await page.evaluate(() => {
    const probe = { audios: [], events: [], maximum: 0 }; window.__voicesProbe = probe;
    const Native = window.Audio;
    window.Audio = class extends Native {
      constructor(src) { super(src); const index=probe.audios.length; probe.audios.push(this);
        for(const type of ['playing','waiting','ended','pause','error']) this.addEventListener(type,()=> {
          probe.maximum=Math.max(probe.maximum,probe.audios.filter(item=>!item.paused).length);
          probe.events.push({type,index,at:Date.now(),position:this.currentTime});
        });
      }
    };
  });
  return page;
}
async function probe(page) { return page.evaluate(() => { const p=window.__voicesProbe; return { events:p.events, count:p.audios.length, active:p.audios.filter(item=>!item.paused).length, maximum:p.maximum, time:p.audios.at(-1)?.currentTime??0 }; }); }
async function openSettings(page) { await page.getByRole('button',{name:'声音设置',exact:true}).click(); await expect(page.getByRole('combobox',{name:'朗读方式',exact:true})).toBeVisible(); }

try {
  let page=await launch(); await openSettings(page);
  await page.getByRole('combobox',{name:'朗读方式',exact:true}).selectOption('cosy');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await app.close(); app=undefined;
  page=await launch(); await openSettings(page);
  const select=page.getByRole('combobox',{name:'CosyVoice 中文音色',exact:true});
  expect(await select.locator('option').count()).toBe(6);
  const cases=[];
  for(const voice of voices) {
    await select.selectOption(voice);
    const before=await probe(page); const clicked=Date.now();
    await page.getByRole('button',{name:'试听这个音色',exact:true}).click();
    await expect.poll(async()=> (await probe(page)).time,{timeout:180000}).toBeGreaterThan(0.1);
    await expect(page.locator('.cosy-audition-status')).toContainText('试听结束',{timeout:60000});
    const after=await probe(page); const events=after.events.filter(item=>item.index===before.count);
    const waits=events.filter(item=>item.type==='waiting'&&item.position>0.1);
    cases.push({voice,clickToPlayingMs:events.find(item=>item.type==='playing').at-clicked,midAudioWaits:waits,events});
    await writeFile('test-results/cosy-reference-playback-checkpoint.json',JSON.stringify({cases,maximum:after.maximum},null,2)+'\n');
    expect(waits).toEqual([]); expect(after.maximum).toBe(1);
    console.log(JSON.stringify(cases.at(-1)));
  }
  // Explicit switching and closing stop audible output, even for a cached audition.
  await select.selectOption('local_longanhuan_v3'); await page.getByRole('button',{name:'试听这个音色',exact:true}).click();
  await expect.poll(async()=>(await probe(page)).time).toBeGreaterThan(0.1);
  await select.selectOption('local_longanyun_v3'); expect((await probe(page)).active).toBe(0);
  await page.getByRole('button',{name:'试听这个音色',exact:true}).click();
  await expect.poll(async()=>(await probe(page)).time).toBeGreaterThan(0.1);
  await page.getByRole('button',{name:'关闭设置',exact:true}).click(); expect((await probe(page)).active).toBe(0);
  await openSettings(page); await select.selectOption('local_longanyun_v3');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  expect((await page.evaluate(()=>window.desktopTeacher.getSettings())).cosyTtsVoice).toBe('local_longanyun_v3');
  await app.close(); app=undefined;
  page=await launch(); await openSettings(page);
  await expect(page.getByRole('combobox',{name:'CosyVoice 中文音色',exact:true})).toHaveValue('local_longanyun_v3');
  const config=await page.evaluate(()=>fetch('/api/config').then(response=>response.json()));
  expect(config.speech.voice).toBe('local_longanyun_v3');
  await page.setViewportSize({width:1280,height:800});
  await page.locator('.cosy-audition-card').scrollIntoViewIfNeeded();
  await mkdir('docs/screenshots',{recursive:true});
  await page.screenshot({path:'docs/screenshots/cosy-local-references-desktop.png',fullPage:true});
  expect(errors).toEqual([]); expect(requests.every(item=>item.lane==='speech')).toBe(true);
  const result={date:new Date().toISOString(),kind:'real-packaged-desktop-six-user-selected-local-GPU-reference-auditions',cases,
    persistedAfterRelaunch:true,appliedVoice:config.speech.voice,maximumSimultaneousAudio:1,selectionStopsAudio:true,
    closeStopsAudio:true,errors,cloudRequests:false,humanListening:'未测；这里检查真实 GPU 合成与播放器事件，不评价自然度'};
  await writeFile('docs/cosy-local-references-desktop-verification.json',JSON.stringify(result,null,2)+'\n');
  console.log('All six real GPU auditions played to completion; selection and persistence verified.');
} finally { await app?.close(); }
