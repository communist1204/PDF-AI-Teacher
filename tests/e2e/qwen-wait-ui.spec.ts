import { expect, test, type Page, type Route } from '@playwright/test';
import { mockSourceSpeech } from './realtimeHarness';

async function setup(page: Page, engine: 'qwen' | 'openai' = 'qwen') {
  await page.addInitScript(() => {
    const audio: HTMLAudioElement[] = [];
    Object.defineProperty(window, '__qwenWaitingAudio', { value: audio });
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); audio.push(this); } };
  });
  await page.route('**/api/config', async route => {
    const response = await route.fetch(); const config = await response.json();
    await route.fulfill({json:{...config,mode:engine==='qwen'?'demo':'live',models:{...config.models,tts:engine==='qwen'?'Qwen3-MOCK':'OPENAI-MOCK-NOT-PAID'},capabilities:{...config.capabilities,tts:'supported'},speech:{engine,ready:true,voice:'serena',style:'测试语气',instructionsSupported:true}}});
  });
  await mockSourceSpeech(page);
  const pending: Array<{route:Route;release:()=>void}> = [];
  const calls: string[] = [];
  const cancelled: string[] = [];
  let cancellations = 0;
  page.on('requestfailed',request=>{if(new URL(request.url()).pathname==='/api/tts')cancelled.push(request.failure()?.errorText??'failed');});
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/cancel')cancellations++;});
  await page.route('**/api/tts',async route=>{
    calls.push(route.request().postDataJSON().text);
    await new Promise<void>(release=>pending.push({route,release}));
  });
  const releaseNext = async (fail = false) => {
    const entry=pending.shift(); expect(entry).toBeDefined();
    try { if(fail)await entry!.route.fulfill({status:503,json:{error:'qwen_tts_failed',message:'Qwen3 本地语音未能完成生成，请重试短句。'}}); else await entry!.route.fallback(); }
    catch { /* A deliberately late result may already belong to an aborted request. */ }
    finally { entry!.release(); }
  };
  await page.goto('/');
  await page.getByRole('button',{name:/示例/}).first().click(); await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
  const span=page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first(); await expect(span).toBeVisible(); const bounds=(await span.boundingBox())!;
  await page.mouse.move(bounds.x+1,bounds.y+bounds.height/2); await page.mouse.down(); await page.mouse.move(bounds.x+bounds.width-1,bounds.y+bounds.height/2,{steps:12}); await page.mouse.up();
  await page.getByRole('button',{name:'校对朗读文本',exact:true}).click(); await page.getByRole('textbox',{name:'确认后的朗读文本',exact:true}).fill('我们一起读书。'); await page.getByRole('button',{name:'使用校对文本',exact:true}).click();
  return {calls,cancelled,get cancellations(){return cancellations;},releaseNext,async releaseAll(){while(pending.length)await releaseNext();}};
}
const elapsed = async (page:Page) => Number((await page.getByTestId('qwen-wait-seconds').textContent())?.match(/\d+/)?.[0]);
const status = (page:Page) => page.getByRole('region',{name:'Qwen 朗读状态',exact:true});

test('Qwen 长等待显示真实秒数、可见停止入口，停止取消且迟到音频不播放',async({page})=>{
  const held=await setup(page);
  try {
    await page.setViewportSize({width:1280,height:720});
    await page.getByRole('button',{name:'朗读所选',exact:true}).click();
    await expect(status(page)).toContainText('Qwen3 正在准备声音'); await expect(status(page)).toContainText('较长句子可能需要等待');
    await expect.poll(()=>elapsed(page)).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole('button',{name:'停止本次朗读',exact:true})).toBeEnabled(); await expect(status(page)).not.toContainText('%'); await expect(status(page).getByRole('progressbar')).toHaveCount(0);
    const box=(await status(page).boundingBox())!; expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y+box.height).toBeLessThanOrEqual(720);
    await page.screenshot({path:'test-results/qwen-wait-720.png',fullPage:true});
    const before=held.cancellations; await page.getByRole('button',{name:'停止本次朗读',exact:true}).click();
    await expect(status(page)).toContainText('本地播放已停止'); await expect(status(page)).toContainText('取消请求已发出'); await expect(page.getByTestId('qwen-wait-seconds')).toHaveCount(0);
    await expect.poll(()=>held.cancellations).toBeGreaterThan(before); await expect.poll(()=>held.cancelled.length).toBe(1);
    await held.releaseNext(); await expect(page.locator('.audio-source strong')).toContainText('待机');
    expect(await page.evaluate(()=>(window as unknown as {__qwenWaitingAudio:HTMLAudioElement[]}).__qwenWaitingAudio.length)).toBe(0); expect(held.calls).toHaveLength(1);
    await page.screenshot({path:'test-results/qwen-stopped-720.png',fullPage:true});
  } finally { await held.releaseAll(); }
});

test('真实播放器开始后等待提示消失，底栏停止也确认，下一次准备从零重新计时',async({page})=>{
  const held=await setup(page);
  try {
    await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect.poll(()=>elapsed(page)).toBeGreaterThanOrEqual(2);
    await held.releaseNext(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读'); await expect(status(page)).toHaveCount(0);
    await page.getByRole('button',{name:'暂停朗读',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('已暂停'); await expect(status(page)).toHaveCount(0);
    await page.getByRole('button',{name:'继续朗读',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读'); await expect(status(page)).toHaveCount(0); expect(held.calls).toHaveLength(1);
    await page.getByRole('button',{name:'停止',exact:true}).click(); await expect(status(page)).toContainText('本地播放已停止');
    await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect(page.getByTestId('qwen-wait-seconds')).toContainText('已等待 0 秒'); await expect(status(page)).not.toContainText('本地播放已停止');
    await expect.poll(()=>held.calls.length).toBe(2); await held.releaseNext(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读'); await expect(status(page)).toHaveCount(0);
    await page.getByRole('button',{name:'停止',exact:true}).click();
  } finally { await held.releaseAll(); }
});

test('生成失败结束计时并保留明确错误，不虚报停止成功或自动重试',async({page})=>{
  const held=await setup(page);
  try {
    await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect(status(page)).toContainText('Qwen3 正在准备声音'); await expect.poll(()=>held.calls.length).toBe(1);
    await held.releaseNext(true); await expect(page.getByRole('alert')).toContainText('Qwen3 本地语音未能完成生成'); await expect(status(page)).toHaveCount(0); await expect(page.locator('.audio-source strong')).toContainText('待机'); expect(held.calls).toHaveLength(1);
  } finally { await held.releaseAll(); }
});

test('OpenAI 等待与停止不显示 Qwen 本地提示',async({page})=>{
  const held=await setup(page,'openai');
  try {
    await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('准备声音'); await expect.poll(()=>held.calls.length).toBe(1); await expect(status(page)).toHaveCount(0);
    await held.releaseNext(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读'); await page.getByRole('button',{name:'停止',exact:true}).click(); await expect(status(page)).toHaveCount(0);
  } finally { await held.releaseAll(); }
});
