import { expect, test, type Page } from '@playwright/test';
import { mockSourceSpeech } from './realtimeHarness';

type Probe = { audio: HTMLAudioElement[] };
const formula = String.raw`式子为 $\frac{1}{1-\beta^t}$。`;
const corrected = formula + '第二句。';
async function setup(page: Page) {
  await page.addInitScript(() => {
    const probe: Probe = { audio: [] }; Object.defineProperty(window, '__mathReading', { value: probe });
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); probe.audio.push(this); } };
  });
  await page.route('**/api/config', async route => {
    const response = await route.fetch(); const config = await response.json();
    await route.fulfill({ json: { ...config, mode: 'demo', models: { ...config.models, tts: 'Doubao-Seed-TTS-2.0' }, capabilities: { ...config.capabilities, tts: 'untested' }, speech: { engine: 'doubao', ready: true, voice: 'zh_female_xiaohe_uranus_bigtts', style: '模拟豆包配置', instructionsSupported: true } } });
  });
  const speech: Array<{ text: string; speed: number }> = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/tts') speech.push(request.postDataJSON()); });
  await mockSourceSpeech(page); await page.goto('/');
  await page.getByRole('button', { name: /示例/ }).click(); await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  const span = page.locator('.textLayer span').filter({ hasText: '指数移动平均将过去' }).first();
  await expect(span).toBeVisible(); const box = (await span.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 }); await page.mouse.up();
  await expect(page.locator('.selection-preview')).toContainText('指数移动平均');
  return speech;
}
async function audioState(page: Page) {
  return page.evaluate(() => {
    const all = (window as unknown as { __mathReading: Probe }).__mathReading.audio; const audio = all.at(-1);
    return audio ? { count: all.length, playing: all.filter(item => !item.paused && !item.ended).length, rate: audio.playbackRate, time: audio.currentTime, paused: audio.paused, pitch: audio.preservesPitch } : null;
  });
}
async function openCorrection(page: Page) {
  await page.getByRole('button', { name: '校对朗读文本', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '校对朗读文本', exact: true }); await expect(dialog).toBeVisible();
  return { dialog, input: dialog.getByRole('textbox', { name: '确认后的朗读文本', exact: true }), preview: dialog.getByTestId('speech-preview'), save: dialog.getByRole('button', { name: '使用校对文本', exact: true }) };
}

test('真实 PDF 校对分式后保留原文字幕，豆包模拟播放原位调速且不会预取下一句', async ({ page }) => {
  const speech = await setup(page);
  await page.getByRole('textbox', { name: '输入文字问题', exact: true }).fill('解释这一段的符号。');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.locator('.message.assistant')).toContainText('演示讲解'); expect(speech).toEqual([]);
  const correction = await openCorrection(page); await correction.input.fill(corrected);
  await expect(correction.preview).toContainText('分子为一');
  await expect(correction.preview).toContainText('分母为一 减 贝塔 的 t 次方');
  await expect(correction.preview).toContainText('分数结束');
  const spokenPreview = (await correction.preview.textContent())!;
  expect(spokenPreview).not.toMatch(/\\[A-Za-z]+|[$^{}_]/u);
  expect(spokenPreview.split('\n')).toHaveLength(2); await expect(correction.save).toBeEnabled();
  await page.setViewportSize({ width: 1280, height: 720 });
  await correction.preview.scrollIntoViewIfNeeded(); await expect(correction.preview).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: 'test-results/math-reading-preview-720.png', fullPage: true });
  await correction.save.click(); await expect(correction.dialog).toHaveCount(0);
  await expect(page.locator('.selection-preview')).toContainText('指数移动平均'); // Correction does not rewrite PDF extraction.
  await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  const subtitle = page.getByTestId('reading-subtitle'); await expect(subtitle).toHaveText(formula);
  await expect.poll(async () => (await audioState(page))?.time ?? 0).toBeGreaterThan(0.5);
  expect(speech).toHaveLength(1); expect(speech[0].text).toBe(spokenPreview.split('\n')[0]);
  expect(speech[0].text).not.toMatch(/\\[A-Za-z]+|[$^{}_]/u);
  const before = (await audioState(page))!; const rate = page.getByRole('combobox', { name: '语速', exact: true });
  await rate.selectOption('3'); await expect.poll(async () => (await audioState(page))?.rate).toBe(3);
  expect(await audioState(page)).toMatchObject({ count: 1, playing: 1, pitch: true });
  expect((await audioState(page))!.time).toBeGreaterThanOrEqual(before.time); expect(speech).toHaveLength(1);
  await page.getByRole('button', { name: '暂停朗读', exact: true }).click(); const paused = (await audioState(page))!;
  await rate.selectOption('0.25'); expect(await audioState(page)).toMatchObject({ count: 1, playing: 0, paused: true, time: paused.time });
  await page.getByRole('button', { name: '继续朗读', exact: true }).click();
  await expect.poll(async () => (await audioState(page))?.time ?? 0).toBeGreaterThan(paused.time); expect(speech).toHaveLength(1);
  const next = page.getByRole('button', { name: '下一句', exact: true }); const previous = page.getByRole('button', { name: '上一句', exact: true });
  await expect(next).toBeVisible(); await expect(next).toContainText('下一句'); await expect(previous).toBeVisible(); await expect(previous).toContainText('上一句');
  await next.click(); await expect(subtitle).toHaveText('第二句。');
  await expect.poll(async () => (await audioState(page))?.playing).toBe(1); expect(speech.map(value => value.text)).toEqual([spokenPreview.split('\n')[0], '第二句。']);
  await previous.click(); await expect(subtitle).toHaveText(formula); await expect.poll(() => speech.length).toBe(3);
  await expect.poll(async () => (await audioState(page))?.playing).toBe(1);
  expect(speech[2].text).toBe(spokenPreview.split('\n')[0]);
  await page.screenshot({ path: 'test-results/math-reading-playback-720.png', fullPage: true });
  await page.getByRole('button', { name: '停止', exact: true }).click(); await expect.poll(async () => (await audioState(page))?.playing).toBe(0);
});

test('未知公式命令不能保存或发送给 TTS，改成中文读法后恢复朗读', async ({ page }) => {
  const speech = await setup(page); const correction = await openCorrection(page);
  await correction.input.fill(String.raw`式子为 $\unknown{x}$。第二句。`);
  await expect(correction.save).toBeDisabled(); await expect(correction.dialog.getByRole('status')).toContainText('有公式尚未转换');
  expect(speech).toEqual([]); expect(await audioState(page)).toBeNull();
  await page.setViewportSize({ width: 1280, height: 720 }); await correction.save.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/math-reading-review-720.png', fullPage: true });
  await correction.input.fill('式子为一加二。第二句。'); await expect(correction.save).toBeEnabled();
  await expect(correction.dialog.getByRole('status')).toHaveCount(0); await expect(correction.preview).toHaveText('式子为一加二。\n第二句。');
  await correction.save.click(); await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  await expect.poll(async () => (await audioState(page))?.playing).toBe(1);
  expect(speech).toHaveLength(1); expect(speech[0].text).toBe('式子为一加二。');
  await expect(page.getByTestId('reading-subtitle')).toHaveText('式子为一加二。');
  await page.getByRole('button', { name: '停止', exact: true }).click();
});
