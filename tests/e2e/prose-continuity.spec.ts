import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mockSourceSpeech } from './realtimeHarness';

async function mockDoubao(page: Page) {
  await page.route('**/api/config', async route => {
    const response = await route.fetch(); const config = await response.json();
    await route.fulfill({ json: { ...config, mode: 'live', models: { ...config.models, chat: 'mock-chat', vision: 'mock-vision', tts: 'MOCK_DOUBAO_NOT_PAID' }, speech: { engine: 'doubao', ready: true, voice: 'mock-stable-voice', style: 'mock only', instructionsSupported: true } } });
  });
}
async function openPdf(page: Page, lines: string[]) {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pdfPage = pdf.addPage([600, 700]);
  lines.forEach((text, index) => pdfPage.drawText(text, { x: 35, y: 570 - index * 45, size: 15, font }));
  await page.goto('/');
  await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles({ name: 'prose-reading.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  await page.getByRole('button', { name: '选本页文字', exact: true }).click();
}

// Actual PDF.js selection and actual HTMLAudio; only the remote TTS response is a silent fixture.
test('默认朗读跳过公式并保留选区原文，不开校对弹窗也不调用识别模型', async ({ page }) => {
  const speech: string[] = []; const recognition: string[] = [];
  page.on('request', request => {
    const endpoint = new URL(request.url()).pathname;
    if (endpoint === '/api/tts') speech.push(request.postDataJSON().text);
    if (endpoint === '/api/reading-assist' || endpoint === '/api/ask') recognition.push(endpoint);
  });
  await mockDoubao(page); await mockSourceSpeech(page);
  await openPdf(page, ['Readers can follow this sentence.', 'An inline value $x^2$ is skipped.', '\\unsupported{x}', 'The next sentence is also readable.']);
  const selected = (await page.locator('.selection-preview').textContent())!;
  expect(selected).toContain('$x^2$'); expect(selected).toContain('unsupported');
  await expect(page.getByTestId('prose-reading-notice')).toContainText(/跳过 \d+ 处/u);
  await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  await expect.poll(() => speech.length).toBe(2);
  expect(speech[0]).toBe('Readers can follow this sentence.');
  expect(speech[1]).toMatch(/An inline value\s+is skipped\./u);
  expect(speech.join(' ')).not.toMatch(/unsupported|x\^2|\\|\$/u);
  expect(recognition).toEqual([]);
  await expect(page.getByRole('dialog', { name: '校对朗读文本', exact: true })).toHaveCount(0);
  await expect(page.locator('.selection-preview')).toHaveText(selected);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByTestId('prose-reading-notice').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/prose-reading-skip-720.png', fullPage: true });
  await page.getByRole('button', { name: '停止', exact: true }).click();
});

test('只有公式的选区给出没有正文提示，不提交识别或语音请求', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', request => { const path = new URL(request.url()).pathname; if (['/api/tts', '/api/reading-assist', '/api/ask'].includes(path)) calls.push(path); });
  await mockDoubao(page); await mockSourceSpeech(page); await openPdf(page, ['$x^2$', '\\frac{1}{2}']);
  await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  await expect(page.locator('.error-banner')).toContainText('没有可朗读的正文');
  await expect(page.getByRole('dialog', { name: '校对朗读文本', exact: true })).toHaveCount(0);
  expect(calls).toEqual([]); await expect(page.locator('.selection-preview')).toContainText('$x^2$');
});

type AudioProbe = { audio: HTMLAudioElement[]; events: Array<{ type: string; id: number; at: number; playing: number }> };
async function probeState(page: Page) {
  return page.evaluate(() => {
    const probe = (window as unknown as { __continuity: AudioProbe }).__continuity;
    return { count: probe.audio.length, playing: probe.audio.filter(audio => !audio.paused && !audio.ended).length, events: probe.events };
  });
}
function silentWav(seconds: number) {
  const bytes = 8000 * 2 * seconds; const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40); return wav;
}

test('豆包模拟延迟：播放时只提前准备下一句，换段复用音频，停止取消迟到的预取', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const probe: AudioProbe = { audio: [], events: [] }; Object.defineProperty(window, '__continuity', { value: probe });
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) {
        super(src); const id = probe.audio.length; probe.audio.push(this);
        for (const type of ['playing', 'ended', 'pause']) this.addEventListener(type, () => probe.events.push({ type, id, at: performance.now(), playing: probe.audio.filter(audio => !audio.paused && !audio.ended).length }));
      }
    };
  });
  await mockDoubao(page);
  const requests: Array<{ text: string; at: number; playing: number; audioCount: number }> = [];
  let returned = 0; let releaseThird!: () => void; const thirdHeld = new Promise<void>(resolve => { releaseThird = resolve; });
  const failed: string[] = [];
  page.on('requestfailed', request => { if (new URL(request.url()).pathname === '/api/tts') failed.push(request.postDataJSON().text); });
  await page.route('**/api/tts', async route => {
    const body = route.request().postDataJSON();
    const current = await page.evaluate(() => {
      const probe = (window as unknown as { __continuity: AudioProbe }).__continuity;
      return { at: performance.now(), playing: probe.audio.filter(audio => !audio.paused && !audio.ended).length, audioCount: probe.audio.length };
    });
    requests.push({ text: body.text, ...current }); const index = requests.length;
    if (index === 3) await thirdHeld;
    else await new Promise(resolve => setTimeout(resolve, 350));
    await route.fulfill({ status: 200, body: silentWav(30), headers: { 'Content-Type': 'audio/wav', 'x-session-id': body.sessionId, 'x-generation-id': String(body.generationId), 'x-context-revision': String(body.contextRevision) } }).catch(() => undefined);
    returned++;
  });
  await openPdf(page, ['First sentence plays while the next one is prepared.', 'Second sentence uses the prepared audio.', 'Third sentence must not begin after stop.']);
  await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  await expect.poll(() => returned).toBe(2);
  expect(requests).toHaveLength(2); expect(requests[1]).toMatchObject({ playing: 1, audioCount: 1 });
  expect(await probeState(page)).toMatchObject({ count: 1, playing: 1 });
  await page.evaluate(() => { const audio = (window as unknown as { __continuity: AudioProbe }).__continuity.audio[0]; audio.currentTime = audio.duration - 0.05; });
  await expect.poll(async () => (await probeState(page)).events.some(event => event.id === 1 && event.type === 'playing')).toBe(true);
  await expect.poll(() => requests.length).toBe(3);
  const state = await probeState(page);
  const firstEnd = state.events.find(event => event.id === 0 && event.type === 'ended')!;
  const secondStart = state.events.find(event => event.id === 1 && event.type === 'playing')!;
  const gapMs = secondStart.at - firstEnd.at;
  expect(gapMs).toBeGreaterThanOrEqual(0); expect(gapMs).toBeLessThan(250); // Less than the deliberately delayed 350 ms network response.
  expect(requests[1].at).toBeLessThan(firstEnd.at); expect(requests[2].at).toBeGreaterThanOrEqual(secondStart.at);
  expect(requests.filter(request => request.text === requests[1].text)).toHaveLength(1);
  expect(state.events.every(event => event.playing <= 1)).toBe(true);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect.poll(() => failed).toContain(requests[2].text); releaseThird();
  await expect.poll(() => returned).toBe(3);
  expect(await probeState(page)).toMatchObject({ count: 2, playing: 0 });
  const reportPath=testInfo.outputPath('mock-doubao-continuity.json');
  await writeFile(reportPath,JSON.stringify({ simulatedNetworkDelayMs: 350, transitionGapMs: gapMs, requests, events: (await probeState(page)).events, realCloudTest: false },null,2));
  await testInfo.attach('mock-doubao-continuity.json', { path: reportPath, contentType: 'application/json' });
});
