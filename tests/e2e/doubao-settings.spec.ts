import { expect, test, type Page } from '@playwright/test';
import type { DesktopPreferences, DesktopSettings, DesktopTeacherBridge } from '../../packages/shared/desktop';
import { DEFAULT_DOUBAO_TTS_INSTRUCTIONS, DEFAULT_DOUBAO_TTS_VOICE, DOUBAO_TTS_VOICES } from '../../packages/shared/doubaoSpeech';

type Save = Parameters<DesktopTeacherBridge['saveSettings']>[0];
type Probe = { state: DesktopSettings; saves: Save[]; pages: string[]; events: string[]; failNext: boolean };
const seed: DesktopSettings = {
  mode: 'chatgpt', chatModel: 'expert-text', visionModel: 'expert-vision', reasoningEffort: 'xhigh',
  ttsEngine: 'none',
  ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'marin', ttsInstructions: '原有 OpenAI 语气',
  hasApiKey: true, hasDoubaoApiKey: false, encryptionAvailable: true, restartRequired: false,
  auth: { status: 'signed_in', activeAccountId: 'test-account', accounts: [{id:'test-account',label:'模拟专业解题账号',status:'signed_in'}] },
  models: [{id:'expert-text',name:'模拟专业文字模型'},{id:'expert-vision',name:'模拟专业看图模型'}],
};
async function setup(page: Page, patch: Partial<DesktopSettings> = {}) {
  await page.addInitScript(settings => {
    const probe: Probe = { state: settings, saves: [], pages: [], events: [], failNext: false };
    Object.defineProperty(window, '__doubaoSettings', { value: probe });
    const bridge: DesktopTeacherBridge = {
      getSettings: async () => structuredClone(settings),
      saveSettings: async input => {
        probe.saves.push(input); probe.events.push('save');
        if (probe.failNext) { probe.failNext = false; throw Error('模拟保存失败，请重新填写凭证后重试。'); }
        const { apiKey, clearApiKey, doubaoApiKey, clearDoubaoApiKey, ...preferences } = input;
        Object.assign(settings, preferences); if (apiKey) settings.hasApiKey = true; if (clearApiKey) settings.hasApiKey = false;
        if (doubaoApiKey) settings.hasDoubaoApiKey = true; if (clearDoubaoApiKey) settings.hasDoubaoApiKey = false;
        settings.restartRequired = true; return structuredClone(settings);
      },
      restart: async () => { probe.events.push('restart'); },
      openAccountPage: async page => { probe.pages.push(page); },
      login: async () => { throw Error('本设置测试不登录账号'); }, cancelLogin: async () => {},
      logout: async () => structuredClone(settings), selectAccount: async () => structuredClone(settings), createShortcut: async () => ({path:'mock.lnk'}),
    };
    Object.defineProperty(window, 'desktopTeacher', { value: bridge });
  }, {...seed,...patch});
  const tts: string[] = [];
  await page.route('**/api/tts', route => { tts.push(route.request().postData() ?? ''); return route.fulfill({ status: 500, json: {message:'设置不应自动请求语音'} }); });
  await page.goto('/'); await page.getByRole('button', {name:'声音设置',exact:true}).click();
  return tts;
}
async function probe(page: Page) { return page.evaluate(() => (window as unknown as {__doubaoSettings:Probe}).__doubaoSettings); }
async function chooseDoubao(page: Page) { await page.getByRole('combobox', {name:'朗读方式',exact:true}).selectOption('doubao'); }
const retained: Partial<DesktopPreferences> = {mode:'chatgpt',chatModel:'expert-text',visionModel:'expert-vision',reasoningEffort:'xhigh',ttsModel:'gpt-4o-mini-tts',ttsVoice:'marin',ttsInstructions:'原有 OpenAI 语气'};

test('默认关闭朗读，豆包三种声音可无 Key 保存，入口说明额度和文本外发且不自动请求', async ({page}) => {
  const tts = await setup(page); const engine = page.getByRole('combobox',{name:'朗读方式',exact:true}); await expect(engine).toHaveValue('none');
  await chooseDoubao(page); const panel = page.locator('.desktop-doubao-fields');
  await expect(panel).toContainText('尚未配置豆包声音'); await expect(panel).toContainText('文本会发送至火山引擎');
  await expect(panel).toContainText('超出免费额度可能计费'); await expect(panel).toContainText('不会自动保证免费');
  const originalUrl = page.url(); await page.getByRole('button',{name:'打开豆包官方试用指南',exact:true}).click();
  await page.getByRole('button',{name:'打开火山引擎控制台',exact:true}).click();
  expect((await probe(page)).pages).toEqual(['doubao-guide','doubao-console']); expect(page.url()).toBe(originalUrl);
  const voice = page.getByRole('combobox',{name:'豆包中文音色',exact:true}); const style = page.getByRole('textbox',{name:'豆包朗读语气',exact:true});
  await expect(voice.locator('option')).toHaveCount(3); await expect(voice).toHaveValue(DEFAULT_DOUBAO_TTS_VOICE);
  await expect(style).toHaveValue(DEFAULT_DOUBAO_TTS_INSTRUCTIONS); await expect(style).toHaveAttribute('maxlength','1000');
  for (const sound of DOUBAO_TTS_VOICES) {
    await voice.selectOption(sound.id); await style.fill('平和地朗读教材，保留原文。'+sound.name);
    await page.getByRole('button',{name:'保存设置',exact:true}).click(); await expect(page.getByRole('button',{name:'保存设置',exact:true})).toBeDisabled();
    const saved = (await probe(page)).saves.at(-1); expect(saved).toMatchObject({...retained,ttsEngine:'doubao',doubaoTtsVoice:sound.id,doubaoTtsInstructions:'平和地朗读教材，保留原文。'+sound.name});
    expect(saved).not.toHaveProperty('doubaoApiKey'); expect(saved).not.toHaveProperty('apiKey');
  }
  await expect(panel).toContainText('尚未配置豆包声音'); expect((await probe(page)).events).not.toContain('restart'); expect(tts).toEqual([]);
  await page.getByRole('button',{name:'关闭设置',exact:true}).click(); await page.getByRole('button',{name:'声音设置',exact:true}).click();
  await expect(voice).toHaveValue(DOUBAO_TTS_VOICES[2].id);
  await style.fill('更平和，但不改动原文。'); await page.getByRole('button',{name:'应用并重启',exact:true}).click();
  expect((await probe(page)).events.slice(-2)).toEqual(['save','restart']); expect((await probe(page)).saves.at(-1)?.doubaoTtsInstructions).toBe('更平和，但不改动原文。'); expect(tts).toEqual([]);
});

test('豆包与 OpenAI 密钥分别提交、保存后清空且不回显或进入网页存储，720p 可操作', async ({page}) => {
  const tts = await setup(page); await chooseDoubao(page); const key = page.getByRole('textbox',{name:'豆包语音 API Key',exact:true});
  await expect(key).toHaveAttribute('type','password'); await key.fill('mock-doubao-key-not-a-secret');
  await page.locator('.desktop-advanced summary').click(); const openai = page.getByRole('textbox',{name:'OpenAI API Key',exact:true}); await openai.fill('mock-openai-key-not-a-secret');
  await page.getByRole('button',{name:'保存设置',exact:true}).click(); await expect(key).toHaveValue(''); await expect(openai).toHaveValue('');
  expect((await probe(page)).saves.at(-1)).toMatchObject({...retained,doubaoApiKey:'mock-doubao-key-not-a-secret',apiKey:'mock-openai-key-not-a-secret'});
  await expect(page.locator('.desktop-doubao-fields')).toContainText('本机已保存豆包 API Key；不会回显');
  const stored = await page.evaluate(() => JSON.stringify({local:{...localStorage},session:{...sessionStorage},text:document.body.innerText}));
  expect(stored).not.toContain('mock-doubao-key-not-a-secret'); expect(stored).not.toContain('mock-openai-key-not-a-secret');
  expect(tts).toEqual([]); expect((await probe(page)).events).not.toContain('restart');
  await page.getByRole('button',{name:'关闭设置',exact:true}).click(); await page.getByRole('button',{name:'声音设置',exact:true}).click(); await expect(key).toHaveValue('');
  await page.setViewportSize({width:1280,height:720}); await key.scrollIntoViewIfNeeded(); await expect(key).toBeInViewport({ratio:1});
  await page.screenshot({path:'test-results/doubao-settings-720.png',fullPage:true});
});

test('删除豆包 Key 不清除 OpenAI Key、账号或已有音色设置', async ({page}) => {
  await setup(page,{ttsEngine:'doubao',hasDoubaoApiKey:true,doubaoTtsVoice:DOUBAO_TTS_VOICES[1].id,doubaoTtsInstructions:'旧豆包语气'});
  const key = page.getByRole('textbox',{name:'豆包语音 API Key',exact:true}); await expect(key).toHaveValue('');
  await page.getByRole('checkbox',{name:'删除本机保存的豆包 API Key（保存后生效）',exact:true}).check();
  await page.getByRole('button',{name:'保存设置',exact:true}).click(); const state = await probe(page);
  expect(state.saves.at(-1)).toMatchObject({...retained,clearDoubaoApiKey:true,doubaoTtsVoice:DOUBAO_TTS_VOICES[1].id,doubaoTtsInstructions:'旧豆包语气'});
  expect(state.saves.at(-1)).not.toHaveProperty('clearApiKey'); expect(state.state.hasApiKey).toBe(true); expect(state.state.hasDoubaoApiKey).toBe(false);
  await expect(page.locator('.desktop-doubao-fields')).toContainText('尚未配置豆包声音');
});

test('豆包凭证提交失败也清空，允许用户重新填写后显式重试', async ({page}) => {
  await setup(page); await chooseDoubao(page);
  await page.evaluate(() => { (window as unknown as {__doubaoSettings:Probe}).__doubaoSettings.failNext = true; });
  const key = page.getByRole('textbox',{name:'豆包语音 API Key',exact:true}); await key.fill('mock-failed-key');
  await page.getByRole('button',{name:'保存设置',exact:true}).click(); await expect(key).toHaveValue('');
  await expect(page.locator('.desktop-setting-error')).toContainText('模拟保存失败');
  await expect(page.locator('.desktop-doubao-fields')).toContainText('尚未配置豆包声音');
  await key.fill('mock-retry-key'); await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await expect(key).toHaveValue(''); expect((await probe(page)).saves).toHaveLength(2); expect((await probe(page)).state.hasDoubaoApiKey).toBe(true);
});

test('本机加密不可用时禁用豆包凭证输入，仍能了解声音与官方配置入口', async ({page}) => {
  await setup(page,{encryptionAvailable:false}); await chooseDoubao(page);
  await expect(page.getByRole('textbox',{name:'豆包语音 API Key',exact:true})).toBeDisabled();
  await expect(page.getByRole('combobox',{name:'豆包中文音色',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'打开豆包官方试用指南',exact:true})).toBeEnabled();
});
