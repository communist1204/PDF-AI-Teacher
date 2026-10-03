import { expect, test, type Page } from '@playwright/test';
import type { DesktopSettings, DesktopTeacherBridge } from '../../packages/shared/desktop';
import type { LearningRecord } from '../../packages/shared/learning';
import { mockCloudSpeech } from './cloudSpeechHarness';

async function sample(page: Page) {
  await page.goto('/'); await page.getByRole('button', {name:/示例/}).click(); await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
  await page.getByRole('button', {name:'选本页文字',exact:true}).click();
}
async function noSystemFallback(page: Page) {
  await page.addInitScript(() => {
    const probe={system:0}; Object.defineProperty(window,'__retiredSpeech',{value:probe});
    Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[{name:'Old local voice',voiceURI:'old-system-voice',lang:'zh-CN',localService:true}],speak(){probe.system++;},cancel(){},pause(){},resume(){},addEventListener(){},removeEventListener(){}}});
    localStorage.setItem('pdf-teacher-voice','old-system-voice');
  });
}
for(const engine of ['qwen','local','system'] as const) test('旧 '+engine+' 服务配置不回退系统声音，不产生任何 TTS 请求',async({page})=>{
  await noSystemFallback(page); const calls:string[]=[];
  await page.route('**/api/config',async route=>{const response=await route.fetch();const config=await response.json();await route.fulfill({json:{...config,mode:'live',capabilities:{...config.capabilities,tts:'supported'},models:{...config.models,tts:'retired-model'},speech:{engine,ready:true,voice:'old-voice',style:'old',instructionsSupported:true}}});});
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/tts')calls.push(request.url());});
  await sample(page); await expect(page.locator('.audio-kind')).toHaveText('朗读未启用');
  await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect(page.getByRole('alert')).toContainText('朗读未启用');
  expect(calls).toEqual([]); expect(await page.evaluate(()=>(window as unknown as {__retiredSpeech:{system:number}}).__retiredSpeech.system)).toBe(0);
});

test('默认关闭朗读，仍能打字提问和显示固定演示板书',async({page})=>{
  await noSystemFallback(page); const calls:string[]=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/api/tts')calls.push(request.url());});
  await sample(page); await page.getByRole('button',{name:'朗读所选',exact:true}).click(); await expect(page.getByRole('alert')).toContainText('朗读未启用');
  await page.getByRole('textbox',{name:'输入文字问题'}).fill('请解释选中的教材。');await page.getByRole('button',{name:'发送问题',exact:true}).click();
  await expect(page.getByTestId('board-step').first()).toBeVisible(); await expect(page.locator('.message.assistant')).toContainText('演示');
  await expect(page.getByRole('button',{name:'听这次讲解',exact:true})).toBeDisabled();expect(calls).toEqual([]);
});

test('桌面声音加入 CosyVoice 3，仍不显示已移除的声音或设备',async({page})=>{
  await page.addInitScript(()=>{
    const settings:DesktopSettings={mode:'demo',chatModel:'gpt-6-astra',visionModel:'gpt-6-astra',reasoningEffort:'xhigh',ttsEngine:'none',ttsModel:'gpt-4o-mini-tts',ttsVoice:'marin',ttsInstructions:'自然陪读',hasApiKey:false,encryptionAvailable:true,auth:{status:'signed_out',accounts:[]},models:[],restartRequired:false};
    const bridge:DesktopTeacherBridge={getSettings:async()=>structuredClone(settings),saveSettings:async input=>{Object.assign(settings,input);return structuredClone(settings);},login:async()=>{throw Error('No login in fixture');},cancelLogin:async()=>{},logout:async()=>structuredClone(settings),selectAccount:async()=>structuredClone(settings),restart:async()=>{},openAccountPage:async()=>{},createShortcut:async()=>({path:'mock.lnk'})};
    Object.defineProperty(window,'desktopTeacher',{value:bridge});
  });
  await page.goto('/');await page.getByRole('button',{name:'声音设置',exact:true}).click();
  const engine=page.getByRole('combobox',{name:'朗读方式',exact:true});await expect(engine).toHaveValue('none');
  expect(await engine.locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(['none','cosy','doubao','openai']);
  await expect(page.getByRole('dialog')).not.toContainText(/Qwen|Kokoro|系统基本语音|CUDA/u);
  await expect(page.getByRole('combobox',{name:'本地中文音色',exact:true})).toHaveCount(0);
  await expect(page.getByRole('combobox',{name:'Qwen3 运算设备',exact:true})).toHaveCount(0);
});

test('没有配置云声音时功能体验不承诺可以直接试读',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'功能体验',exact:true}).click();
  await expect(page.getByRole('button',{name:'用练习走一遍',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'试分步板书（固定样例）',exact:true})).toBeDisabled();
});

async function savedRecord(page: Page): Promise<LearningRecord | undefined> {
  return page.evaluate(async () => new Promise<LearningRecord | undefined>((resolve, reject) => {
    const open = indexedDB.open('pdf-ai-teacher-learning');
    open.onsuccess = () => {
      const db = open.result; const request = db.transaction('books').objectStore('books').getAll();
      request.onsuccess = () => { resolve(request.result[0]); db.close(); };
      request.onerror = () => { reject(request.error); db.close(); };
    };
    open.onerror = () => reject(open.error);
  }));
}

async function disableSpeechOnReload(page: Page) {
  // This later route replaces only the next config response; the existing
  // fixture continues to reject any accidental real cloud/system playback.
  await page.route('**/api/config', async route => {
    const response = await route.fetch(); const config = await response.json();
    await route.fulfill({ json: { ...config, capabilities: { ...config.capabilities, tts: 'unconfigured' }, models: { ...config.models, tts: '' }, speech: { engine: 'none', ready: false, voice: '', style: '', instructionsSupported: false } } });
  });
  const calls: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/tts' || path === '/api/ask') calls.push(path);
  });
  await page.reload();
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.audio-kind')).toHaveText('朗读未启用');
  return calls;
}

test('关闭声音后恢复旧正文书签，继续按钮不请求语音且保留第二句位置', async ({ page }) => {
  await mockCloudSpeech(page); await sample(page);
  await page.getByRole('button', { name: '校对朗读文本', exact: true }).click();
  await page.getByRole('textbox', { name: '确认后的朗读文本' }).fill('第一句朗读用于保存位置。第二句在关闭声音后保持不动。');
  await page.getByRole('button', { name: '使用校对文本', exact: true }).click();
  await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停朗读', exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __speech: { finish(): void } }).__speech.finish());
  await expect(page.getByTestId('reading-subtitle')).toHaveText('第二句在关闭声音后保持不动。');
  await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
  await expect.poll(async () => (await savedRecord(page))?.readingBookmark?.cursor.sentenceIndex).toBe(1);
  const bookmark = (await savedRecord(page))!.readingBookmark;

  const calls = await disableSpeechOnReload(page);
  await expect(page.getByTestId('reading-subtitle')).toHaveText('第二句在关闭声音后保持不动。');
  await expect(page.getByRole('button', { name: '继续朗读', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '继续朗读', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('朗读未启用');
  await expect.poll(async () => (await savedRecord(page))?.readingBookmark).toEqual(bookmark);
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __speech: { texts: string[] } }).__speech.texts)).toEqual([]);
});

test('关闭声音后恢复课堂，手动与问答后自动续读均不发送隐式请求，文字问答仍可用', async ({ page }) => {
  await mockCloudSpeech(page); await sample(page);
  await page.getByRole('button', { name: '设置与用量', exact: true }).click();
  await page.getByRole('checkbox', { name: '文字问答完成后自动继续已中断的陪读（默认关闭）', exact: true }).check();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.locator('.classroom-controls summary').click();
  await page.getByRole('button', { name: '开始陪读', exact: true }).click();
  await expect(page.locator('.classroom-progress')).toContainText('正在读原文');
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __speech: { texts: string[] } }).__speech.texts.length)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.locator('.classroom-progress')).toContainText('已中断');
  await expect.poll(async () => (await savedRecord(page))?.teachingProgress?.phase).toBe('reading');
  const bookmark = (await savedRecord(page))!.readingBookmark;
  expect(bookmark).toBeTruthy();
  expect((await savedRecord(page))!.preferences.autoResume).toBe(true);

  const calls = await disableSpeechOnReload(page);
  await page.locator('.classroom-controls summary').click();
  await expect(page.locator('.classroom-progress')).toContainText('已中断');
  await page.getByRole('button', { name: '继续朗读', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('朗读未启用');
  await page.getByRole('button', { name: '继续陪读', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('朗读未启用');
  await expect(page.locator('.classroom-progress')).toContainText('已中断');
  await expect.poll(async () => (await savedRecord(page))?.readingBookmark).toEqual(bookmark);
  expect(calls).toEqual([]);

  await page.getByRole('textbox', { name: '输入文字问题' }).fill('关闭朗读后，仍请解释这段教材。');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  await expect(page.getByTestId('board-step').first()).toBeVisible();
  await expect(page.locator('.classroom-progress')).toContainText('已中断');
  await expect.poll(async () => (await savedRecord(page))?.readingBookmark).toEqual(bookmark);
  expect(calls).toEqual(['/api/ask']);
  expect(await page.evaluate(() => (window as unknown as { __speech: { texts: string[] } }).__speech.texts)).toEqual([]);
});
