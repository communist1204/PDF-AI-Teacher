import { expect, test, type Page, type Route } from '@playwright/test';
import { mockSourceSpeech } from './realtimeHarness';

async function setup(page: Page, engine: 'doubao' | 'openai' = 'doubao') {
  await page.addInitScript(() => {
    const audio: HTMLAudioElement[] = [];
    Object.defineProperty(window, '__cloudWaitingAudio', { value: audio });
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); audio.push(this); } };
  });
  await page.route('**/api/config', async route => {
    const response = await route.fetch(); const config = await response.json();
    await route.fulfill({json:{...config,mode:engine==='doubao'?'demo':'live',models:{...config.models,tts:engine==='doubao'?'DOUBAO-MOCK-NOT-PAID':'OPENAI-MOCK-NOT-PAID'},capabilities:{...config.capabilities,tts:'supported'},speech:{engine,ready:true,voice:'mock-chinese',style:'测试语气',instructionsSupported:true}}});
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
    try { if(fail)await entry!.route.fulfill({status:503,json:{error:'mock_tts_failed',message:'模拟云语音生成失败，请手动重试。'}}); else await entry!.route.fallback(); }
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
test('云音频等待期间停止会取消请求，迟到音频不播放',async({page})=>{
  const held=await setup(page);
  try {
    await page.getByRole('button',{name:'朗读所选',exact:true}).click();
    await expect(page.locator('.audio-source strong')).toContainText('准备声音'); await expect.poll(()=>held.calls.length).toBe(1);
    await expect(page.getByRole('region',{name:'Qwen 朗读状态',exact:true})).toHaveCount(0);
    const before=held.cancellations; await page.getByRole('button',{name:'停止',exact:true}).click();
    await expect.poll(()=>held.cancellations).toBeGreaterThan(before); await expect.poll(()=>held.cancelled.length).toBe(1);
    await held.releaseNext(); await expect(page.locator('.audio-source strong')).toContainText('待机');
    expect(await page.evaluate(()=>(window as unknown as {__cloudWaitingAudio:HTMLAudioElement[]}).__cloudWaitingAudio.length)).toBe(0); expect(held.calls).toHaveLength(1);
  } finally { await held.releaseAll(); }
});

test('云语音失败保留明确错误，不自动重试或退回系统声音',async({page})=>{
  const held=await setup(page);
  try {
    await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect.poll(()=>held.calls.length).toBe(1);
    await held.releaseNext(true); await expect(page.getByRole('alert')).toContainText('模拟云语音生成失败');
    await expect(page.locator('.audio-source strong')).toContainText('待机'); expect(held.calls).toHaveLength(1);
    expect(await page.evaluate(()=>(window as unknown as {__cloudWaitingAudio:HTMLAudioElement[]}).__cloudWaitingAudio.length)).toBe(0);
  } finally { await held.releaseAll(); }
});

for(const engine of ['doubao','openai'] as const) test(engine+' 云音频准备完成后可暂停续播，不显示已移除本地模型状态',async({page})=>{
  const held=await setup(page,engine);
  try {
    await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect.poll(()=>held.calls.length).toBe(1); await held.releaseNext();
    await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
    await page.getByRole('button',{name:'暂停朗读',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('已暂停');
    await page.getByRole('button',{name:'继续朗读',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读'); expect(held.calls).toHaveLength(1);
    await page.getByRole('button',{name:'停止',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('待机');
    await expect(page.getByRole('region',{name:'Qwen 朗读状态',exact:true})).toHaveCount(0);
  } finally { await held.releaseAll(); }
});
