import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mockSourceSpeech } from './realtimeHarness';

const speechText = 'h 的零次方，等于 x。这是输入。';
const usage = { requestId: 'mock-reading-assist', model: 'mock-vision', category: 'text', inputTokens: 20, outputTokens: 20, characters: null, estimatedCost: null, cancelled: false };
async function setup(page: Page) {
  await page.route('**/api/config', async route => {
    const response = await route.fetch(); const config = await response.json();
    await route.fulfill({ json: { ...config, mode: 'live', models: { ...config.models, chat: 'mock-chat', vision: 'mock-vision' }, speech: { engine: 'doubao', ready: true, voice: 'mock-voice', style: 'mock only', instructionsSupported: true } } });
  });
  await mockSourceSpeech(page);
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([500, 600]).drawText('Formula: \\unsupported{x}', { x: 50, y: 450, size: 18, font });
  await page.goto('/'); await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles({ name: 'formula.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: '选本页文字', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '选本页文字', exact: true }).click();
}

test('只有主动点击 AI 才请求选区截图并生成中文，随后一键朗读', async ({ page }) => {
  const requests: Array<{ context: { sources: { sourceText: string }[]; imageDataUrl: string }; sessionId: string; generationId: number; contextRevision: number }> = [];
  const spoken: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/tts') spoken.push(request.postDataJSON().text); });
  await page.route('**/api/reading-assist', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    await route.fulfill({ json: { sessionId: body.sessionId, generationId: body.generationId, contextRevision: body.contextRevision, readingText: speechText, uncertain: false, warnings: [], usage } });
  });
  await setup(page); await page.getByRole('button', { name: '校对朗读文本', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '校对朗读文本', exact: true });
  await expect(dialog).toBeVisible(); expect(requests).toHaveLength(0);
  await expect(dialog.getByRole('textbox', { name: '确认后的朗读文本' })).toHaveValue(/unsupported/u);
  await dialog.getByRole('button', { name: 'AI 自动识别读法', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '确认后的朗读文本' })).toHaveValue(speechText);
  expect(requests).toHaveLength(1); expect(requests[0].context.sources).toHaveLength(1);
  expect(requests[0].context.sources[0].sourceText).toContain('unsupported');
  expect(requests[0].context.imageDataUrl).toMatch(/^data:image\/png;base64,/u);
  expect(Object.keys(requests[0]).sort()).toEqual(['context', 'contextRevision', 'generationId', 'sessionId']);
  expect(spoken).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.getByRole('button', { name: '使用并朗读', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/reading-assist-preview-720.png', fullPage: true });
  await dialog.getByRole('button', { name: '使用并朗读', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect.poll(() => spoken.length).toBeGreaterThan(0);
  expect(spoken[0]).not.toContain('unsupported'); expect(spoken[0]).toContain('等于');
  await expect(page.locator('.selection-preview')).toContainText('unsupported');
  await expect(page.getByTestId('reading-subtitle')).toContainText('h 的零次方');
});

test('模型不确定时保留说明并阻止直接采用朗读，不伪装识别成功', async ({ page }) => {
  await page.route('**/api/reading-assist', async route => {
    const body = route.request().postDataJSON();
    await route.fulfill({ json: { sessionId: body.sessionId, generationId: body.generationId, contextRevision: body.contextRevision, readingText: '这一处下标看不清。', uncertain: true, warnings: ['无法确定下标'], usage } });
  });
  await setup(page); await page.getByRole('button', { name: '校对朗读文本', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '校对朗读文本', exact: true });
  await dialog.getByRole('button', { name: 'AI 自动识别读法', exact: true }).click();
  await expect(dialog).toContainText('无法确定下标');
  await expect(dialog.getByRole('button', { name: '使用并朗读', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '使用校对文本', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭朗读校对', exact: true }).click();
  await expect(page.getByTestId('reading-subtitle')).toContainText('选择原文');
});

test('关闭主动发起的识别会取消请求，迟到结果不替换选区或启动语音', async ({ page }) => {
  let release: (() => void) | undefined; let started = false; let speeches = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/tts') speeches++; });
  await page.route('**/api/reading-assist', async route => {
    const body = route.request().postDataJSON(); started = true;
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { sessionId: body.sessionId, generationId: body.generationId, contextRevision: body.contextRevision, readingText: speechText, uncertain: false, warnings: [], usage } }).catch(() => undefined);
  });
  await setup(page); await page.getByRole('button', { name: '校对朗读文本', exact: true }).click();
  await page.getByRole('button', { name: 'AI 自动识别读法', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page.getByRole('button', { name: '关闭朗读校对', exact: true }).click(); release?.();
  await expect(page.getByRole('dialog', { name: '校对朗读文本' })).toHaveCount(0);
  await page.getByRole('button', { name: '取消选中', exact: true }).click();
  await expect(page.locator('.selection-preview')).not.toContainText(speechText); expect(speeches).toBe(0);
});


test('纯图片默认朗读给出明确提示，主动识别后可朗读且重开不重复识别', async ({ page }) => {
  let requests = 0;
  let received: { context: { sources: { sourceText: string }[]; imageDataUrl: string } } | undefined;
  await page.route('**/api/reading-assist', async route => {
    const body = route.request().postDataJSON(); received = body; requests++;
    await route.fulfill({ json: { sessionId: body.sessionId, generationId: body.generationId, contextRevision: body.contextRevision, readingText: speechText, uncertain: false, warnings: [], usage } });
  });
  await setup(page); await page.getByRole('button', { name: '框选区域', exact: true }).click();
  const text = page.locator('.textLayer span').filter({ hasText: 'Formula:' }).first(); await text.scrollIntoViewIfNeeded();
  const box = (await text.boundingBox())!;
  await page.mouse.move(box.x - 3, box.y - 3); await page.mouse.down();
  await page.mouse.move(box.x + box.width + 3, box.y + box.height + 3, { steps: 10 }); await page.mouse.up();
  await expect(page.getByRole('img', { name: '即将发送的公式截图', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '朗读所选', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '校对朗读文本', exact: true })).toHaveCount(0);
  await expect(page.locator('.error-banner')).toContainText('没有可直接朗读的文字'); expect(requests).toBe(0);
  await page.getByRole('button', { name: '校对朗读文本', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '校对朗读文本', exact: true });
  await expect(dialog).toContainText('当前选区只有图片'); expect(requests).toBe(0);
  await dialog.getByRole('button', { name: 'AI 自动识别读法', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '确认后的朗读文本' })).toHaveValue(speechText);
  expect(received?.context.sources[0].sourceText).toBe(''); expect(received?.context.imageDataUrl).toMatch(/^data:image\/png;base64,/u);
  await dialog.getByRole('button', { name: '使用并朗读', exact: true }).click();
  await expect(page.getByTestId('reading-subtitle')).toContainText('h 的零次方');
  await expect(page.getByRole('button', { name: '读并讲', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '校对朗读文本', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '确认后的朗读文本' })).toHaveValue(speechText);
  await expect(dialog.getByRole('button', { name: 'AI 自动识别读法', exact: true })).toBeEnabled();
  expect(requests).toBe(1);
});
