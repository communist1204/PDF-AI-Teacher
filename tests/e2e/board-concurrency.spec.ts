import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { AskRequest, AskResponse } from '../../packages/shared/protocol';
import { mockSourceSpeech } from './realtimeHarness';

type AudioProbe = { elements: HTMLAudioElement[] };
type RequestLog = { asks: AskRequest[]; cancels: string[]; speechLanes: string[] };
const answer = '原截图中的等式展示了当前学习目标。';
const question = '解释这个截图中的等式。';

function responseFor(body: AskRequest): AskResponse {
  return {
    sessionId: body.sessionId, generationId: body.generationId, contextRevision: body.contextRevision, mode: 'live',
    plan: {
      schemaVersion: '1', contextRevision: body.contextRevision, answer, needsClarification: false, clarificationQuestion: null, checkQuestion: null,
      steps: [{ stepId: 'original-screenshot-step', title: '针对原截图的板书', explanationMarkdown: '这里只引用发问时选中的第一页。', speechText: '这是原截图的说明。', sourceIds: [body.context.sources[0].sourceId], exampleOrigin: 'none', boardBlocks: [{ id: 'original-equation', type: 'math', latex: 'x=1', label: '截图中的等式' }] }],
    },
    usage: { requestId: 'mock-board-concurrency', model: 'mock-vision', category: 'text', inputTokens: 10, outputTokens: 10, characters: null, estimatedCost: null, cancelled: false },
  };
}

async function pdfBytes(extra = '') {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([500, 600]).drawText('First page equation: x = 1.' + extra, { x: 45, y: 460, size: 17, font });
  const second = pdf.addPage([500, 600]);
  second.drawText('Reading on page two keeps speaking.', { x: 45, y: 460, size: 17, font });
  second.drawText('The next sentence is ready for reading.', { x: 45, y: 425, size: 17, font });
  return Buffer.from(await pdf.save());
}

async function setup(page: Page): Promise<RequestLog> {
  const log: RequestLog = { asks: [], cancels: [], speechLanes: [] };
  await page.addInitScript(() => {
    const probe: AudioProbe = { elements: [] }; Object.defineProperty(window, '__boardAudioProbe', { value: probe });
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); probe.elements.push(this); } };
  });
  await page.route('**/api/config', async route => {
    const response = await route.fetch(); const config = await response.json();
    await route.fulfill({ json: { ...config, mode: 'live', models: { ...config.models, chat: 'mock-chat', vision: 'mock-vision' }, speech: { engine: 'doubao', ready: true, voice: 'mock-voice', style: '仅模拟', instructionsSupported: true } } });
  });
  await mockSourceSpeech(page);
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/ask') log.asks.push(request.postDataJSON());
    if (path === '/api/cancel') log.cancels.push(request.headers()['x-task-lane'] ?? 'main');
    if (path === '/api/tts') log.speechLanes.push(request.headers()['x-task-lane'] ?? 'main');
  });
  await page.goto('/');
  await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles({ name: 'concurrency.pdf', mimeType: 'application/pdf', buffer: await pdfBytes() });
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.textLayer span').filter({ hasText: 'First page equation:' })).toBeVisible();
  return log;
}

async function selectScreenshot(page: Page) {
  await page.getByRole('button', { name: '框选区域', exact: true }).click();
  const text = page.locator('.textLayer span').filter({ hasText: 'First page equation:' }); await text.scrollIntoViewIfNeeded();
  const box = (await text.boundingBox())!;
  await page.mouse.move(box.x - 3, box.y - 3); await page.mouse.down();
  await page.mouse.move(box.x + box.width + 3, box.y + box.height + 3, { steps: 10 }); await page.mouse.up();
  const image = page.getByAltText('即将发送的公式截图', { exact: true }); await expect(image).toBeVisible();
  return (await image.getAttribute('src'))!;
}

async function sendQuestion(page: Page) {
  await page.getByRole('button', { name: '针对选区提问', exact: true }).click();
  await page.getByRole('textbox', { name: '本次选区问题', exact: true }).fill(question);
  await page.getByRole('button', { name: '发送选区问题', exact: true }).click();
  await expect(page.locator('.thinking')).toBeVisible();
}

async function selectNextPage(page: Page) {
  await page.getByRole('button', { name: '取消选中', exact: true }).click();
  await page.getByRole('button', { name: '切换为跟随当前页', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.textLayer span').filter({ hasText: 'Reading on page two' })).toBeVisible();
  await page.getByRole('button', { name: '选文字', exact: true }).click();
  await page.getByRole('button', { name: '选本页文字', exact: true }).click();
  await expect(page.locator('.selection-preview')).toContainText('Reading on page two');
}

async function audioSnapshot(page: Page) {
  return page.evaluate(() => {
    const elements = (window as unknown as { __boardAudioProbe: AudioProbe }).__boardAudioProbe.elements;
    const current = elements.at(-1);
    return current ? { count: elements.length, time: current.currentTime, paused: current.paused } : null;
  });
}

async function startReading(page: Page) {
  await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  await expect.poll(async () => (await audioSnapshot(page))?.time ?? 0).toBeGreaterThan(0.1);
  await expect(page.getByTestId('reading-subtitle')).toContainText('Reading on page two');
}

function mainCancels(log: RequestLog) { return log.cancels.filter(lane => lane !== 'speech').length; }

async function heldAnswer(page: Page) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let completed!: () => void;
  const finished = new Promise<void>(resolve => { completed = resolve; });
  await page.route('**/api/ask', async route => {
    const body = route.request().postDataJSON() as AskRequest;
    await held;
    await route.fulfill({ json: responseFor(body) }).catch(() => undefined);
    completed();
  });
  return { release, finished };
}

test('截图提问后清选区、跟页、换选段朗读仍完成原图板书，回复不抢当前音频（模拟接口）', async ({ page }) => {
  const log = await setup(page); const held = await heldAnswer(page); const image = await selectScreenshot(page);
  await sendQuestion(page); await expect.poll(() => log.asks.length).toBe(1);
  const original = structuredClone(log.asks[0]); const cancelledBefore = mainCancels(log);
  expect(original.context.imageDataUrl).toBe(image); expect(original.context.sources[0].pageIndex).toBe(0);
  await selectNextPage(page); await startReading(page);
  await expect(page.locator('.thinking')).toContainText('PDF 第 1 页');
  await expect(page.locator('.thinking')).toContainText(/已等待 \d+ 秒/u);
  await page.screenshot({ path: 'test-results/board-concurrent-pending.png', fullPage: true });
  await expect(page.getByRole('button', { name: '取消解答', exact: true })).toBeVisible();
  expect(mainCancels(log)).toBe(cancelledBefore);
  expect(log.speechLanes.length).toBeGreaterThan(0); expect(log.speechLanes.every(lane => lane === 'speech')).toBe(true);
  const playing = (await audioSnapshot(page))!;
  held.release(); await held.finished;
  await expect(page.getByTestId('board-step')).toHaveCount(1);
  await expect(page.getByTestId('board-step')).toContainText('针对原截图的板书');
  await expect(page.getByTestId('board-step').getByRole('button', { name: /原文 · PDF 1 页/u })).toBeVisible();
  await expect(page.locator('.message.assistant')).toContainText(answer);
  await expect(page.locator('.thinking')).toHaveCount(0);
  await expect(page.locator('.selection-preview')).toContainText('Reading on page two');
  await expect(page.getByRole('spinbutton', { name: 'PDF 页序号', exact: true })).toHaveValue('2');
  await expect.poll(async () => (await audioSnapshot(page))?.time ?? 0).toBeGreaterThan(playing.time);
  expect(await audioSnapshot(page)).toMatchObject({ count: playing.count, paused: false });
  expect(log.asks).toHaveLength(1); expect(log.asks[0]).toEqual(original); expect(mainCancels(log)).toBe(cancelledBefore);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: 'test-results/board-concurrent-reading-720.png', fullPage: true });
});

test('思考中编辑草稿不取消，显式取消解答保留当前朗读并拒绝迟到板书（模拟接口）', async ({ page }) => {
  const log = await setup(page); const held = await heldAnswer(page); await selectScreenshot(page); await sendQuestion(page);
  await expect.poll(() => log.asks.length).toBe(1); const before = mainCancels(log);
  await page.getByRole('textbox', { name: '输入文字问题', exact: true }).fill('下一次我想问另一段。');
  await expect(page.locator('.thinking')).toBeVisible(); expect(mainCancels(log)).toBe(before);
  await selectNextPage(page); await startReading(page); const playing = (await audioSnapshot(page))!;
  await page.getByRole('button', { name: '取消解答', exact: true }).click();
  await expect(page.locator('.thinking')).toHaveCount(0);
  await expect.poll(() => mainCancels(log)).toBeGreaterThan(before);
  held.release(); await held.finished;
  await expect(page.getByTestId('board-step')).toHaveCount(0);
  await expect(page.locator('.message.assistant').filter({ hasText: answer })).toHaveCount(0);
  await expect.poll(async () => (await audioSnapshot(page))?.time ?? 0).toBeGreaterThan(playing.time);
  expect(await audioSnapshot(page)).toMatchObject({ count: playing.count, paused: false });
  await expect(page.getByTestId('reading-subtitle')).toContainText('Reading on page two');
});

test('失败附在本次问题下，重试仍发送原问题和原截图，不换成当前阅读选区（模拟接口）', async ({ page }) => {
  const log = await setup(page); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); let attempts = 0;
  await page.route('**/api/ask', async route => {
    const body = route.request().postDataJSON() as AskRequest;
    if (++attempts === 1) { await held; await route.fulfill({ status: 502, json: { error: 'invalid_model_output', message: '模型未返回可验证的教案，请手动重试。' } }); }
    else await route.fulfill({ json: responseFor(body) });
  });
  await selectScreenshot(page); await sendQuestion(page); await expect.poll(() => log.asks.length).toBe(1);
  const original = structuredClone(log.asks[0]);
  await selectNextPage(page); release();
  await expect(page.getByRole('button', { name: '重试这次提问', exact: true })).toBeVisible();
  await expect(page.locator('.message.assistant')).toContainText('模型未返回可验证的教案');
  await expect(page.getByTestId('board-step')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/board-question-retry.png', fullPage: true });
  await page.getByRole('button', { name: '重试这次提问', exact: true }).click();
  await expect(page.getByTestId('board-step')).toHaveCount(1);
  expect(log.asks).toHaveLength(2); expect(log.asks[1].question).toBe(original.question); expect(log.asks[1].context).toEqual(original.context);
  await expect(page.getByTestId('board-step').getByRole('button', { name: /原文 · PDF 1 页/u })).toBeVisible();
  await expect(page.locator('.selection-preview')).toContainText('Reading on page two');
});

test('后台提问时听已有讲解、停止再继续只操作声音，不取消新问题（模拟接口）', async ({ page }) => {
  const log = await setup(page);
  await page.route('**/api/ask', route => route.fulfill({ json: responseFor(route.request().postDataJSON()) }));
  await selectScreenshot(page);
  await page.getByRole('textbox', { name: '输入文字问题', exact: true }).fill(question);
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.getByTestId('board-step')).toHaveCount(1);
  const held = await heldAnswer(page); await sendQuestion(page);
  await expect.poll(() => log.asks.length).toBe(2); const before = mainCancels(log);
  await page.getByRole('button', { name: '听这次讲解', exact: true }).click();
  await expect.poll(async () => (await audioSnapshot(page))?.time ?? 0).toBeGreaterThan(0.1);
  await expect(page.locator('.thinking')).toBeVisible(); expect(mainCancels(log)).toBe(before);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect.poll(async () => (await audioSnapshot(page))?.paused).toBe(true);
  await page.getByRole('button', { name: '继续朗读', exact: true }).click();
  await expect.poll(async () => (await audioSnapshot(page))?.time ?? 0).toBeGreaterThan(0.1);
  await expect(page.locator('.thinking')).toBeVisible(); expect(mainCancels(log)).toBe(before);
  held.release(); await held.finished;
  await expect(page.getByTestId('board-step')).toHaveCount(2);
  expect(mainCancels(log)).toBe(before);
});

test('结构校验降级提示作为失败显示且可重试，不登记成成功回答（模拟接口）', async ({ page }) => {
  await setup(page);
  await page.route('**/api/ask', route => route.fulfill({ json: { ...responseFor(route.request().postDataJSON()), warning: 'invalid_model_output' } }));
  await selectScreenshot(page);
  await page.getByRole('textbox', { name: '输入文字问题', exact: true }).fill(question);
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试这次提问', exact: true })).toBeVisible();
  await expect(page.locator('.question-task-failed')).toContainText('未通过结构或来源校验');
  await expect(page.getByTestId('board-step')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '听这次讲解', exact: true })).toHaveCount(0);
});

test('读并讲被文字问题打断后，底部续读只恢复原文，不重新生成或取消后台问题（模拟接口）', async ({ page }) => {
  const log = await setup(page); const held = await heldAnswer(page);
  await selectScreenshot(page); await selectNextPage(page);
  await page.getByRole('button', { name: '读并讲', exact: true }).click();
  await expect.poll(async () => (await audioSnapshot(page))?.time ?? 0).toBeGreaterThan(0.1);
  await page.getByRole('textbox', { name: '输入文字问题', exact: true }).fill('先解释这一段。');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect.poll(() => log.asks.length).toBe(1); const before = mainCancels(log);
  await page.getByRole('button', { name: '继续朗读', exact: true }).click();
  await expect.poll(async () => (await audioSnapshot(page))?.time ?? 0).toBeGreaterThan(0.1);
  await expect(page.locator('.thinking')).toBeVisible(); expect(mainCancels(log)).toBe(before); expect(log.asks).toHaveLength(1);
  held.release(); await held.finished;
  await expect(page.getByTestId('board-step')).toHaveCount(1); expect(mainCancels(log)).toBe(before);
});

test('换书会停止朗读并取消旧问题，迟到结果不会进入新书（模拟接口）', async ({ page }) => {
  const log = await setup(page); const held = await heldAnswer(page); await selectScreenshot(page); await sendQuestion(page);
  await expect.poll(() => log.asks.length).toBe(1); const before = mainCancels(log);
  await selectNextPage(page); await startReading(page);
  await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles({ name: 'concurrency.pdf', mimeType: 'application/pdf', buffer: await pdfBytes(' Different book.') });
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.textLayer span').filter({ hasText: 'Different book.' })).toBeVisible();
  await expect(page.locator('.thinking')).toHaveCount(0); await expect.poll(() => mainCancels(log)).toBeGreaterThan(before);
  held.release(); await held.finished;
  await expect(page.getByTestId('board-step')).toHaveCount(0); await expect(page.locator('.message')).toHaveCount(0);
  await expect.poll(async () => (await audioSnapshot(page))?.paused).toBe(true);
});
