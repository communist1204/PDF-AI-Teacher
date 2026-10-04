import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { DesktopSettings, DesktopTeacherBridge } from '../../packages/shared/desktop';
import type { AskRequest, AskResponse } from '../../packages/shared/protocol';
import { COSY_TTS_VOICE_IDS } from '../../packages/shared/cosySpeech';
import { COSY_AUDITION_TEXT } from '../../apps/web/src/features/voice/CosyVoiceAudition';

type Probe = { audio: HTMLAudioElement[]; maximum: number; saved: unknown[] };
async function probe(page: Page) { return page.evaluate(() => { const p = (window as unknown as { __voiceProbe: Probe }).__voiceProbe; return { count: p.audio.length, active: p.audio.filter(item => !item.paused).length, maximum: p.maximum, time: p.audio.at(-1)?.currentTime ?? 0, saved: p.saved }; }); }

/** An actual incremental MP3 response exercises Edge MSE. Its synthetic tone is not a voice quality test. */
async function setup(page: Page, engine = 'cosy') {
  const mp3 = await readFile('tests/fixtures/cosy-stream.mp3');
  const requests: Array<{ text: string; cosyVoice?: string; lane?: string }> = [];
  const pending: ServerResponse[] = [];
  let closed = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4320'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'content-type,x-csrf-token,x-task-lane,x-audio-stream'); res.setHeader('Access-Control-Expose-Headers', 'x-session-id,x-generation-id,x-context-revision,x-audio-streaming');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ text: body.text, cosyVoice: body.cosyVoice, lane: req.headers['x-task-lane'] as string });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'x-session-id': body.sessionId, 'x-generation-id': String(body.generationId), 'x-context-revision': String(body.contextRevision), 'x-audio-streaming': '1' });
    res.on('close', () => { closed++; }); res.write(mp3.subarray(0, Math.floor(mp3.length / 2))); pending.push(res);
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port');
  await page.addInitScript(({ url, engine }) => {
    const originalFetch = window.fetch;
    window.fetch = (input, init) => originalFetch(typeof input === 'string' && input === '/api/tts' ? url : input, init);
    const p: Probe = { audio: [], maximum: 0, saved: [] }; Object.defineProperty(window, '__voiceProbe', { value: p });
    const OriginalAudio = window.Audio;
    window.Audio = class extends OriginalAudio { constructor(src?: string) { super(src); p.audio.push(this); this.addEventListener('playing', () => { p.maximum = Math.max(p.maximum, p.audio.filter(item => !item.paused).length); }); } };
    const defaults: DesktopSettings = { mode: 'demo', chatModel: 'unchanged-chat', visionModel: 'unchanged-vision', reasoningEffort: 'high', ttsEngine: engine as DesktopSettings['ttsEngine'], cosyTtsVoice: 'local_longanyang', ttsModel: 'unchanged-cloud-model', ttsVoice: 'marin', ttsInstructions: '保留在线偏好', hasApiKey: false, encryptionAvailable: true, auth: { status: 'signed_out', accounts: [] }, models: [], restartRequired: false };
    const settings: DesktopSettings = JSON.parse(localStorage.getItem('test-only-cosy-settings') ?? 'null') ?? defaults;
    const bridge: DesktopTeacherBridge = { getSettings: async () => structuredClone(settings), saveSettings: async input => { p.saved.push(input); Object.assign(settings, input, { restartRequired: true }); localStorage.setItem('test-only-cosy-settings', JSON.stringify(settings)); return structuredClone(settings); }, restart: async () => {}, createShortcut: async () => ({ path: '' }), openAccountPage: async () => {}, login: async () => structuredClone(settings), cancelLogin: async () => {}, logout: async () => structuredClone(settings), selectAccount: async () => structuredClone(settings) };
    Object.defineProperty(window, 'desktopTeacher', { value: bridge });
  }, { url: `http://127.0.0.1:${address.port}/tts`, engine });
  await page.route('**/api/config', async route => { const response = await route.fetch(); const config = await response.json(); await route.fulfill({ json: { ...config, speech: { engine, ready: true, voice: 'local_longanyang', style: '测试配置', instructionsSupported: false, status: 'ready' } } }); });
  await page.goto('/');
  return { requests, get closed() { return closed; }, async dispose() { for (const item of pending) item.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function settings(page: Page) { await page.getByRole('button', { name: '声音设置', exact: true }).click(); await expect(page.getByRole('combobox', { name: '朗读方式', exact: true })).toBeVisible(); }
async function selectProse(page: Page) {
  await page.getByRole('button', { name: /示例/ }).click(); await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '选本页文字', exact: true }).click(); await page.getByRole('button', { name: '校对朗读文本', exact: true }).click();
  await page.getByRole('textbox', { name: '确认后的朗读文本', exact: true }).fill('保留这句原文的阅读位置。'); await page.getByRole('button', { name: '使用校对文本', exact: true }).click();
}

test('仅六种本地参考音色可选，选择保存不发声，偏好重开仍在且不改变专业解题设置', async ({ page }) => {
  const h = await setup(page);
  try {
    await settings(page); const voice = page.getByRole('combobox', { name: 'CosyVoice 中文音色', exact: true });
    expect(await voice.locator('option').evaluateAll(items => items.map(item => (item as HTMLOptionElement).value))).toEqual([...COSY_TTS_VOICE_IDS]);
    expect([...COSY_TTS_VOICE_IDS]).toEqual(['local_longanyang','local_longanhuan_v3','local_longfei_v3','local_longxiaochun_v3','local_longxiaoxia_v3','local_longanyun_v3']);
    expect(await page.getByRole('combobox', { name: '朗读方式', exact: true }).locator('option').evaluateAll(items => items.map(item => (item as HTMLOptionElement).value))).toEqual(['none','cosy','doubao']);
    await expect(page.locator('.desktop-cosy-fields')).toContainText('不等同于官方云端原版');
    await expect(page.locator('.cosy-audition-card')).toContainText('本机生成');
    await expect(page.locator('.cosy-audition-card')).toContainText('二零二六年');
    await expect(page.locator('.desktop-cosy-fields input')).toHaveCount(0);
    for (const value of COSY_TTS_VOICE_IDS) { await voice.selectOption(value); await expect(page.locator('.cosy-reference-id')).toContainText(value.replace('local_', '')); }
    expect(h.requests).toHaveLength(0); expect((await probe(page)).count).toBe(0);
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    expect((await probe(page)).saved).toMatchObject([{ cosyTtsVoice: 'local_longanyun_v3', mode: 'demo', chatModel: 'unchanged-chat', visionModel: 'unchanged-vision', ttsVoice: 'marin', ttsInstructions: '保留在线偏好' }]);
    await page.reload(); await settings(page); await expect(voice).toHaveValue('local_longanyun_v3'); expect(h.requests).toHaveLength(0);
    await page.setViewportSize({ width: 1280, height: 720 }); await page.locator('.cosy-audition-card').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/local-reference-settings-720.png', fullPage: true });
    await expect(page.getByRole('button', { name: '试听这个音色', exact: true })).toBeInViewport({ ratio: 1 });
  } finally { await h.dispose(); }
});

test('未应用本机引擎时禁止试听，不误用在线TTS或自动生成', async ({ page }) => {
  const h = await setup(page, 'doubao');
  try {
    await settings(page); await page.getByRole('combobox', { name: '朗读方式', exact: true }).selectOption('cosy');
    await page.getByRole('combobox', { name: 'CosyVoice 中文音色', exact: true }).selectOption('local_longfei_v3');
    await expect(page.getByRole('button', { name: '试听这个音色', exact: true })).toBeDisabled();
    await expect(page.locator('.cosy-audition-card')).toContainText('不会调用在线声音');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '试听这个音色', exact: true })).toBeDisabled(); expect(h.requests).toHaveLength(0);
  } finally { await h.dispose(); }
});

test('同文音色试听使用真实MSE；换音色和关闭即停，晚到内容不复播，原文可继续', async ({ page }) => {
  const h = await setup(page);
  try {
    await selectProse(page); await page.getByRole('button', { name: '朗读所选', exact: true }).click(); await expect.poll(async () => (await probe(page)).time).toBeGreaterThan(0.1);
    await settings(page); const voice = page.getByRole('combobox', { name: 'CosyVoice 中文音色', exact: true });
    await voice.selectOption('local_longanhuan_v3'); expect(h.requests).toHaveLength(1);
    await page.getByRole('button', { name: '试听这个音色', exact: true }).click(); await expect.poll(async () => (await probe(page)).count).toBe(2); await expect.poll(async () => (await probe(page)).time).toBeGreaterThan(0.1);
    expect(h.requests[1]).toEqual({ text: COSY_AUDITION_TEXT, cosyVoice: 'local_longanhuan_v3', lane: 'speech' });
    await expect(page.locator('.cosy-audition-status')).toContainText('正在试听');
    await voice.selectOption('local_longxiaoxia_v3'); await expect.poll(async () => (await probe(page)).active).toBe(0); expect(h.requests).toHaveLength(2);
    await page.getByRole('button', { name: '试听这个音色', exact: true }).click(); await expect.poll(async () => (await probe(page)).count).toBe(3); await expect.poll(async () => (await probe(page)).time).toBeGreaterThan(0.1);
    expect(h.requests[2].cosyVoice).toBe('local_longxiaoxia_v3');
    await page.getByRole('button', { name: '关闭设置', exact: true }).click(); await expect.poll(async () => (await probe(page)).active).toBe(0); await expect.poll(() => h.closed).toBe(3);
    await expect(page.getByRole('button', { name: '继续朗读', exact: true })).toBeEnabled(); await page.getByRole('button', { name: '继续朗读', exact: true }).click();
    await expect.poll(async () => (await probe(page)).count).toBe(4); await expect.poll(async () => (await probe(page)).time).toBeGreaterThan(0.1);
    expect(h.requests[3]).toEqual({ text: '保留这句原文的阅读位置。', cosyVoice: undefined, lane: 'speech' });
    expect((await probe(page)).maximum).toBe(1); await page.getByRole('button', { name: '停止', exact: true }).click();
  } finally { await h.dispose(); }
});

test('准备中停止试听或关闭不产生迟到音频，可重新明确试听', async ({ page }) => {
  const h = await setup(page); let release!: () => void; let requested = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/tts', async route => { requested = true; await held; await route.continue().catch(() => {}); });
  try {
    await settings(page); await page.getByRole('button', { name: '试听这个音色', exact: true }).click(); await expect.poll(() => requested).toBe(true);
    await expect(page.locator('.cosy-audition-status')).toContainText('正在准备'); await page.getByRole('button', { name: '停止试听', exact: true }).click(); release();
    await expect(page.locator('.cosy-audition-status')).toContainText('点击才会发声'); expect((await probe(page)).count).toBe(0);
    await page.unroute('**/tts'); await page.getByRole('button', { name: '试听这个音色', exact: true }).click(); await expect.poll(async () => (await probe(page)).time).toBeGreaterThan(0.1);
    await page.getByRole('button', { name: '停止试听', exact: true }).click(); await expect.poll(async () => (await probe(page)).active).toBe(0);
  } finally { release(); await h.dispose(); }
});

test('试听不取消正在思考的问题，原问题仍能完成板书', async ({ page }) => {
  const h = await setup(page); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); let question: AskRequest | undefined; let mainCancels = 0;
  page.on('request', request => { if (request.url().endsWith('/api/cancel') && request.headers()['x-task-lane'] !== 'speech') mainCancels++; });
  await page.route('**/api/ask', async route => {
    const body = route.request().postDataJSON() as AskRequest; question = body; await held;
    const response: AskResponse = { ...body, mode: 'live', plan: { schemaVersion: '1', contextRevision: body.contextRevision, answer: '试听时仍完成原问题。', needsClarification: false, clarificationQuestion: null, checkQuestion: null, steps: [{ stepId: 'answer-step', title: '原问题的板书', explanationMarkdown: '原始上下文得到保留。', speechText: '这是原问题的解答。', sourceIds: [body.context.sources[0].sourceId], exampleOrigin: 'none', boardBlocks: [{ id: 'answer-text', type: 'text', markdown: '原问题的回答。' }] }] }, usage: { requestId: 'mock-audition-question', model: 'mock', category: 'text', inputTokens: 1, outputTokens: 1, characters: null, estimatedCost: null, cancelled: false } };
    await route.fulfill({ json: response });
  });
  try {
    await selectProse(page); await page.getByRole('button', { name: '针对选区提问', exact: true }).click(); await page.getByRole('textbox', { name: '本次选区问题', exact: true }).fill('解释这段原文'); await page.getByRole('button', { name: '发送选区问题', exact: true }).click();
    await expect.poll(() => !!question).toBe(true); const before = mainCancels;
    await settings(page); await page.getByRole('button', { name: '试听这个音色', exact: true }).click(); await expect.poll(async () => (await probe(page)).time).toBeGreaterThan(0.1);
    expect(mainCancels).toBe(before); release(); await expect(page.getByTestId('board-step')).toHaveCount(1); expect(mainCancels).toBe(before);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click(); await expect(page.getByTestId('board-step')).toContainText('原问题的板书'); await expect(page.locator('.message.assistant')).toContainText('试听时仍完成原问题');
  } finally { release(); await h.dispose(); }
});
