import { expect, test, type Page } from '@playwright/test';
import type { DesktopMode, DesktopPreferences, DesktopSettings } from '../../packages/shared/desktop';
import { DEFAULT_QWEN_TTS_INSTRUCTIONS, type SpeechEngine } from '../../packages/shared/localSpeech';
import { mockSourceSpeech } from './realtimeHarness';

type QwenHarness = { systemCalls: string[]; saves: DesktopPreferences[]; restarts: number; audio: HTMLAudioElement[] };
async function setup(page: Page, options: { engine?: SpeechEngine; ready?: boolean; mode?: DesktopMode | 'unconfigured' } = {}) {
  const { engine = 'qwen', ready = true, mode = 'demo' } = options;
  await page.addInitScript(({ engine, ready, mode, instructions }) => {
    const state: QwenHarness = { systemCalls: [], saves: [], restarts: 0, audio: [] };
    Object.defineProperty(window, '__qwenSpeech', { value: state });
    const signedIn = mode === 'chatgpt';
    const settings: DesktopSettings = {
      mode: mode === 'unconfigured' ? 'demo' : mode, chatModel: 'account-expert', visionModel: 'account-vision', reasoningEffort: 'xhigh',
      ttsEngine: engine, localTtsVoice: 'zf_001', qwenTtsVoice: 'serena', qwenTtsInstructions: instructions, qwenTtsReady: ready,
      ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'marin', ttsInstructions: '云端旧设置', localTtsReady: true,
      hasApiKey: false, encryptionAvailable: true,
      auth: { status: signedIn ? 'signed_in' : 'signed_out', accounts: signedIn ? [{id:'mock-account',label:'测试账号',status:'signed_in'}] : [], ...(signedIn ? {activeAccountId:'mock-account'} : {}) },
      models: signedIn ? [{id:'account-expert',name:'账户专业模型（模拟）'},{id:'account-vision',name:'账户看图模型（模拟）'}] : [], restartRequired: false,
    };
    Object.defineProperty(window, 'desktopTeacher', { value: {
      getSettings: async () => structuredClone(settings),
      saveSettings: async (input: DesktopPreferences) => { state.saves.push(input); Object.assign(settings, input); settings.restartRequired = true; return structuredClone(settings); },
      login: async () => { throw Error('Qwen UI test must not log in'); }, cancelLogin: async () => {}, logout: async () => structuredClone(settings), selectAccount: async () => structuredClone(settings),
      restart: async () => { state.restarts++; }, openAccountPage: async () => { throw Error('Qwen UI test must not open billing'); }, createShortcut: async () => ({path:'mock.lnk'}),
    } });
    class Utterance { onstart: (() => void) | null = null; constructor(public text: string) {} }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance });
    Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [], speak(value: Utterance) { state.systemCalls.push(value.text); queueMicrotask(() => value.onstart?.()); }, cancel() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {} } });
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); state.audio.push(this); } };
  }, { engine, ready, mode, instructions: DEFAULT_QWEN_TTS_INSTRUCTIONS });
  await page.route('**/api/config', async route => {
    const response = await route.fetch(); const config = await response.json();
    await route.fulfill({json: {...config, mode: mode === 'chatgpt' ? 'live' : mode, authMode: mode === 'chatgpt' ? 'chatgpt' : 'api', models: {...config.models,chat:'account-expert',vision:'account-vision',tts:'Qwen3-TTS-1.7B-CustomVoice-Q4_K_M'}, capabilities:{...config.capabilities,tts:ready?'supported':'unconfigured'},speech:{engine,ready,voice:'serena',style:DEFAULT_QWEN_TTS_INSTRUCTIONS,instructionsSupported:true}}});
  });
  const tts: Array<{text:string;speed:number}> = []; const remote: string[] = []; const questions: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/tts') tts.push(request.postDataJSON());
    if (url.pathname === '/api/ask') questions.push(request.postDataJSON().question);
    if (url.protocol.startsWith('http') && !['127.0.0.1','localhost'].includes(url.hostname)) remote.push(request.url());
  });
  await mockSourceSpeech(page);
  await page.goto('/');
  return {tts,remote,questions};
}
async function selectText(page: Page) {
  await page.getByRole('button',{name:/示例/}).click(); await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
  const text=page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first(); await expect(text).toBeVisible(); const box=(await text.boundingBox())!;
  await page.mouse.move(box.x+1,box.y+box.height/2); await page.mouse.down(); await page.mouse.move(box.x+box.width-1,box.y+box.height/2,{steps:12}); await page.mouse.up();
}
async function harness(page: Page) {
  return page.evaluate(() => {const state=(window as unknown as {__qwenSpeech:QwenHarness}).__qwenSpeech;return {systemCalls:state.systemCalls,saves:state.saves,restarts:state.restarts,rates:state.audio.map(audio=>audio.playbackRate)};});
}

test('Qwen 是可选本地声音，三种中文音色与独立语气可保存，需主动应用重启',async({page})=>{
  await setup(page,{engine:'local'}); await page.getByRole('button',{name:'声音设置',exact:true}).click();
  const engine=page.getByRole('combobox',{name:'朗读方式',exact:true}); const panel=page.locator('.desktop-speech-fields');
  await expect(engine).toHaveValue('local'); await engine.selectOption('qwen');
  await expect(panel).toContainText('不需要 API Key、登录或充值'); await expect(panel).toContainText('CPU 生成可能需要等待'); await expect(panel).toContainText('Qwen3 语音资源已就绪');
  const voice=page.getByRole('combobox',{name:'Qwen3 中文音色',exact:true}); const style=page.getByRole('textbox',{name:'Qwen3 朗读语气',exact:true});
  await expect(voice.locator('option')).toHaveCount(3); await expect(style).toHaveAttribute('maxlength','1000'); await expect(style).toHaveValue(DEFAULT_QWEN_TTS_INSTRUCTIONS);
  await page.locator('.desktop-advanced summary').click(); await expect(page.getByRole('combobox',{name:'朗读音色',exact:true})).toHaveCount(0); await expect(page.getByRole('textbox',{name:'朗读语气',exact:true})).toHaveCount(0);
  for (const id of ['serena','vivian','uncle_fu']) {
    await voice.selectOption(id); await style.fill('用平和清晰的中文朗读，保留原文。'+id); await page.getByRole('button',{name:'保存设置',exact:true}).click();
    await expect(page.getByRole('button',{name:'保存设置',exact:true})).toBeDisabled();
    expect((await harness(page)).saves.at(-1)).toMatchObject({ttsEngine:'qwen',qwenTtsVoice:id,qwenTtsInstructions:'用平和清晰的中文朗读，保留原文。'+id,mode:'demo',ttsVoice:'marin',localTtsVoice:'zf_001'});
    expect((await harness(page)).saves.at(-1)).not.toHaveProperty('apiKey');
  }
  expect((await harness(page)).restarts).toBe(0);
  await page.getByRole('button',{name:'关闭设置',exact:true}).click(); await page.getByRole('button',{name:'声音设置',exact:true}).click(); await expect(voice).toHaveValue('uncle_fu');
  await page.setViewportSize({width:1280,height:720}); await style.scrollIntoViewIfNeeded(); await page.screenshot({path:'test-results/qwen-speech-settings-720.png',fullPage:true});
  await style.fill('轻松自然，保持原文不变。'); await page.getByRole('button',{name:'应用并重启',exact:true}).click();
  expect((await harness(page)).saves.at(-1)).toMatchObject({qwenTtsInstructions:'轻松自然，保持原文不变。'}); expect((await harness(page)).restarts).toBe(1);
});

test('没有 Key 的演示问答仍可播 Qwen WAV，0.25 倍速、暂停续读和讲解共用免费管线',async({page})=>{
  const {tts,remote}=await setup(page); await selectText(page);
  await expect(page.locator('.audio-kind')).toHaveText('Qwen3 本地 AI 语音'); await expect(page.locator('.mode-badge')).toContainText('解题 AI 未连接');
  await page.getByRole('combobox',{name:'语速',exact:true}).selectOption('0.25'); await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  expect(tts.length).toBeGreaterThan(0); expect(tts[0].speed).toBe(0.25); expect((await harness(page)).rates.at(-1)).toBe(0.25);
  const source=await page.getByTestId('reading-subtitle').textContent();
  await page.getByRole('button',{name:'暂停朗读',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('已暂停'); await page.getByRole('button',{name:'继续朗读',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  await page.getByRole('textbox',{name:'输入文字问题'}).fill('解释选段中的历史权重。'); await page.getByRole('button',{name:'发送问题',exact:true}).click(); await expect(page.locator('.answer-speech')).toContainText('免费本地 AI 声音读固定演示教案');
  await page.getByRole('button',{name:'听这次讲解',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读'); await page.getByRole('button',{name:'回原文继续',exact:true}).click(); await expect(page.getByTestId('reading-subtitle')).toHaveText(source??'');
  expect(tts.length).toBeGreaterThan(2); expect((await harness(page)).systemCalls).toEqual([]); expect(remote).toEqual([]); await page.getByRole('button',{name:'停止',exact:true}).click();
});

test('Qwen 资源缺失时提示而不假播放、不回退云语音或系统声音',async({page})=>{
  const {tts,remote}=await setup(page,{ready:false,mode:'unconfigured'}); await selectText(page);
  await expect(page.locator('.audio-kind')).toContainText('资源未就绪'); await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect(page.getByRole('alert')).toContainText('Qwen3 语音资源尚未就绪');
  expect(tts).toEqual([]); expect((await harness(page)).systemCalls).toEqual([]); expect((await harness(page)).rates).toEqual([]); expect(remote).toEqual([]);
  await page.getByRole('button',{name:'声音设置',exact:true}).click(); await expect(page.locator('.desktop-speech-fields')).toContainText('Qwen3 语音资源尚未就绪');
});

test('未连接解题模型也可用 Qwen 朗读，功能体验不误标云费用',async({page})=>{
  const {tts,remote}=await setup(page,{mode:'unconfigured'}); await selectText(page); await page.getByRole('button',{name:'功能体验',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'这些功能，现在就能试'})).toContainText('文本留在本机，无 API 费用'); await page.getByRole('button',{name:'带我试读与续读',exact:true}).click();
  await expect(page.getByRole('complementary',{name:'试读与续读引导'})).toContainText('免费本地 AI 朗读'); await page.getByRole('button',{name:'开始试读',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  expect(tts.length).toBeGreaterThan(0); expect((await harness(page)).systemCalls).toEqual([]); expect(remote).toEqual([]); await page.getByRole('button',{name:'停止',exact:true}).click();
});

test('ChatGPT 账号和专业解题模型独立于 Qwen 声音设置，免费语音用量单独标示',async({page})=>{
  const {tts,questions,remote}=await setup(page,{mode:'chatgpt'});
  await page.route('**/api/ask',async route=>{const response=await route.fetch();const body=await response.json();await route.fulfill({json:{...body,mode:'live'}});});
  await page.route('**/api/usage',route=>route.fulfill({json:{records:[{category:'tts',model:'Qwen3-TTS-1.7B-CustomVoice-Q4_K_M',requestId:'mock-qwen-cancel',local:true,cancelled:true,inputTokens:null,outputTokens:null,characters:12}],requestCount:1,maxRequests:100,cache:{entries:0,bytes:0,maxBytes:33554432}}}));
  await selectText(page); await expect(page.locator('.teaching-route')).toContainText('解题：account-expert');
  await page.getByRole('textbox',{name:'输入文字问题'}).fill('请推导选段的权重总和。'); await page.getByRole('button',{name:'发送问题',exact:true}).click(); await expect(page.locator('.message.assistant')).toBeVisible(); expect(questions).toEqual(['请推导选段的权重总和。']);
  await page.getByRole('button',{name:'听这次讲解',exact:true}).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读'); expect(tts.length).toBeGreaterThan(0); expect((await harness(page)).systemCalls).toEqual([]); expect(remote).toEqual([]); await page.getByRole('button',{name:'停止',exact:true}).click();
  await page.getByRole('button',{name:'声音设置',exact:true}).click(); await expect(page.getByRole('combobox',{name:'使用方式',exact:true})).toHaveValue('chatgpt');
  await page.getByRole('combobox',{name:'Qwen3 中文音色',exact:true}).selectOption('vivian'); await page.getByRole('button',{name:'保存设置',exact:true}).click();
  expect((await harness(page)).saves.at(-1)).toMatchObject({mode:'chatgpt',chatModel:'account-expert',visionModel:'account-vision',reasoningEffort:'xhigh',ttsEngine:'qwen',qwenTtsVoice:'vivian'});
  await page.locator('.usage-details summary').click(); const row=page.locator('.usage-details tbody tr').first(); await expect(row).toContainText('本地免费'); await expect(row).toContainText('本地生成已取消 · 免费'); await expect(row).not.toContainText('可能已计费');
  await expect(page.getByRole('dialog',{name:'设置与用量'})).toContainText('文字与看图解题使用 ChatGPT 账号授权及计划额度');
  await page.getByRole('button',{name:'关闭设置',exact:true}).click(); await expect(page.locator('.teaching-route')).toContainText('解题：account-expert'); await expect(page.locator('.desktop-pending-banner')).toContainText('设置等待应用');
});
