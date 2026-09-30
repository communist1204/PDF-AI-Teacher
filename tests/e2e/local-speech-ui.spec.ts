import { expect, test, type Page } from '@playwright/test';
import type { DesktopPreferences, DesktopSettings } from '../../packages/shared/desktop';
import type { SpeechEngine } from '../../packages/shared/localSpeech';
import { mockSourceSpeech } from './realtimeHarness';

type LocalHarness = { speechCalls: string[]; saves: Array<DesktopPreferences & {apiKey?: string}>; restarts: number; audio: HTMLAudioElement[] };
async function setup(page: Page, engine: SpeechEngine = 'local', ready = true, mode = 'demo') {
  await page.addInitScript(({ engine, ready }) => {
    const state: LocalHarness = { speechCalls: [], saves: [], restarts: 0, audio: [] };
    Object.defineProperty(window, '__localSpeech', { value: state });
    const settings: DesktopSettings = { mode: 'demo', chatModel: 'gpt-6-astra', visionModel: 'gpt-6-astra', reasoningEffort: 'xhigh', ttsEngine: engine, localTtsVoice: 'zf_001', ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'marin', ttsInstructions: '自然陪读', localTtsReady: ready, hasApiKey: false, encryptionAvailable: true, auth: {status: 'signed_out', accounts: []}, models: [], restartRequired: false };
    Object.defineProperty(window, 'desktopTeacher', { value: {
      getSettings: async () => structuredClone(settings),
      saveSettings: async (input: DesktopPreferences & {apiKey?: string}) => { state.saves.push(input); Object.assign(settings, input); settings.restartRequired = true; return structuredClone(settings); },
      login: async () => { throw Error('This local voice test must not log in'); }, cancelLogin: async () => {}, logout: async () => structuredClone(settings), selectAccount: async () => structuredClone(settings),
      restart: async () => { state.restarts++; }, openAccountPage: async () => { throw Error('This local voice test must not open billing'); }, createShortcut: async () => ({path: 'mock.lnk'}),
    } });
    class Utterance { onstart: (() => void) | null = null; onresume: (() => void) | null = null; constructor(public text: string) {} }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance });
    Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [{name:'Mock system Chinese',lang:'zh-CN',localService:true}], speak(value: Utterance) { state.speechCalls.push(value.text); queueMicrotask(() => value.onstart?.()); }, cancel() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {} } });
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); state.audio.push(this); } };
  }, { engine, ready });
  await page.route('**/api/config', async route => { const response = await route.fetch(); const config = await response.json(); await route.fulfill({json: {...config, mode, models: {...config.models, tts: engine === 'local' ? 'kokoro-v1.1-zh' : ''}, capabilities: {...config.capabilities, tts: ready ? 'supported' : 'unconfigured'}, speech: {engine, ready, voice: engine === 'local' ? 'zf_001' : 'system', style: '', instructionsSupported: false}}}); });
  const localRequests: string[] = []; const remoteRequests: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/api/tts') localRequests.push(request.postDataJSON().text); if (!['127.0.0.1','localhost'].includes(url.hostname) && url.protocol.startsWith('http')) remoteRequests.push(request.url()); });
  await mockSourceSpeech(page);
  await page.goto('/');
  return { localRequests, remoteRequests };
}
async function selectText(page: Page) {
  await page.getByRole('button', {name: /示例/}).click(); await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
  const text = page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first(); await expect(text).toBeVisible(); const box = (await text.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {steps:12}); await page.mouse.up();
}
async function harness(page: Page) { return page.evaluate(() => { const state = (window as unknown as {__localSpeech: LocalHarness}).__localSpeech; return {speechCalls:state.speechCalls,saves:state.saves,restarts:state.restarts}; }); }

test('免费本地语音默认不需 Key，可切换中文音色并持久化，OpenAI 配置只在主动选择后显示', async ({page}) => {
  await setup(page); await page.getByRole('button', {name:'声音设置',exact:true}).click();
  const voice = page.locator('.desktop-speech-fields');
  await expect(page.getByRole('combobox',{name:'朗读方式',exact:true})).toHaveValue('local');
  await expect(voice).toContainText('不需要 API Key、登录或充值'); await expect(voice).toContainText('本地语音模型已就绪');
  await expect(page.getByRole('combobox',{name:'本地中文音色',exact:true}).locator('option')).toHaveCount(6);
  await page.locator('.desktop-advanced summary').click(); await expect(page.getByRole('combobox',{name:'朗读音色',exact:true})).toHaveCount(0);
  await page.getByRole('combobox',{name:'朗读方式',exact:true}).selectOption('openai'); await expect(page.getByRole('combobox',{name:'朗读音色',exact:true})).toBeVisible(); await expect(voice).toContainText('API 额度');
  await page.getByRole('combobox',{name:'朗读方式',exact:true}).selectOption('local'); await page.getByRole('combobox',{name:'本地中文音色',exact:true}).selectOption('zm_011');
  await page.setViewportSize({width:1280,height:720}); await voice.scrollIntoViewIfNeeded(); await page.screenshot({path:'test-results/local-speech-settings-720.png',fullPage:true});
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  expect((await harness(page)).saves.at(-1)).toMatchObject({ttsEngine:'local',localTtsVoice:'zm_011'}); expect((await harness(page)).saves.at(-1)).not.toHaveProperty('apiKey'); expect((await harness(page)).restarts).toBe(0);
  await page.getByRole('button',{name:'关闭设置',exact:true}).click(); await page.getByRole('button',{name:'声音设置',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'本地中文音色',exact:true})).toHaveValue('zm_011');
  await page.getByRole('combobox',{name:'朗读方式',exact:true}).selectOption('system'); await expect(voice).toContainText('系统基本语音：免费');
  await page.getByRole('button',{name:'应用并重启',exact:true}).click(); expect((await harness(page)).saves.at(-1)).toMatchObject({ttsEngine:'system'}); expect((await harness(page)).restarts).toBe(1);
});

test('问答仍为演示时本地 AI 朗读使用音频接口，暂停续读及听讲解均不调用系统声音或 OpenAI', async ({page}) => {
  const {localRequests, remoteRequests} = await setup(page); await selectText(page);
  await expect(page.locator('.audio-kind')).toHaveText('免费本地 AI 合成语音');
  await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读'); expect(localRequests.length).toBeGreaterThan(0);
  const source = await page.getByTestId('reading-subtitle').textContent();
  await page.getByRole('button',{name:'暂停朗读',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('已暂停');
  await page.getByRole('button',{name:'继续朗读',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  await page.getByRole('textbox',{name:'输入文字问题'}).fill('这里的历史权重怎样相加？'); await page.getByRole('button',{name:'发送问题',exact:true}).click(); await expect(page.locator('.message.assistant')).toBeVisible();
  await page.getByRole('button',{name:'听这次讲解',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读'); await expect(page.locator('.answer-speech')).toContainText('可用底部按钮');
  await page.getByRole('button',{name:'回原文继续',exact:true}).click(); await expect(page.getByTestId('reading-subtitle')).toHaveText(source??'');
  expect(localRequests.length).toBeGreaterThan(2); expect((await harness(page)).speechCalls).toEqual([]); expect(remoteRequests).toEqual([]);
  await page.getByRole('button',{name:'停止',exact:true}).click();
  await page.reload(); await page.getByRole('button',{name:/示例/}).click(); await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
  await page.getByRole('button',{name:'继续朗读',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读'); expect((await harness(page)).speechCalls).toEqual([]);
  await page.getByRole('button',{name:'停止',exact:true}).click();
});

test('未连接解题模型仍可本地朗读，缺少本地模型明确报错且不偷偷换声音', async ({page}) => {
  const {localRequests,remoteRequests} = await setup(page,'local',false,'unconfigured'); await selectText(page);
  await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect(page.getByRole('alert')).toContainText('本地语音模型尚未就绪');
  expect(localRequests).toEqual([]); expect((await harness(page)).speechCalls).toEqual([]); expect(remoteRequests).toEqual([]);
  await page.route('**/api/config',async route=>{ const response=await route.fetch();const config=await response.json();await route.fulfill({json:{...config,mode:'unconfigured',speech:{engine:'local',ready:true,voice:'zf_001',style:'',instructionsSupported:false}}}); });
  await page.reload(); await selectText(page); await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读'); expect(localRequests.length).toBeGreaterThan(0); expect((await harness(page)).speechCalls).toEqual([]);
  await page.getByRole('button',{name:'停止',exact:true}).click();
});

test('系统基本语音明确免费并走系统朗读，即使解题模式为 live 也不请求 TTS',async({page})=>{
  const {localRequests,remoteRequests}=await setup(page,'system',true,'live'); await selectText(page);
  await expect(page.locator('.audio-kind')).toHaveText('系统基本语音 · 免费');
  await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  expect((await harness(page)).speechCalls.length).toBeGreaterThan(0);expect(localRequests).toEqual([]);expect(remoteRequests).toEqual([]);
  await page.getByRole('button',{name:'停止',exact:true}).click();
});


test('本地语音取消记录标为免费生成，不显示可能计费', async ({page}) => {
  await setup(page);
  await page.route('**/api/usage',route=>route.fulfill({json:{records:[{category:'tts',model:'kokoro-v1.1-zh',requestId:'mock-local-cancel',local:true,cancelled:true,inputTokens:null,outputTokens:null,characters:12}],requestCount:1,maxRequests:100,cache:{entries:0,bytes:0,maxBytes:33554432}}}));
  await page.getByRole('button',{name:'声音设置',exact:true}).click(); await page.locator('.usage-details summary').click();
  const row=page.locator('.usage-details tbody tr').first();
  await expect(row).toContainText('本地免费');await expect(row).toContainText('本地生成，无 API 用量');await expect(row).toContainText('本地生成已取消 · 免费');await expect(row).not.toContainText('可能已计费');
});
