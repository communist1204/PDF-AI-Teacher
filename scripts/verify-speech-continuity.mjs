/* global Audio, performance */
import { _electron as electron, expect } from '@playwright/test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { clearTimeout } from 'node:timers';

// Real packaged Electron / Qwen CUDA verification. No audio responses are mocked.
// Does not read the user's profile or change existing settings/processes.
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/verify-speech-continuity.mjs [--executable <packaged.exe>] [--save-wav]\nNeeds free loopback port 4319 and packaged Qwen CUDA resources. Uses a new test-results/speech-continuity-profile directory, demo teaching, uncle_fu and volume 0. Checks live speed changes, natural sentence handoff, navigation and formula speech. Five-minute limit plus bounded cleanup. Audio quality is not judged by this muted test.');
  process.exit(0);
}
const executableIndex = process.argv.indexOf('--executable');
if (executableIndex >= 0 && !process.argv[executableIndex + 1]) throw Error('--executable requires a path');
const executablePath = resolve(executableIndex >= 0 ? process.argv[executableIndex + 1] : 'release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe');
const saveWave = process.argv.includes('--save-wav');
const profile = resolve('test-results', 'speech-continuity-profile', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
const artifact = name => join(profile, name);
await mkdir(profile, { recursive: true });
// Keep only OS process prerequisites. Do not inherit API keys, auth, proxies, NODE_OPTIONS or CUDA settings.
const env = {};
for (const [key, value] of Object.entries(process.env)) if (['systemroot', 'windir', 'systemdrive', 'comspec', 'temp', 'tmp'].includes(key.toLowerCase())) env[key] = value;
Object.assign(env, { PDF_TEACHER_DATA_DIR: profile, PDF_TEACHER_TEST_MODE: '1', DEMO_MODE: 'true' });
const sentences = [
  '2026年，我们学习神经网络时，先要理解梯度描述的是损失如何随着参数变化，然后沿着能够降低损失的方向逐步更新参数，同时保持合适的学习率，并通过验证集观察模型能否处理没有见过的数据，这样才能判断训练是否真的有效，而不是只记住了已有的样本。',
  '接下来，我们把同样的方法用于另一组数据，并仔细比较每次更新之前和之后的结果，确认变化方向是否符合预期。',
  '最后，我们记录假设、计算步骤与验证结果，遇到不确定的结论时重新检查条件，再把整个推导连起来理解。',
];
const spoken = sentences.map(text => text.replace('2026年', '二零二六年'));
const formula = '式子为 $\\frac{1}{1-\\beta^t}$。';
const requests = [];
const requestRecords = new WeakMap();
const pageErrors = [];
const remoteRendererRequests = [];
const report = {
  date: new Date().toISOString(), status: 'running', executablePath, profile, device: 'cuda', voice: 'uncle_fu', volume: 0,
  checks: {}, requests, pageErrors, remoteRendererRequests, rateChanges: [], naturalHandoffs: [],
  humanListening: '未测：静音真实合成/播放只验证行为与事件间隔，不证明自然度、音色一致性或公式实际发音正确。',
  paidApis: '未请求：全新隔离配置、无 Key、演示解题，仅本地 Qwen CUDA。',
};
const started = Date.now();
let application, page, stage = 'preflight', totalTimer;
let stopping = false;
class EnvironmentBlocked extends Error {}
async function portAvailable() {
  const probe = createServer();
  await new Promise((done, reject) => {
    probe.once('error', error => reject(new EnvironmentBlocked(error.code === 'EADDRINUSE'
      ? '4319 端口已被使用；没有关闭现有应用，请端口空闲后重试。' : '无法检查测试端口：' + error.code)));
    probe.listen(4319, '127.0.0.1', () => probe.close(done));
  });
}
async function launch() {
  if (stopping) throw Error('测试已经结束，不再启动新进程。');
  await portAvailable();
  if (stopping) throw Error('测试已经结束，不再启动新进程。');
  application = await electron.launch({ executablePath, args: [], env, timeout: 40000 });
  page = await application.firstWindow({ timeout: 40000 }); page.setDefaultTimeout(10000);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720));
  const identity = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData') }));
  expect(identity.packaged).toBe(true); expect(resolve(identity.profile).toLowerCase()).toBe(profile.toLowerCase());
  page.on('pageerror', error => { if (pageErrors.length < 20) pageErrors.push(error.message); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && !['127.0.0.1', 'localhost'].includes(url.hostname)) remoteRendererRequests.push(url.origin + url.pathname);
    if (url.pathname !== '/api/tts') return;
    const body = request.postDataJSON();
    const record = { phase: stage, speechText: body.text, requestedRate: body.speed, startedMs: Date.now() - started, status: 'requested' };
    requests.push(record); requestRecords.set(request, record);
  });
  page.on('response', response => {
    const record = requestRecords.get(response.request());
    if (record) { record.status = response.status(); record.completedMs = Date.now() - started; record.contentType = response.headers()['content-type']; record.cache = response.headers()['x-audio-cache'] ?? 'miss'; }
  });
  page.on('requestfailed', request => {
    const record = requestRecords.get(request); if (record) record.failure = request.failure()?.errorText ?? 'failed';
  });
  await page.waitForLoadState('domcontentloaded'); await expect(page.locator('.teaching-route')).toBeVisible();
}
async function closeOwnedApp() {
  if (!application) return;
  const owned = application; const child = owned.process(); application = undefined; page = undefined;
  let timer;
  try {
    await Promise.race([owned.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('隔离测试应用关闭超过 10 秒')), 10000); })]);
  } catch (error) {
    // This handle belongs only to electron.launch above. Never enumerate or stop unrelated processes.
    if (child.exitCode === null) child.kill();
    throw error;
  } finally { clearTimeout(timer); }
}
async function publicSettings() {
  const settings = await page.evaluate(() => window.desktopTeacher.getSettings());
  expect(settings.mode).toBe('demo'); expect(settings.hasApiKey).toBe(false); expect(settings.hasDoubaoApiKey).toBe(false);
  expect(settings.auth.status).toBe('signed_out'); expect(settings.auth.accounts).toEqual([]);
  return settings;
}
async function installAudioProbe() {
  await page.evaluate(() => {
    const probe = { elements: [], events: [], blobs: new Map() }; window.__speechContinuity = probe;
    const createURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = createURL(blob); probe.blobs.set(url, blob); return url; };
    const NativeAudio = Audio;
    window.Audio = class extends NativeAudio {
      constructor(src) {
        super(src); const id = probe.elements.length; this.__continuityId = id; this.__continuitySource = src; probe.elements.push(this);
        for (const type of ['playing', 'ended', 'ratechange', 'seeking', 'waiting', 'pause', 'error']) this.addEventListener(type, () => {
          probe.events.push({ id, type, at: performance.now(), time: this.currentTime, rate: this.playbackRate, duration: this.duration, volume: this.volume, activeOutputs: probe.elements.filter(audio => !audio.paused && audio.getAttribute('src')).length, subtitle: document.querySelector('[data-testid="reading-subtitle"]')?.textContent ?? '' });
        });
      }
    };
  });
}
async function snapshot(index = -1) {
  return page.evaluate(index => {
    const probe = window.__speechContinuity; const audio = index < 0 ? probe.elements.at(-1) : probe.elements[index];
    return audio ? { id: audio.__continuityId, count: probe.elements.length, time: audio.currentTime, duration: audio.duration, rate: audio.playbackRate, pitch: audio.preservesPitch, volume: audio.volume, paused: audio.paused, readyState: audio.readyState, srcPresent: !!audio.getAttribute('src') } : null;
  }, index);
}
async function audioEvents() { return page.evaluate(() => window.__speechContinuity.events); }
async function waitPlaying(index) {
  await expect.poll(async () => (await audioEvents()).some(event => event.type === 'playing' && event.id === index), { timeout: 90000 }).toBe(true);
  const state = await snapshot(index); expect(state.volume).toBe(0); expect(state.pitch).toBe(true); expect(state.readyState).toBeGreaterThanOrEqual(2);
  return state;
}
async function selectSample() {
  await page.getByRole('button', { name: /示例/ }).first().click(); await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  const span = page.locator('.textLayer span').filter({ hasText: '指数移动平均将过去' }).first(); await expect(span).toBeVisible();
  const box = await span.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 }); await page.mouse.up();
  await expect(page.locator('.selection-preview')).toContainText('指数移动平均');
}
async function enterCorrection(text, checkPreview = false) {
  await page.getByRole('button', { name: '校对朗读文本', exact: true }).click();
  await page.getByRole('textbox', { name: '确认后的朗读文本', exact: true }).fill(text);
  if (checkPreview) {
    const preview = page.getByTestId('speech-preview');
    await expect(preview).toBeVisible(); await expect(preview).toContainText('分之'); await expect(preview).not.toContainText('\\frac');
    report.formulaPreview = await preview.textContent();
    await page.screenshot({ path: artifact('formula-preview-720.png'), fullPage: false });
  }
  await page.getByRole('button', { name: '使用校对文本', exact: true }).click();
}
async function saveAudio(index, name) {
  const information = await page.evaluate(async index => {
    const probe = window.__speechContinuity; const audio = probe.elements[index]; const blob = probe.blobs.get(audio.__continuitySource);
    if (!blob) throw Error('未找到实际播放的本机音频');
    return { type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  }, index);
  const wave = Buffer.from(information.bytes); expect(wave.length).toBeGreaterThan(44);
  expect(wave.toString('ascii', 0, 4)).toBe('RIFF'); expect(wave.toString('ascii', 8, 12)).toBe('WAVE'); expect(wave.readUInt32LE(24)).toBe(24000);
  if (saveWave) await writeFile(artifact(name), wave);
  return { bytes: wave.length, contentType: information.type, ...(saveWave ? { path: artifact(name) } : {}) };
}
async function run() {
  await access(executablePath).catch(() => { throw new EnvironmentBlocked('未找到桌面包，请先 desktop:package。'); });
  await launch(); const initial = await publicSettings();
  if (!initial.qwenCudaReady) throw new EnvironmentBlocked('打包软件缺少 Qwen CUDA 运行资源；未切换 CPU 或其他声音。');
  stage = 'configure-new-profile';
  await page.getByRole('button', { name: '声音设置', exact: true }).click();
  await page.getByRole('combobox', { name: '使用方式', exact: true }).selectOption('demo');
  await page.getByRole('combobox', { name: '朗读方式', exact: true }).selectOption('qwen');
  await page.getByRole('combobox', { name: 'Qwen3 运算设备', exact: true }).selectOption('cuda');
  await page.getByRole('combobox', { name: 'Qwen3 中文音色', exact: true }).selectOption('uncle_fu');
  await page.getByRole('textbox', { name: 'Qwen3 朗读语气', exact: true }).fill('以同一位老师稳定自然的普通话朗读，按语义停顿，不扮演不同角色，不增添或改动原文。');
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  expect((await publicSettings()).restartRequired).toBe(true); await closeOwnedApp(); await launch();
  const settings = await publicSettings(); expect(settings.ttsEngine).toBe('qwen'); expect(settings.qwenTtsVoice).toBe('uncle_fu'); expect(settings.qwenTtsDevice).toBe('cuda'); expect(settings.qwenTtsReady).toBe(true);
  const config = await page.evaluate(async () => (await fetch('/api/config')).json());
  expect(config.speech).toMatchObject({ engine: 'qwen', voice: 'uncle_fu', device: 'cuda', ready: true });
  report.configuration = { mode: config.mode, ...config.speech }; report.checks.isolatedNoKeyProfile = true;
  await installAudioProbe(); await selectSample(); report.checks.realPdfSelection = true;
  await enterCorrection(sentences.join(''));
  await page.getByRole('combobox', { name: '语速', exact: true }).selectOption('1');
  await page.getByRole('slider', { name: '音量', exact: true }).fill('0');

  stage = 'natural-three-sentences-and-live-rate';
  await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  const first = await waitPlaying(0); expect(first.duration).toBeGreaterThan(10); expect(first.rate).toBe(1);
  await expect(page.getByTestId('reading-subtitle')).toHaveText(sentences[0]);
  await expect.poll(async () => (await snapshot(0)).time).toBeGreaterThan(0.5);
  for (const rate of [2, 0.5, 3]) {
    const before = await snapshot(0); const firstRequestCount = requests.filter(request => request.speechText === spoken[0]).length;
    await page.getByRole('combobox', { name: '语速', exact: true }).selectOption(String(rate));
    await expect.poll(async () => (await snapshot(0)).rate).toBe(rate);
    const after = await snapshot(0); expect(after.id).toBe(0); expect(after.count).toBe(1); expect(after.paused).toBe(false); expect(after.pitch).toBe(true);
    expect(after.time).toBeGreaterThanOrEqual(before.time); expect(requests.filter(request => request.speechText === spoken[0])).toHaveLength(firstRequestCount);
    expect(firstRequestCount).toBe(1);
    await expect.poll(async () => (await snapshot(0)).time).toBeGreaterThan(after.time + 0.15);
    await expect(page.getByTestId('reading-subtitle')).toHaveText(sentences[0]);
    report.rateChanges.push({ requestedRate: rate, before, after });
  }
  report.checks.sameAudioAndPositionThroughRateChanges = true;
  await page.screenshot({ path: artifact('rate-change-720.png'), fullPage: false });
  // Do not seek or synthesize ended events: measure actual playback reaching the sentence boundary.
  await waitPlaying(1); await expect(page.getByTestId('reading-subtitle')).toHaveText(sentences[1]);
  const timeline = await audioEvents();
  const firstEnded = timeline.find(event => event.id === 0 && event.type === 'ended');
  const secondPlaying = timeline.find(event => event.id === 1 && event.type === 'playing');
  expect(firstEnded).toBeDefined(); expect(secondPlaying).toBeDefined();
  report.naturalHandoffs.push({ from: 1, to: 2, gapMs: secondPlaying.at - firstEnded.at, precedingRate: firstEnded.rate, endedAt: firstEnded.at, playingAt: secondPlaying.at });
  expect(timeline.filter(event => event.id === 0 && event.type === 'seeking')).toEqual([]);
  await page.screenshot({ path: artifact('second-sentence-720.png'), fullPage: false });
  await waitPlaying(2); await expect(page.getByTestId('reading-subtitle')).toHaveText(sentences[2]);
  await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
  const thirdTimeline = await audioEvents();
  const secondEnded = thirdTimeline.find(event => event.id === 1 && event.type === 'ended');
  const thirdPlaying = thirdTimeline.find(event => event.id === 2 && event.type === 'playing');
  expect(secondEnded).toBeDefined();
  report.naturalHandoffs.push({ from: 2, to: 3, gapMs: thirdPlaying.at - secondEnded.at, precedingRate: secondEnded.rate, endedAt: secondEnded.at, playingAt: thirdPlaying.at });
  for (const text of spoken) {
    const matching = requests.filter(request => request.speechText === text); expect(matching).toHaveLength(1); expect(matching[0].status).toBe(200); expect(matching[0].contentType).toMatch(/^audio\/wav/);
  }
  expect(await page.evaluate(() => window.__speechContinuity.elements.filter(audio => audio.getAttribute('src')).length)).toBe(1);
  expect(await page.evaluate(() => window.__speechContinuity.elements.every(audio => audio.paused))).toBe(true);
  report.checks.threeRealSentencesAndNaturalHandoffs = true; report.checks.noDuplicateRequestsDuringRateChanges = true; report.checks.singleAudioOutput = true;
  report.audio = [];
  for (let index = 0; index < 3; index++) report.audio.push(await saveAudio(index, `sentence-${index + 1}.wav`));

  stage = 'sentence-navigation';
  const countBeforeNavigation = requests.length;
  await page.getByRole('button', { name: '上一句', exact: true }).click(); await expect(page.getByTestId('reading-subtitle')).toHaveText(sentences[1]);
  await page.getByRole('button', { name: '下一句', exact: true }).click(); await expect(page.getByTestId('reading-subtitle')).toHaveText(sentences[2]);
  expect(requests).toHaveLength(countBeforeNavigation); report.checks.previousNextSubtitleNavigation = true;
  await page.getByRole('button', { name: '停止', exact: true }).click();
  expect(await page.evaluate(() => window.__speechContinuity.elements.every(audio => audio.paused && !audio.getAttribute('src')))).toBe(true);

  stage = 'formula-preview-and-real-request';
  await enterCorrection(formula, true);
  const formulaAudioIndex = (await snapshot()).count;
  const formulaRequestCount = requests.length;
  await page.getByRole('combobox', { name: '语速', exact: true }).selectOption('1');
  await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  await expect.poll(() => requests.length, { timeout: 15000 }).toBeGreaterThan(formulaRequestCount);
  const formulaRequest = requests[formulaRequestCount]; expect(formulaRequest.speechText).toContain('分之'); expect(formulaRequest.speechText).toMatch(/[\u3400-\u9fff]/); expect(formulaRequest.speechText).not.toMatch(/\\frac|\\beta|\$|[{}]/);
  await waitPlaying(formulaAudioIndex); expect(formulaRequest.status).toBe(200);
  await expect(page.getByTestId('reading-subtitle')).toHaveText(formula);
  report.formula = { source: formula, speechText: formulaRequest.speechText, subtitle: await page.getByTestId('reading-subtitle').textContent(), audio: await saveAudio(formulaAudioIndex, 'formula.wav') };
  report.checks.formulaPreviewAndActualSpeechText = true; report.checks.originalSubtitlePreserved = true;
  await page.screenshot({ path: artifact('formula-playing-720.png'), fullPage: false });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  report.audioEvents = await audioEvents();
  expect(report.audioEvents.filter(event => event.type === 'playing').every(event => event.activeOutputs === 1)).toBe(true);
  const usage = await page.evaluate(async () => (await fetch('/api/usage')).json());
  report.usage = usage.records;
  expect(usage.records.filter(record => record.category === 'tts')).toHaveLength(4);
  expect(usage.records.every(record => record.category === 'tts' && record.local === true && !record.cancelled && /Qwen3/.test(record.model))).toBe(true);
  expect(pageErrors).toEqual([]); expect(remoteRendererRequests).toEqual([]);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  report.status = 'passed';
}
try {
  await Promise.race([run(), new Promise((_, reject) => { totalTimer = setTimeout(() => reject(Error('桌面语音连续性验收超过五分钟')), 300000); })]);
} catch (error) {
  report.status = error instanceof EnvironmentBlocked ? 'blocked' : 'failed'; report.stage = stage; report.error = error instanceof Error ? error.message : String(error);
  if (page && !page.isClosed()) {
    report.audioEvents = await audioEvents().catch(() => []);
    await page.screenshot({ path: artifact('failure-720.png'), fullPage: false, timeout: 5000 }).catch(() => {});
  }
  process.exitCode = report.status === 'blocked' ? 2 : 1;
} finally {
  stopping = true;
  clearTimeout(totalTimer);
  await closeOwnedApp().catch(error => { report.cleanupError = error.message; report.status = 'failed'; process.exitCode = 1; });
  report.elapsedMs = Date.now() - started;
  await writeFile(artifact('report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); console.log('Report: ' + artifact('report.json'));
}