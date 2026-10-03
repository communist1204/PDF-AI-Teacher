import { expect, test, type Page } from '@playwright/test';
import { mockSourceSpeech, openRealtime, realtimeHarness } from './realtimeHarness';

type AudioProbe = { elements: HTMLAudioElement[] };
async function selectSource(page: Page) {
  await page.getByRole('button', { name: /示例/ }).click();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  const span = page.locator('.textLayer span').filter({ hasText: '指数移动平均将过去' }).first();
  await expect(span).toBeVisible(); const box = (await span.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 }); await page.mouse.up();
}
async function audioState(page: Page) {
  return page.evaluate(() => {
    const audio = (window as unknown as { __rateProbe: AudioProbe }).__rateProbe.elements.at(-1);
    return audio ? { rate: audio.playbackRate, pitch: audio.preservesPitch, paused: audio.paused, time: audio.currentTime, duration: audio.duration } : null;
  });
}
for (const engine of ['doubao', 'openai'] as const) {
  test(`${engine}: 3× 经真实 HTMLAudio 解码、保音高、暂停改速续读及持久化（音频响应模拟）`, async ({ page }) => {
    await page.addInitScript(() => {
      const probe: AudioProbe = { elements: [] }; Object.defineProperty(window, '__rateProbe', { value: probe });
      const NativeAudio = window.Audio;
      window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); probe.elements.push(this); } };
    });
    await page.route('**/api/config', async route => {
      const response = await route.fetch(); const config = await response.json();
      await route.fulfill({ json: { ...config, mode: engine === 'openai' ? 'live' : 'demo', models: { ...config.models, tts: 'MOCK_TTS_NOT_PAID' }, capabilities: { ...config.capabilities, tts: 'supported' }, speech: { engine, ready: true, voice: 'test', style: '测试音频', instructionsSupported: false } } });
    });
    const requests: Array<{ speed: number }> = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/tts') requests.push(request.postDataJSON()); });
    await mockSourceSpeech(page); await page.goto('/'); await selectSource(page);
    const rate = page.getByRole('combobox', { name: '语速', exact: true });
    await rate.selectOption('3'); await page.getByRole('button', { name: '朗读所选', exact: true }).click();
    await expect.poll(async () => (await audioState(page))?.paused).toBe(false);
    await expect.poll(async () => (await audioState(page))?.time ?? 0).toBeGreaterThan(0);
    expect(await audioState(page)).toMatchObject({ rate: engine === 'openai' ? 1 : 3, pitch: true, duration: 30 });
    expect(requests[0].speed).toBe(3);
    const sentence = await page.getByTestId('reading-subtitle').textContent();
    await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
    await expect(page.locator('.audio-source strong')).toContainText('已暂停');
    await rate.selectOption('2.5'); await expect(page.locator('.audio-source strong')).toContainText('已暂停');
    expect((await audioState(page))?.paused).toBe(true);
    await page.getByRole('button', { name: '继续朗读', exact: true }).click();
    await expect.poll(async () => (await audioState(page))?.paused).toBe(false);
    expect((await audioState(page))?.rate).toBe(engine === 'openai' ? 1 : 2.5);
    await expect(page.getByTestId('reading-subtitle')).toHaveText(sentence ?? '');
    await rate.selectOption('3'); await expect.poll(async () => (await audioState(page))?.rate).toBe(engine === 'openai' ? 1 : 3);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(async () => (await audioState(page))?.paused).toBe(true);
    await page.reload(); await expect(page.locator('.audio-kind')).toHaveText(engine==='doubao'?'豆包 2.0 AI 语音 · 云端':'OpenAI AI 合成语音 · API 计费'); await expect(rate).toHaveValue('3');
    expect(await page.evaluate(() => (window as unknown as { __rateProbe: AudioProbe }).__rateProbe.elements.length)).toBe(0);
    if (engine === 'doubao') { await page.setViewportSize({ width: 1280, height: 720 }); await page.screenshot({ path: 'test-results/speech-rate-three-720.png', fullPage: true }); }
  });
}

test('朗读选 3× 时实时讲解明确按 1.5×，不向服务端发送超限速度（本机 RTC 回环/模型模拟）', async ({ page }) => {
  await realtimeHarness(page); await openRealtime(page);
  await page.getByRole('combobox', { name: '语速', exact: true }).selectOption('3');
  await page.evaluate(() => (window as unknown as { __rt: { speech: (text: string) => void } }).__rt.speech('请解释这一段。'));
  await expect(page.locator('.realtime-status')).toContainText('正在播放');
  await expect(page.locator('.realtime-body')).toContainText('本次按 1.5× 播放');
  const speeds = await page.evaluate(() => (window as unknown as { __rt: { sent: Array<{ type: string; session?: { audio?: { output?: { speed?: number } } } }> } }).__rt.sent.filter(event => event.type === 'session.update').map(event => event.session?.audio?.output?.speed));
  expect(speeds).toContain(1.5); expect(speeds).not.toContain(3);
  await expect(page.getByRole('combobox', { name: '语速', exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: '停止', exact: true }).click();
});
