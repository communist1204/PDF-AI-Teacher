/* global Audio */
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { clearTimeout } from 'node:timers';

// Real packaged-app smoke test. No response mocks, real user profile, API key, or microphone.
// Run from the project root after packaging: node scripts/verify-qwen-desktop.mjs
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/verify-qwen-desktop.mjs [--executable <packaged.exe>] [--device cpu|cuda] [--long]\nUses a fresh test-results/qwen-desktop-profile/<run-id> profile; requires free port 4319 and packaged Qwen resources. Five-minute overall limit, 90-second generation wait. Audio is muted; listening quality is not tested.');
  process.exit(0);
}
const deviceIndex=process.argv.indexOf('--device');
const device=deviceIndex>=0?process.argv[deviceIndex+1]:'cpu';if(!['cpu','cuda'].includes(device))throw Error('Unsupported test device');
const longSample=process.argv.includes('--long');
const executableIndex = process.argv.indexOf('--executable');
if (executableIndex >= 0 && !process.argv[executableIndex + 1]) throw Error('--executable requires a packaged executable path');
const executablePath = resolve(executableIndex >= 0 ? process.argv[executableIndex + 1] : 'release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe');
const profile = resolve('test-results', 'qwen-desktop-profile', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
const artifact = name => join(profile, name);
await mkdir(profile, { recursive: true });
const env = { ...process.env, PDF_TEACHER_DATA_DIR: profile, PDF_TEACHER_TEST_MODE: '1', DEMO_MODE: 'true' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPENAI_API_KEY;
let application;
let page;
let stage = 'preflight';
const pageErrors = [];
const requests = [];
const requestRecords = new WeakMap();
const remoteRendererRequests = [];
const report = {
  date: new Date().toISOString(), status: 'running', executablePath, profile, device, longSample,
  checks: {}, requests, pageErrors, remoteRendererRequests,
  humanListening: '未验收；真实 HTMLAudio 播放使用静音，不代表音色、语气或教材朗读质量通过真人验收。',
  realAccountAndPaidApi: '未测；只使用全新隔离目录、无 Key 和演示解题模式。',
};
const started = Date.now();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
class EnvironmentBlocked extends Error {}
async function assertPortAvailable() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', error => reject(new EnvironmentBlocked(error.code === 'EADDRINUSE'
      ? '本机 4319 已被使用。未关闭或修改既有应用；请在测试端口空闲后重新执行。'
      : '无法检查本机测试端口：' + error.code)));
    probe.listen(4319, '127.0.0.1', () => probe.close(resolve));
  });
}
async function launch() {
  await assertPortAvailable();
  application = await electron.launch({ executablePath, args: [], env, timeout: 45000 });
  page = await application.firstWindow({ timeout: 45000 });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && !['127.0.0.1', 'localhost'].includes(url.hostname)) remoteRendererRequests.push(url.origin + url.pathname);
    if (url.pathname !== '/api/tts') return;
    const body = request.postDataJSON();
    const record = { speechText: body.text, speed: body.speed, startedMs: Date.now() - started, status: 'requested' };
    requests.push(record); requestRecords.set(request, record);
  });
  page.on('response', response => {
    const record = requestRecords.get(response.request());
    if (record) { record.status = response.status(); record.contentType = response.headers()['content-type']; }
  });
  page.on('requestfailed', request => {
    const record = requestRecords.get(request);
    if (record) record.failure = request.failure()?.errorText ?? 'failed';
  });
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.teaching-route')).toBeVisible();
  expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
}
async function closeTestApplication() {
  if (!application) return;
  const ownApplication = application; application = undefined; page = undefined;
  await ownApplication.close();
}
async function readPublicSettings() {
  const settings = await page.evaluate(() => window.desktopTeacher.getSettings());
  expect(settings.mode).toBe('demo'); expect(settings.hasApiKey).toBe(false); expect(settings.auth.status).toBe('signed_out'); expect(settings.auth.accounts).toEqual([]);
  return settings;
}
async function correctText(text) {
  await page.getByRole('button', { name: '校对朗读文本', exact: true }).click();
  await page.getByRole('textbox', { name: '确认后的朗读文本', exact: true }).fill(text);
  await page.getByRole('button', { name: '使用校对文本', exact: true }).click();
}
const getAudio = () => page.evaluate(() => {
  const audio = window.__qwenDesktopAudio.at(-1);
  return audio ? { rate: audio.playbackRate, preservesPitch: audio.preservesPitch, duration: audio.duration, time: audio.currentTime, paused: audio.paused, readyState: audio.readyState } : null;
});
const getUsage = () => page.evaluate(async () => {
  const response = await fetch('/api/usage'); if (!response.ok) throw Error('无法读取本机语音测试用量'); return response.json();
});
async function run() {
  await access(executablePath).catch(() => { throw new EnvironmentBlocked('尚未找到打包后的软件，请先完成 desktop:package。'); });
  await launch();
  const initial = await readPublicSettings();
  if (!initial.qwenTtsReady) throw new EnvironmentBlocked('打包软件未报告 Qwen3 资源就绪；没有改用演示音频或其他声音。');
  stage = 'configure-isolated-profile';
  await page.getByRole('button', { name: '声音设置', exact: true }).click();
  await page.getByRole('combobox', { name: '使用方式', exact: true }).selectOption('demo');
  await page.getByRole('combobox', { name: '朗读方式', exact: true }).selectOption('qwen');
  await page.getByRole('combobox',{name:'Qwen3 运算设备',exact:true}).selectOption(device);
  await page.getByRole('combobox', { name: 'Qwen3 中文音色', exact: true }).selectOption('serena');
  await page.getByRole('textbox', { name: 'Qwen3 朗读语气', exact: true }).fill('温和自然地用中文朗读，按语义停顿，不增添或改动原文。');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  expect((await readPublicSettings()).restartRequired).toBe(true);
  await closeTestApplication();
  await launch();
  const configured = await readPublicSettings();
  expect(configured.ttsEngine).toBe('qwen'); expect(configured.qwenTtsVoice).toBe('serena'); expect(configured.qwenTtsReady).toBe(true); expect(configured.restartRequired).toBe(false);
  const config = await page.evaluate(async () => (await fetch('/api/config')).json());
  expect(config.mode).toBe('demo'); expect(config.speech.engine).toBe('qwen'); expect(config.speech.device).toBe(device); expect(config.speech.ready).toBe(true); expect(config.models.tts).toMatch(/Qwen3/i);
  report.configuration = { mode: config.mode, engine: config.speech.engine, model: config.models.tts, voice: config.speech.voice, device:config.speech.device, ready: config.speech.ready, noApiKey: true };
  report.checks.settingsSavedAndReopened = true;
  await expect(page.locator('.audio-kind')).toHaveText('Qwen3 本地 AI 语音');
  await page.evaluate(() => {
    window.__qwenDesktopAudio = [];
    window.__qwenDesktopBlobs = new Map();
    const createURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url=createURL(blob);window.__qwenDesktopBlobs.set(url,blob);return url; };
    const NativeAudio = Audio;
    window.Audio = class extends NativeAudio { constructor(src) { super(src); window.__qwenDesktopAudio.push(this); } };
  });

  stage = 'pdf-selection-and-correction';
  await page.getByRole('button', { name: /示例/ }).first().click();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  const span = page.locator('.textLayer span').filter({ hasText: '指数移动平均将过去' }).first(); await expect(span).toBeVisible();
  const bounds = await span.boundingBox(); expect(bounds).not.toBeNull();
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 12 }); await page.mouse.up();
  await expect(page.locator('.selection-preview')).toContainText('指数移动平均');
  const corrected = longSample ? '2026年，我们学习神经网络时，先要理解梯度描述的是损失如何随着参数变化，\n然后沿着能够降低损失的方向逐步更新参数，同时保持合适的学习率，并通过验证集观察模型能否处理没有见过的数据，这样才能判断训练是否真的有效，而不是只记住了已有的样本。' : '2026年，我们\n一起读书。';
  const expectedSpeech = corrected.replace(/\n/g,'').replace('2026年','二零二六年');
  await correctText(corrected);
  report.checks.realPdfTextSelection = true;
  await page.getByRole('combobox', { name: '语速', exact: true }).selectOption('0.25');
  await page.getByRole('slider', { name: '音量', exact: true }).fill('0');

  stage = 'real-qwen-generation-and-decode';
  const firstStarted = Date.now();
  const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tts', { timeout: 90000 });
  await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  const response = await firstResponse;
  expect(response.status()).toBe(200); expect(response.headers()['content-type']).toMatch(/^audio\/wav/);
  await expect(page.locator('.audio-source strong')).toContainText('正在朗读', { timeout: 10000 });
  await expect.poll(async () => (await getAudio())?.time, { timeout: 10000 }).toBeGreaterThan(0);
  // Electron CDP reports an empty response.body() for this binary fetch. Inspect the exact blob consumed by the real player instead.
  const wav = Buffer.from(await page.evaluate(async () => { const src=window.__qwenDesktopAudio.at(-1).src; if(!src.startsWith('blob:'))throw Error('Expected actual local playback blob'); return Array.from(new Uint8Array(await window.__qwenDesktopBlobs.get(src).arrayBuffer())); }));
  expect(wav.length).toBeGreaterThan(44); expect(wav.toString('ascii',0,4)).toBe('RIFF'); expect(wav.toString('ascii',8,12)).toBe('WAVE');
  const playing = await getAudio(); expect(playing.duration).toBeGreaterThan(0.2); expect(playing.rate).toBe(0.25); expect(playing.preservesPitch).toBe(true); expect(playing.readyState).toBeGreaterThanOrEqual(2);
  expect(requests).toHaveLength(1); expect(requests[0].speechText).toBe(expectedSpeech); expect(requests[0].speechText).not.toMatch(/[\r\n]/); expect(requests[0].speechText).not.toContain('2026');
  const subtitle = await page.getByTestId('reading-subtitle').textContent(); expect(subtitle).toBe(corrected);
  const firstUsage = (await getUsage()).records.filter(record => record.category === 'tts');
  expect(firstUsage).toHaveLength(1); expect(firstUsage[0].local).toBe(true); expect(firstUsage[0].cancelled).toBe(false); expect(firstUsage[0].model).toMatch(/Qwen3/i);
  report.firstAudio = { elapsedMs: Date.now() - firstStarted, bytes: wav.length, ...playing };
  report.checks.crossLineSentenceSentOnce = true; report.checks.calendarYearPronunciation = true; report.checks.sourceTextPreserved = true; report.checks.realApiWaveAndHtmlAudioDecode = true; report.checks.localFreeUsage = true;
  await page.screenshot({ path: artifact('qwen-playing.png'), fullPage: true });

  stage = 'pause-resume-stop';
  await page.getByRole('button', { name: '暂停朗读', exact: true }).click(); await expect(page.locator('.audio-source strong')).toContainText('已暂停');
  const paused = await getAudio(); expect(paused.paused).toBe(true); await delay(350); expect(Math.abs((await getAudio()).time - paused.time)).toBeLessThan(0.1);
  await page.getByRole('button', { name: '继续朗读', exact: true }).click(); await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  await expect(page.getByTestId('reading-subtitle')).toHaveText(subtitle); await expect.poll(async () => (await getAudio()).time).toBeGreaterThan(paused.time);
  expect(requests).toHaveLength(1);
  expect(await page.evaluate(() => window.__qwenDesktopAudio.filter(audio => !audio.paused && audio.getAttribute('src')).length)).toBe(1);
  await page.getByRole('button', { name: '停止', exact: true }).click(); await expect(page.locator('.audio-source strong')).toContainText('待机');
  expect(await page.evaluate(() => window.__qwenDesktopAudio.every(audio => audio.paused && !audio.getAttribute('src')))).toBe(true);
  report.checks.pausePreservesAudioPosition = true; report.checks.resumeSameSentenceWithoutRegeneration = true; report.checks.singleOutput = true; report.checks.stopClearsAudio = true;

  stage = 'cancel-real-generation';
  const cancelText = '这句短文用来检查停止生成。';
  await correctText(cancelText);
  const requestCount = requests.length;
  const audioCount = await page.evaluate(() => window.__qwenDesktopAudio.length);
  const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/tts' && request.postDataJSON().text === cancelText);
  await page.getByRole('button', { name: '朗读所选', exact: true }).click(); await requested;
  // A usage record proves the real server has accepted the job before cancellation.
  await expect.poll(async () => (await getUsage()).records.filter(record => record.category === 'tts').length).toBeGreaterThan(firstUsage.length);
  await expect(page.locator('.audio-source strong')).toContainText('准备声音');
  const cancellationResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/cancel' && response.request().method() === 'POST');
  const cancelledAt = Date.now(); await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.locator('.audio-source strong')).toContainText('待机'); const localStopMs = Date.now() - cancelledAt;
  expect((await cancellationResponse).status()).toBe(200);
  await expect.poll(async () => (await getUsage()).records.filter(record => record.category === 'tts' && record.local && record.cancelled).length).toBe(1);
  await delay(1500);
  expect(requests).toHaveLength(requestCount + 1); expect(await page.evaluate(() => window.__qwenDesktopAudio.length)).toBe(audioCount);
  expect(await page.evaluate(() => window.__qwenDesktopAudio.every(audio => audio.paused && !audio.getAttribute('src')))).toBe(true);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  report.cancellation = { localStopMs, realServerAcceptedRequest: true, localCancelledUsageConfirmed: true, noLateAudioDuringObservationMs: 1500 };
  report.checks.cancelGeneration = true;
  await page.screenshot({ path: artifact('qwen-cancelled.png'), fullPage: true });

  stage = 'settings-720p';
  await page.getByRole('button', { name: '声音设置', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720));
  await page.getByRole('textbox', { name: 'Qwen3 朗读语气', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.locator('.desktop-speech-fields')).toContainText('Qwen3 语音资源已就绪');
  await page.screenshot({ path: artifact('qwen-settings-720.png'), fullPage: true });
  expect(pageErrors).toEqual([]); expect(remoteRendererRequests).toEqual([]);
  report.checks.settings720pScreenshot = true;
  report.status = 'passed';
}
let timeout;
try {
  await Promise.race([run(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('真实桌面验收超过五分钟总时限')), 300000); })]);
} catch (error) {
  report.status = error instanceof EnvironmentBlocked ? 'blocked' : 'failed'; report.stage = stage; report.error = error instanceof Error ? error.message : String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: artifact('qwen-failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
  process.exitCode = report.status === 'blocked' ? 2 : 1;
} finally {
  clearTimeout(timeout);
  await closeTestApplication().catch(error => { report.cleanupError = error.message; report.status = 'failed'; process.exitCode = 1; });
  report.elapsedMs = Date.now() - started;
  await writeFile(artifact('report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log('Report: ' + artifact('report.json'));
}
