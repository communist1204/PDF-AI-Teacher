import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { DesktopSettings, DesktopTeacherBridge } from '../../packages/shared/desktop';

type Probe = { elements: HTMLAudioElement[]; ended: number; maximum: number };
async function probe(page: Page) {
  return page.evaluate(() => {
    const value = (window as unknown as { __cosyAudio: Probe }).__cosyAudio;
    const audio = value.elements.at(-1);
    return { count: value.elements.length, ended: value.ended, maximum: value.maximum, active: value.elements.filter(item => !item.paused).length, rate: audio?.playbackRate, time: audio?.currentTime ?? 0, paused: audio?.paused, pitch: audio?.preservesPitch, duration: audio?.duration };
  });
}

/** Loopback HTTP really streams an explicitly synthetic MP3; no model is called. */
async function setup(page: Page, text = '这是一句测试正文。') {
  const mp3 = await readFile('tests/fixtures/cosy-stream.mp3');
  const pending: ServerResponse[] = [];
  const calls: Array<{ text: string; stream: boolean }> = [];
  let closed = 0; let finished = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4320');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'content-type,x-csrf-token,x-task-lane,x-audio-stream');
    response.setHeader('Access-Control-Expose-Headers', 'x-session-id,x-generation-id,x-context-revision,x-audio-streaming');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const stream = request.headers['x-audio-stream'] === '1';
    calls.push({ text: body.text, stream });
    response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'x-session-id': body.sessionId, 'x-generation-id': String(body.generationId), 'x-context-revision': String(body.contextRevision), ...(stream ? { 'x-audio-streaming': '1' } : {}) });
    if (!stream) { response.end(mp3); return; }
    response.on('close', () => { closed++; });
    response.on('finish', () => { finished++; });
    response.write(mp3.subarray(0, Math.floor(mp3.length / 2)));
    pending.push(response);
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  await page.addInitScript(url => {
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => nativeFetch(typeof input === 'string' && input === '/api/tts' ? url : input, init);
    const state: Probe = { elements: [], ended: 0, maximum: 0 };
    Object.defineProperty(window, '__cosyAudio', { value: state });
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) {
        super(src); state.elements.push(this);
        this.addEventListener('ended', () => { state.ended++; });
        this.addEventListener('playing', () => { state.maximum = Math.max(state.maximum, state.elements.filter(item => !item.paused).length); });
      }
    };
  }, `http://127.0.0.1:${address.port}/stream`);
  await page.route('**/api/config', async route => {
    const response = await route.fetch(); const config = await response.json();
    await route.fulfill({ json: { ...config, speech: { engine: 'cosy', ready: true, status: 'ready', streaming: true, device: 'cuda', voice: 'cosy_default', style: '合成测试数据', instructionsSupported: false } } });
  });
  await page.goto('/'); await page.getByRole('button', { name: /示例/ }).click();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => MediaSource.isTypeSupported('audio/mpeg'))).toBe(true);
  await page.getByRole('button', { name: '选本页文字', exact: true }).click();
  await page.getByRole('button', { name: '校对朗读文本', exact: true }).click();
  await page.getByRole('textbox', { name: '确认后的朗读文本', exact: true }).fill(text);
  await page.getByRole('button', { name: '使用校对文本', exact: true }).click();
  return {
    calls, get finished() { return finished; }, get closed() { return closed; },
    finish() { const response = pending.shift(); response?.end(mp3.subarray(Math.floor(mp3.length / 2))); },
    fail() { pending.shift()?.destroy(new Error('Deliberate fixture disconnect')); },
    async dispose() { for (const response of pending) response.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('Cosy 真 MSE 在 HTTP 尾段到达前开播，原位变速暂停续读，完整结束后才标记已读', async ({ page }) => {
  const stream = await setup(page);
  try {
    await page.getByRole('button', { name: '朗读所选', exact: true }).click();
    await expect.poll(async () => (await probe(page)).time).toBeGreaterThan(0.2);
    expect(stream.finished).toBe(0); expect(stream.calls).toEqual([{ text: '这是一句测试正文。', stream: true }]);
    await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
    const before = await probe(page); await page.getByRole('combobox', { name: '语速', exact: true }).selectOption('3');
    expect(await probe(page)).toMatchObject({ count: 1, rate: 3, pitch: true }); expect((await probe(page)).time).toBeGreaterThanOrEqual(before.time);
    await page.getByRole('button', { name: '暂停朗读', exact: true }).click(); const paused = await probe(page);
    await page.getByRole('combobox', { name: '语速', exact: true }).selectOption('0.25');
    expect(await probe(page)).toMatchObject({ count: 1, paused: true, rate: 0.25, time: paused.time });
    stream.finish(); await expect.poll(() => stream.finished).toBe(1);
    await expect(page.locator('.audio-source strong')).toContainText('已暂停');
    await page.getByRole('button', { name: '继续朗读', exact: true }).click();
    await expect.poll(async () => (await probe(page)).time).toBeGreaterThan(paused.time);
    await expect.poll(async () => Number.isFinite((await probe(page)).duration)).toBe(true);
    await page.evaluate(() => { const audio = (window as unknown as { __cosyAudio: Probe }).__cosyAudio.elements[0]; audio.currentTime = audio.duration - 0.03; });
    await expect(page.locator('.audio-source strong')).toContainText('待机');
    expect(await probe(page)).toMatchObject({ count: 1, ended: 1, maximum: 1, active: 0 });
    expect(stream.calls).toHaveLength(1);
    await page.screenshot({ path: 'test-results/cosy-stream-complete.png', fullPage: true });
  } finally { await stream.dispose(); }
});

test('流式朗读中停止会中止 HTTP，迟到尾段不复播且不确认读完', async ({ page }) => {
  const stream = await setup(page);
  try {
    await page.getByRole('button', { name: '朗读所选', exact: true }).click();
    await expect.poll(async () => (await probe(page)).time).toBeGreaterThan(0.2);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(() => stream.closed).toBe(1); stream.finish();
    await expect(page.locator('.audio-source strong')).toContainText('待机');
    expect(await probe(page)).toMatchObject({ active: 0, count: 1, ended: 0 });
    await expect(page.getByRole('button', { name: '继续朗读', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { await stream.dispose(); }
});

test('已开播后的连接断开提示失败并保留原句，不冒充正常结束', async ({ page }) => {
  const stream = await setup(page);
  try {
    await page.getByRole('button', { name: '朗读所选', exact: true }).click();
    await expect.poll(async () => (await probe(page)).time).toBeGreaterThan(0.2); stream.fail();
    await expect(page.getByRole('alert')).toContainText('流式朗读中断');
    expect(await probe(page)).toMatchObject({ active: 0, ended: 0 });
    await expect(page.getByRole('button', { name: '继续朗读', exact: true })).toBeEnabled();
    expect(stream.calls).toHaveLength(1);
  } finally { await stream.dispose(); }
});

test('下一句复用完整预取，上一句新流替换旧音源，无叠音', async ({ page }) => {
  const stream = await setup(page, '第一句用于流式播放。第二句用于预取复用。');
  try {
    await page.getByRole('button', { name: '朗读所选', exact: true }).click();
    await expect.poll(async () => (await probe(page)).time).toBeGreaterThan(0.2);
    await expect.poll(() => stream.calls.length).toBe(2); expect(stream.calls[1].stream).toBe(false);
    await page.getByRole('button', { name: '下一句', exact: true }).click();
    await expect.poll(async () => (await probe(page)).count).toBe(2);
    await expect(page.getByTestId('reading-subtitle')).toHaveText('第二句用于预取复用。'); expect(stream.calls).toHaveLength(2);
    await page.getByRole('button', { name: '上一句', exact: true }).click();
    await expect.poll(async () => (await probe(page)).count).toBe(3);
    await expect(page.getByTestId('reading-subtitle')).toHaveText('第一句用于流式播放。');
    expect((await probe(page)).maximum).toBe(1);
    await page.getByRole('button', { name: '停止', exact: true }).click(); expect((await probe(page)).active).toBe(0);
  } finally { await stream.dispose(); }
});

test('Cosy 设置无需 Key 或加密，保存不发声；运行状态如实更新', async ({ page }) => {
  await page.addInitScript(() => {
    const settings: DesktopSettings = { mode: 'demo', chatModel: 'test', visionModel: 'test', reasoningEffort: '', ttsEngine: 'none', ttsModel: '', ttsVoice: '', ttsInstructions: '', hasApiKey: false, encryptionAvailable: false, auth: { status: 'signed_out', accounts: [] }, models: [], restartRequired: false };
    const calls: unknown[] = []; Object.defineProperty(window, '__cosySaves', { value: calls });
    const bridge: DesktopTeacherBridge = { getSettings: async () => structuredClone(settings), saveSettings: async input => { calls.push(input); Object.assign(settings, input); return structuredClone(settings); }, restart: async () => {}, createShortcut: async () => ({ path: '' }), openAccountPage: async () => {}, login: async () => structuredClone(settings), cancelLogin: async () => {}, logout: async () => structuredClone(settings), selectAccount: async () => structuredClone(settings) };
    Object.defineProperty(window, 'desktopTeacher', { value: bridge });
  });
  let status = 'idle'; let requests = 0;
  await page.route('**/api/config', async route => { const response = await route.fetch(); const config = await response.json(); await route.fulfill({ json: { ...config, speech: { engine: 'cosy', ready: true, status, voice: 'cosy_default', style: '固定音色', instructionsSupported: false } } }); });
  await page.route('**/api/tts', route => { requests++; return route.abort(); });
  await page.goto('/'); await page.getByRole('button', { name: '声音设置', exact: true }).click();
  await page.getByRole('combobox', { name: '朗读方式', exact: true }).selectOption('cosy');
  await expect(page.locator('.desktop-cosy-fields')).toContainText('不需要 API Key');
  await expect(page.locator('.desktop-cosy-fields input')).toHaveCount(0);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __cosySaves: unknown[] }).__cosySaves)).toMatchObject([{ ttsEngine: 'cosy', mode: 'demo' }]);
  await expect(page.getByTestId('cosy-speech-status')).toContainText('首次朗读时加载');
  status = 'loading'; await expect(page.getByTestId('cosy-speech-status')).toContainText('正在加载本机模型');
  status = 'ready'; await expect(page.getByTestId('cosy-speech-status')).toContainText('模型已加载');
  expect(requests).toBe(0);
  await page.setViewportSize({ width: 1280, height: 720 }); await page.locator('.desktop-cosy-fields').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/cosy-settings-720.png', fullPage: true });
});
