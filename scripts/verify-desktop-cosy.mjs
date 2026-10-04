/* global MediaSource */
import { _electron as electron, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';

// Explicit real local model test. Separate profile: never reads user credentials.
const profile = resolve('test-results', `cosy-desktop-${Date.now()}`);
const env = { ...process.env, PDF_TEACHER_DATA_DIR: profile, PDF_TEACHER_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const options = { executablePath: resolve('release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe'), args: [], env, timeout: 45000 };
let app;
const errors = [];
const finished = [];
async function launch() {
  app = await electron.launch(options);
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfinished', request => { if (request.url().endsWith('/api/tts')) finished.push({at:Date.now(),stream:request.headers()['x-audio-stream'],characters:request.postDataJSON()?.text?.length}); });
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.teaching-route')).toContainText('打字提问');
  return page;
}
async function observe(page) {
  return page.evaluate(() => {
    const s = window.__cosyProbe;
    return { events: s.events, count: s.audios.length, active: s.audios.filter(a => !a.paused).length,
      time: s.audios.at(-1)?.currentTime ?? 0, rate: s.audios.at(-1)?.playbackRate,
      paused: s.audios.at(-1)?.paused };
  });
}
try {
  let page = await launch();
  await page.getByRole('button', { name: '设置与用量', exact: true }).click();
  await page.getByRole('combobox', { name: '朗读方式', exact: true }).selectOption('cosy');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  expect((await page.evaluate(() => window.desktopTeacher.getSettings())).ttsEngine).toBe('cosy');
  await app.close(); app = undefined;
  page = await launch();
  await page.evaluate(() => {
    const s = { audios: [], events: [] }; window.__cosyProbe = s;
    const Native = window.Audio;
    window.Audio = class extends Native {
      constructor(src) {
        super(src); const index = s.audios.length; s.audios.push(this);
        for (const type of ['playing', 'waiting', 'ended', 'pause', 'error']) this.addEventListener(type, () => s.events.push({ type, index, at: Date.now(), position: this.currentTime }));
      }
    };
  });
  await page.getByRole('button', { name: /示例/ }).first().click();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '选本页文字', exact: true }).click();
  await page.getByRole('button', { name: '校对朗读文本', exact: true }).click();
  await page.getByRole('textbox', { name: '确认后的朗读文本', exact: true }).fill('学习一个新概念时，不必一口气记住所有细节，先想清楚它要解决什么问题，再看每一步用了哪些已知信息，比如注意力机制允许模型根据当前的问题，从不同位置选择有用的内容，权重大的部分影响更多，权重小的部分影响更少。下一句继续用同一个声音，把输入、输出和中间的变化连起来理解。');
  await page.getByRole('button', { name: '使用校对文本', exact: true }).click();
  await page.getByRole('combobox', { name: '语速', exact: true }).selectOption('1');
  const clicked = Date.now();
  await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  await expect.poll(async () => (await observe(page)).time, { timeout: 180000 }).toBeGreaterThan(0.3);
  const first = await observe(page);
  const firstPlaying = first.events.find(e => e.type === 'playing').at;
  const firstStreamDone = finished.find(item => item.stream === '1');
  const playingBeforeFirstRequestDone = !firstStreamDone || firstPlaying < firstStreamDone.at;
  console.log(JSON.stringify({first,finished,clicked,playingBeforeFirstRequestDone,supportsMse:await page.evaluate(()=>MediaSource.isTypeSupported('audio/mpeg'))}));
  expect(playingBeforeFirstRequestDone).toBe(true);
  await expect.poll(async () => (await observe(page)).events.filter(e => e.type === 'ended').length, { timeout: 90000 }).toBe(2);
  const continuous = await observe(page);
  const midAudioWaits = continuous.events.filter(e => e.type === 'waiting' && e.position > 0.1);
  await page.getByRole('button', { name: '朗读所选', exact: true }).click();
  await expect.poll(async () => (await observe(page)).time).toBeGreaterThan(0.2);
  await page.getByRole('button', { name: '下一句', exact: true }).click();
  await expect(page.getByRole('button', { name: '上一句', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '上一句', exact: true }).click();
  await expect.poll(async () => (await observe(page)).time).toBeGreaterThan(0.2);
  const before = await observe(page);
  await page.getByRole('combobox', { name: '语速', exact: true }).selectOption('3');
  const faster = await observe(page); expect(faster.rate).toBe(3); expect(faster.count).toBe(before.count); expect(faster.time).toBeGreaterThanOrEqual(before.time);
  await page.getByRole('button', { name: '暂停朗读', exact: true }).click();
  const paused = await observe(page);
  await page.getByRole('combobox', { name: '语速', exact: true }).selectOption('0.25');
  expect(await observe(page)).toMatchObject({ paused: true, rate: 0.25, time: paused.time, count: paused.count });
  await page.getByRole('button', { name: '继续朗读', exact: true }).click();
  await expect.poll(async () => (await observe(page)).time).toBeGreaterThan(paused.time);
  const stopped = Date.now();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  expect((await observe(page)).active).toBe(0);
  const stopMs = Date.now() - stopped;
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/cosy-local-reference-reading.png', fullPage: true });
  await page.getByRole('button', { name: '设置与用量', exact: true }).click();
  await expect(page.getByTestId('cosy-speech-status')).toContainText('模型已加载');
  await page.getByTestId('cosy-speech-status').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/cosy-local-reference-reading-settings.png', fullPage: true });
  expect(errors).toEqual([]);
  const result = { date: new Date().toISOString(), kind: 'real-packaged-Electron-local-GPU-reference-reading', voice: 'local_longanyang', coldClickToPlayingMs: firstPlaying - clicked,
    playingBeforeFirstRequestDone, firstPlayingAt: firstPlaying, requestFinishedAt: finished, midAudioWaits, events: continuous.events,
    sentenceCount: 2, rateChangesPreserveAudio: true, pauseResume: true, previousSentence: true, stopMs, pageErrors: errors,
    cloudRequests: false, humanListening: '未测；这里只验证真实合成、播放事件与调度' };
  await writeFile('docs/cosy-local-reference-reading-verification.json', JSON.stringify(result, null, 2) + '\n');
  expect(midAudioWaits).toEqual([]);
  console.log(JSON.stringify(result, null, 2));
} finally { await app?.close(); }
