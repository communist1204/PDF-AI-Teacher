import { expect, test, type Page } from '@playwright/test';
import type { DesktopPreferences, DesktopSettings, DesktopTeacherBridge } from '../../packages/shared/desktop';
import { DEFAULT_DOUBAO_TTS_INSTRUCTIONS, DEFAULT_DOUBAO_TTS_VOICE } from '../../packages/shared/doubaoSpeech';
import { COSY_TTS_VOICES, DEFAULT_COSY_TTS_VOICE } from '../../packages/shared/cosySpeech';

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
async function chooseLocal(page: Page) { await page.getByRole('combobox', {name:'朗读方式',exact:true}).selectOption('cosy'); }
const retained: Partial<DesktopPreferences> = {mode:'chatgpt',chatModel:'expert-text',visionModel:'expert-vision',reasoningEffort:'xhigh',ttsModel:'gpt-4o-mini-tts',ttsVoice:'marin',ttsInstructions:'原有 OpenAI 语气'};

// The user retired cloud reading. These replace its former settings expectations
// while retaining persistence, credential isolation, failure and encryption coverage.
test('关闭朗读和六个本地参考音色取代旧云声音，保存及应用不自动合成', async ({page}) => {
  const tts = await setup(page); const engine = page.getByRole('combobox',{name:'朗读方式',exact:true}); await expect(engine).toHaveValue('none');
  expect(await engine.locator('option').evaluateAll(items=>items.map(item=>(item as HTMLOptionElement).value))).toEqual(['none','cosy']);
  await chooseLocal(page); const panel = page.locator('.desktop-cosy-fields');
  await expect(panel).toContainText('不上传朗读文字'); await expect(panel).toContainText('不等同于官方云端原版');
  await expect(page.getByRole('textbox',{name:'豆包语音 API Key',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'打开火山引擎控制台',exact:true})).toHaveCount(0);
  const voice = page.getByRole('combobox',{name:'CosyVoice 中文音色',exact:true}); await expect(voice).toHaveValue(DEFAULT_COSY_TTS_VOICE);
  for (const sound of COSY_TTS_VOICES) {
    await voice.selectOption(sound.id); await page.getByRole('button',{name:'保存设置',exact:true}).click();
    await expect(page.getByRole('button',{name:'保存设置',exact:true})).toBeDisabled();
    const saved = (await probe(page)).saves.at(-1); expect(saved).toMatchObject({...retained,ttsEngine:'cosy',cosyTtsVoice:sound.id});
    expect(saved).not.toHaveProperty('doubaoApiKey'); expect(saved).not.toHaveProperty('apiKey');
  }
  expect((await probe(page)).events).not.toContain('restart'); expect(tts).toEqual([]);
  await page.getByRole('button',{name:'关闭设置',exact:true}).click(); await page.getByRole('button',{name:'声音设置',exact:true}).click();
  await expect(voice).toHaveValue(COSY_TTS_VOICES[5].id); await voice.selectOption(COSY_TTS_VOICES[1].id);
  await page.getByRole('button',{name:'应用并重启',exact:true}).click();
  expect((await probe(page)).events.slice(-2)).toEqual(['save','restart']); expect(tts).toEqual([]);
});

test('解题 API 密钥仍独立保存且不回显，移除云朗读不影响专业模型，720p可操作', async ({page}) => {
  const tts = await setup(page,{hasDoubaoApiKey:true}); await chooseLocal(page);
  await page.locator('.desktop-advanced summary').click(); const openai = page.getByRole('textbox',{name:'OpenAI API Key',exact:true});
  await expect(openai).toHaveAttribute('type','password'); await openai.fill('mock-openai-key-not-a-secret');
  await page.getByRole('button',{name:'保存设置',exact:true}).click(); await expect(openai).toHaveValue('');
  expect((await probe(page)).saves.at(-1)).toMatchObject({...retained,apiKey:'mock-openai-key-not-a-secret',ttsEngine:'cosy'});
  const stored = await page.evaluate(() => JSON.stringify({local:{...localStorage},session:{...sessionStorage},text:document.body.innerText})); expect(stored).not.toContain('mock-openai-key-not-a-secret');
  expect((await probe(page)).state.hasDoubaoApiKey).toBe(true); expect((await probe(page)).saves.at(-1)).not.toHaveProperty('clearDoubaoApiKey');
  expect(tts).toEqual([]); expect((await probe(page)).events).not.toContain('restart');
  await page.getByRole('button',{name:'关闭设置',exact:true}).click(); await page.getByRole('button',{name:'声音设置',exact:true}).click();
  await page.locator('.desktop-advanced summary').click(); await expect(openai).toHaveValue(''); await page.setViewportSize({width:1280,height:720});
  await openai.scrollIntoViewIfNeeded(); await expect(openai).toBeInViewport({ratio:1});
  await page.screenshot({path:'test-results/local-reference-expert-settings-720.png',fullPage:true});
});

test('旧豆包记录迁到本地选择，保存不删除旧密钥、专业账号与隐藏音色偏好', async ({page}) => {
  await setup(page,{ttsEngine:'doubao',hasDoubaoApiKey:true,doubaoTtsVoice:DEFAULT_DOUBAO_TTS_VOICE,doubaoTtsInstructions:DEFAULT_DOUBAO_TTS_INSTRUCTIONS});
  await expect(page.getByRole('combobox',{name:'朗读方式',exact:true})).toHaveValue('cosy');
  await expect(page.getByRole('textbox',{name:'豆包语音 API Key',exact:true})).toHaveCount(0);
  await page.getByRole('combobox',{name:'CosyVoice 中文音色',exact:true}).selectOption(COSY_TTS_VOICES[2].id);
  await page.getByRole('button',{name:'保存设置',exact:true}).click(); const state = await probe(page);
  expect(state.saves.at(-1)).toMatchObject({...retained,ttsEngine:'cosy',cosyTtsVoice:COSY_TTS_VOICES[2].id,doubaoTtsVoice:DEFAULT_DOUBAO_TTS_VOICE,doubaoTtsInstructions:DEFAULT_DOUBAO_TTS_INSTRUCTIONS});
  expect(state.saves.at(-1)).not.toHaveProperty('clearApiKey'); expect(state.saves.at(-1)).not.toHaveProperty('clearDoubaoApiKey'); expect(state.state.hasApiKey).toBe(true); expect(state.state.hasDoubaoApiKey).toBe(true);
  expect(state.state.auth.activeAccountId).toBe('test-account');
});

test('专业解题凭证提交失败仍清空，允许重新填写后显式重试', async ({page}) => {
  await setup(page); await chooseLocal(page); await page.locator('.desktop-advanced summary').click();
  await page.evaluate(() => { (window as unknown as {__doubaoSettings:Probe}).__doubaoSettings.failNext = true; });
  const key = page.getByRole('textbox',{name:'OpenAI API Key',exact:true}); await key.fill('mock-failed-key');
  await page.getByRole('button',{name:'保存设置',exact:true}).click(); await expect(key).toHaveValue(''); await expect(page.locator('.desktop-setting-error')).toContainText('模拟保存失败');
  await key.fill('mock-retry-key'); await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await expect(key).toHaveValue(''); expect((await probe(page)).saves).toHaveLength(2); expect((await probe(page)).state.hasApiKey).toBe(true);
});

test('本机加密不可用时禁止填写解题凭证，本地参考音色仍可保存', async ({page}) => {
  const tts = await setup(page,{encryptionAvailable:false}); await chooseLocal(page); await page.locator('.desktop-advanced summary').click();
  await expect(page.getByRole('textbox',{name:'OpenAI API Key',exact:true})).toBeDisabled(); await expect(page.getByRole('combobox',{name:'CosyVoice 中文音色',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'保存设置',exact:true}).click(); expect((await probe(page)).saves.at(-1)).toMatchObject({ttsEngine:'cosy'}); expect(tts).toEqual([]);
});
