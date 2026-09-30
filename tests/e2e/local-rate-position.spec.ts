import { expect, test, type Page } from '@playwright/test';
import { mockSourceSpeech } from './realtimeHarness';

type Probe = { elements: HTMLAudioElement[] };
async function setup(page: Page, engine: 'local' | 'qwen') {
  await page.addInitScript(() => {
    const probe: Probe = { elements: [] }; Object.defineProperty(window, '__positionProbe', { value: probe });
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); probe.elements.push(this); } };
  });
  await page.route('**/api/config', async route => {
    const response = await route.fetch(); const config = await response.json();
    await route.fulfill({ json: { ...config, mode: 'demo', capabilities: { ...config.capabilities, tts: 'supported' }, speech: { engine, ready: true, voice: 'test', style: '本地测试', instructionsSupported: false } } });
  });
  const texts: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/tts') texts.push(request.postDataJSON().text); });
  await mockSourceSpeech(page);
  return texts;
}
async function selectSource(page: Page) {
  await page.goto('/'); await page.getByRole('button', { name: /示例/ }).click();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  const span = page.locator('.textLayer span').filter({ hasText: '指数移动平均将过去' }).first();
  await expect(span).toBeVisible(); const box = (await span.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 }); await page.mouse.up();
}
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const elements = (window as unknown as { __positionProbe: Probe }).__positionProbe.elements;
    const audio = elements.at(-1);
    return audio ? { count: elements.length, rate: audio.playbackRate, pitch: audio.preservesPitch, paused: audio.paused, time: audio.currentTime } : null;
  });
}
for (const engine of ['local', 'qwen'] as const) {
  test(`${engine}: 改速保留真实 HTMLAudio 位置与预取，暂停改速不自行播放（WAV 模拟）`, async ({ page }) => {
    const texts = await setup(page, engine); await selectSource(page);
    const rate = page.getByRole('combobox', { name: '语速', exact: true });
    await page.getByRole('button', { name: '朗读所选', exact: true }).click();
    await expect.poll(async () => (await snapshot(page))?.time ?? 0).toBeGreaterThan(0.5);
    await expect.poll(() => texts.length).toBe(2);
    const before = (await snapshot(page))!;
    await rate.selectOption('3');
    await expect.poll(async () => (await snapshot(page))?.rate).toBe(3);
    const faster = (await snapshot(page))!;
    expect(faster).toMatchObject({ count: 1, pitch: true, paused: false }); expect(faster.time).toBeGreaterThanOrEqual(before.time);
    expect(texts).toHaveLength(2);
    await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
    await expect(page.locator('.audio-source strong')).toContainText('已暂停');
    const paused = (await snapshot(page))!;
    for (const value of ['0.25', '2.5']) {
      await rate.selectOption(value); await expect(page.locator('.audio-source strong')).toContainText('已暂停');
      expect(await snapshot(page)).toMatchObject({ count: 1, rate: Number(value), pitch: true, paused: true, time: paused.time });
    }
    await page.getByRole('button', { name: '继续朗读', exact: true }).click();
    await expect.poll(async () => (await snapshot(page))?.time ?? 0).toBeGreaterThan(paused.time);
    expect((await snapshot(page))?.count).toBe(1);
    await expect.poll(() => texts.length).toBe(3); // Pause cancels lookahead; explicit resume may prepare it again.
    const beforeSecondChange = (await snapshot(page))!;
    await rate.selectOption('3'); expect((await snapshot(page))?.count).toBe(1);
    expect((await snapshot(page))!.time).toBeGreaterThanOrEqual(beforeSecondChange.time);
    const nextText = texts[1]; const nextCount = texts.filter(text => text === nextText).length;
    await page.evaluate(() => { const audio = (window as unknown as { __positionProbe: Probe }).__positionProbe.elements[0]; audio.currentTime = audio.duration - 0.02; });
    await expect.poll(async () => (await snapshot(page))?.count).toBe(2);
    expect((await snapshot(page))?.rate).toBe(3); expect(texts.filter(text => text === nextText)).toHaveLength(nextCount);
    if (engine === 'qwen') { await page.setViewportSize({ width: 1280, height: 720 }); await page.screenshot({ path: 'test-results/local-rate-position-720.png', fullPage: true }); }
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(async () => (await snapshot(page))?.paused).toBe(true);
  });

  test(`${engine}: 生成等待时多次调速只保留一个请求，返回后应用最新速度（WAV 模拟）`, async ({ page }) => {
    const texts = await setup(page, engine);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/tts', async route => { await held; await route.fallback(); });
    await selectSource(page); await page.getByRole('button', { name: '朗读所选', exact: true }).click();
    await expect.poll(() => texts.length).toBe(1);
    const rate = page.getByRole('combobox', { name: '语速', exact: true });
    await rate.selectOption('0.25'); await rate.selectOption('3');
    expect(await snapshot(page)).toBeNull();
    release();
    await expect.poll(async () => (await snapshot(page))?.time ?? 0).toBeGreaterThan(0);
    expect(await snapshot(page)).toMatchObject({ count: 1, rate: 3, pitch: true, paused: false });
    expect(texts.filter(text => text === texts[0])).toHaveLength(1);
    await page.getByRole('button', { name: '停止', exact: true }).click();
  });
}
