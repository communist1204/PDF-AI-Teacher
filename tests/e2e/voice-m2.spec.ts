import { expect, test, type Page } from '@playwright/test';
import type { TranscriptionRequest } from '../../packages/shared/protocol';

type DeviceMode = 'tone' | 'silent' | 'denied' | 'delayed';
type MicrophoneHarness = { calls: number; tracks: MediaStreamTrack[]; contexts: AudioContext[]; release: (() => void) | null };

// Synthetic input only: actual AudioContext + MediaRecorder, never the user's microphone.
// No node connects to context.destination, so no test sound reaches the speakers.
async function installMicrophone(page: Page, mode: DeviceMode) {
  await page.addInitScript(({ mode }) => {
    const harness: MicrophoneHarness = { calls: 0, tracks: [], contexts: [], release: null };
    Object.defineProperty(window, '__m2Microphone', { value: harness });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => {
        harness.calls += 1;
        if (mode === 'denied') throw new DOMException('Test-only denied microphone', 'NotAllowedError');
        const context = new AudioContext(); harness.contexts.push(context);
        const destination = context.createMediaStreamDestination();
        if (mode === 'tone') {
          const oscillator = context.createOscillator(); const gain = context.createGain(); gain.gain.value = 0.08;
          oscillator.frequency.value = 440; oscillator.connect(gain); gain.connect(destination); oscillator.start();
        }
        await context.resume();
        const stream = destination.stream; harness.tracks.push(...stream.getTracks());
        if (mode === 'delayed') return new Promise<MediaStream>(resolve => { harness.release = () => resolve(stream); });
        return stream;
      },
    } });
  }, { mode });
}
async function mockLiveConfig(page: Page) {
  await page.route('**/api/config', async route => {
    const response = await route.fetch(); const config = await response.json();
    // The test server must remain DEMO. Only this browser's reported config is mocked.
    expect(config.mode).toBe('demo');
    await route.fulfill({ response, json: { ...config, mode: 'live', capabilities: { ...config.capabilities, transcription: 'untested' }, models: { ...config.models, transcription: 'mock-transcription-no-provider' } } });
  });
}
async function selectSample(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /示例/ }).click();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.textLayer span').filter({ hasText: '指数移动平均将过去' }).first()).toBeVisible();
  await page.getByRole('button', { name: '选本页文字', exact: true }).click();
  await expect(page.getByRole('button', { name: '语音转文字提问', exact: true })).toBeEnabled();
}
async function startAndCapture(page: Page, demo = false) {
  await page.getByRole('button', { name: '语音转文字提问', exact: true }).click();
  const finish = page.getByRole('button', { name: demo ? /结束录音 ·/ : /结束并转写 ·/ });
  await expect(finish).toBeVisible();
  // Wait for actual capture and the level sampler, not a fabricated MediaRecorder callback.
  await expect.poll(async () => await finish.textContent()).toMatch(/[1-9]\d* \/ 60 秒/);
  return finish;
}
async function expectTracksStopped(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const harness = (window as unknown as { __m2Microphone: MicrophoneHarness }).__m2Microphone;
    return harness.tracks.length > 0 && harness.tracks.every(track => track.readyState === 'ended');
  })).toBe(true);
}

test('M2 麦克风拒绝：中文恢复提示，PDF 和文字提问仍可用（权限模拟）', async ({ page }) => {
  await installMicrophone(page, 'denied'); await selectSample(page);
  await page.getByRole('button', { name: '语音转文字提问', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('网站权限');
  await expect(page.getByRole('alert')).toContainText('直接输入文字');
  await page.getByRole('textbox', { name: '输入文字问题' }).fill('请解释 beta 的作用。');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.getByTestId('board-step').first()).toBeVisible();
  await expect(page.locator('.message.assistant')).toContainText('演示');
  await expect(page.locator('.textLayer')).toBeVisible();
});

test('M2 实际录音管线＋合成音输入：模拟转写只填草稿，纠正后才提问', async ({ page }) => {
  await installMicrophone(page, 'tone'); await mockLiveConfig(page);
  let uploads = 0; let captured: TranscriptionRequest | undefined; const questions: string[] = [];
  await page.route('**/api/transcribe', async route => {
    uploads += 1; captured = route.request().postDataJSON() as TranscriptionRequest;
    await route.fulfill({ status: 200, contentType: 'application/json', json: { sessionId: captured.sessionId, generationId: captured.generationId, contextRevision: captured.contextRevision, mode: 'live', text: '为什么 beta 要乘 t？', usage: { category: 'transcription', model: 'mock-only', requestId: 'req_browser_mock', inputTokens: null, outputTokens: null, characters: null, estimatedCost: null, cancelled: false } } });
  });
  await page.route('**/api/ask', async route => { questions.push(route.request().postDataJSON().question); await route.continue(); });
  await selectSample(page); const finish = await startAndCapture(page); await finish.click();
  const draft = page.getByRole('textbox', { name: '输入文字问题' });
  await expect(draft).toHaveValue('为什么 beta 要乘 t？');
  await expect(page.locator('.voice-question-hint')).toContainText('检查 beta');
  expect(uploads).toBe(1); expect(questions).toEqual([]); await expect(page.locator('.message')).toHaveCount(0);
  expect(captured?.mimeType).toBe('audio/webm');
  expect(Buffer.from(captured!.audioBase64, 'base64').subarray(0, 4).toString('hex')).toBe('1a45dfa3');
  expect(captured!.durationMs).toBeGreaterThanOrEqual(300); expect(captured!.durationMs).toBeLessThanOrEqual(60000);
  await expectTracksStopped(page);
  await draft.fill('为什么 beta 要取 t 次方？'); await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.getByTestId('board-step').first()).toBeVisible();
  expect(questions).toEqual(['为什么 beta 要取 t 次方？']);
  await expect(page.locator('.message.assistant')).toContainText('演示'); // Local DEMO service, never a paid ask.
});

test('M2 真实 MediaRecorder 静音输入：拒绝上传且释放设备', async ({ page }) => {
  await installMicrophone(page, 'silent'); await mockLiveConfig(page);
  let uploads = 0; page.on('request', request => { if (request.url().endsWith('/api/transcribe')) uploads += 1; });
  await selectSample(page); const finish = await startAndCapture(page); await finish.click();
  await expect(page.getByRole('alert')).toContainText('音量过低或没有声音');
  await expectTracksStopped(page); expect(uploads).toBe(0);
  await expect(page.getByRole('textbox', { name: '输入文字问题' })).toHaveValue('');
  await expect(page.getByRole('button', { name: '语音转文字提问', exact: true })).toBeEnabled();
});

test('M2 取消权限等待：迟到的合成设备立即关闭，不开始录音或上传', async ({ page }) => {
  await installMicrophone(page, 'delayed'); await mockLiveConfig(page);
  let uploads = 0; page.on('request', request => { if (request.url().endsWith('/api/transcribe')) uploads += 1; });
  await selectSample(page); await page.getByRole('button', { name: '语音转文字提问', exact: true }).click();
  await expect(page.getByRole('button', { name: '等待麦克风权限…', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __m2Microphone: MicrophoneHarness }).__m2Microphone.release))).toBe(true);
  await page.getByRole('button', { name: '取消录音', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __m2Microphone: MicrophoneHarness }).__m2Microphone.release?.());
  await expectTracksStopped(page); expect(uploads).toBe(0);
  await expect(page.getByRole('button', { name: /结束并转写/ })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '输入文字问题' })).toHaveValue('');
});

test('M2 DEMO 实际录音管线：结束后丢弃，明确没有上传或转写', async ({ page }) => {
  await installMicrophone(page, 'tone'); let uploads = 0;
  page.on('request', request => { if (request.url().endsWith('/api/transcribe')) uploads += 1; });
  await selectSample(page); await expect(page.locator('.voice-question-hint')).toContainText('不上传、不自动转写');
  const finish = await startAndCapture(page, true); await finish.click();
  await expect(page.locator('.voice-question-hint')).toContainText('未上传、未转写');
  await expectTracksStopped(page); expect(uploads).toBe(0);
  await expect(page.getByRole('textbox', { name: '输入文字问题' })).toHaveValue('');
});

test('M2 录音中停止声音：同时释放输入设备，保留文字草稿（合成输入）', async ({ page }) => {
  await installMicrophone(page, 'tone'); await mockLiveConfig(page); let uploads = 0;
  page.on('request', request => { if (request.url().endsWith('/api/transcribe')) uploads += 1; });
  await selectSample(page); await page.getByRole('textbox', { name: '输入文字问题' }).fill('先保留这个问题。');
  await startAndCapture(page); await page.getByRole('button', { name: '停止', exact: true }).click();
  await expectTracksStopped(page); expect(uploads).toBe(0);
  await expect(page.getByRole('textbox', { name: '输入文字问题' })).toHaveValue('先保留这个问题。');
  await expect(page.getByRole('button', { name: '语音转文字提问', exact: true })).toBeEnabled();
});
