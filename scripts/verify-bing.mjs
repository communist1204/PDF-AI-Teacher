import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (!process.argv.includes('--live')) throw Error('This sends one self-authored sample to Bing. Pass --live explicitly.');
const root = process.cwd();
await mkdir(resolve(root, 'test-results'), { recursive: true });
const profile = await mkdtemp(resolve(root, 'test-results/bing-profile-'));
const env = { ...process.env, SCREEN_READER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.SCREEN_READER_TEST_EXE;
const evidence = { capturedAt: new Date().toISOString(), packaged: Boolean(executablePath), provider: 'bing-translator', voice: 'zh-CN-XiaoxiaoNeural', synthesisRate: '-20.00%', realCloudCalls: false, calls: 0, userCredentials: false, humanListening: false, checks: [] };
let application;
try {
  application = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [resolve(root, 'desktop-build/main.cjs')] }), env });
  const page = await application.firstWindow();
  await page.waitForFunction(() => window.reader !== undefined);
  const settings = await page.evaluate(() => window.reader.getSettings());
  assert.equal(settings.hasApiKey, false);
  await page.getByRole('button', { name: '声音设置', exact: true }).click();
  await page.getByLabel('朗读来源').selectOption('bing');
  await page.getByLabel('允许将我主动截图', { exact: false }).check();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('已保存。设置不会自动请求声音。', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(root, 'docs/screenshots/bing-settings.png') });
  await application.evaluate(({ session }) => {
    const transport = session.fromPartition('reader-bing-network');
    const original = transport.fetch.bind(transport);
    globalThis.bingNetworkTrace = [];
    transport.fetch = async (input, init) => {
      let response;
      try { response = await original(input, init); }
      catch (error) { globalThis.bingNetworkTrace.push({ errorType: error.name, message: error.message.replace(/https?:[^\s]+/g, '[URL]') }); throw error; }
      const url = new URL(String(input));
      const location = response.headers.get('location');
      globalThis.bingNetworkTrace.push({ host: url.hostname, path: url.pathname, method: init?.method ?? 'GET', status: response.status, type: response.type, contentType: response.headers.get('content-type'), length: response.headers.get('content-length'), redirectHost: location ? new URL(location, url).hostname : null });
      return response;
    };
  });
  await page.getByRole('button', { name: '查看识别文字', exact: true }).click();
  const sample = '这是轻读的声音试听。2026年，我们把屏幕上的文字，变成自然的朗读。';
  await page.getByLabel('识别文字', { exact: true }).fill(sample);
  await page.evaluate(() => {
    const original = window.HTMLMediaElement.prototype.play;
    window.HTMLMediaElement.prototype.play = function () {
      this.muted = true; window.bingVerificationAudio = this;
      return original.call(this);
    };
  });
  const started = Date.now();
  await page.getByRole('button', { name: '朗读这段文字', exact: true }).click();
  await page.waitForFunction(() => window.bingVerificationAudio?.currentTime > 0.15, undefined, { timeout: 35000 });
  evidence.elapsedMs = Date.now() - started;
  evidence.realCloudCalls = true;
  evidence.network = await application.evaluate(() => globalThis.bingNetworkTrace);
  evidence.calls = evidence.network.filter(item => item.path === '/tfettts').length;
  evidence.characters = sample.length;
  assert.equal(evidence.calls, 1);
  await page.screenshot({ path: resolve(root, 'docs/screenshots/bing-playing.png') });
  const pausedAt = await page.evaluate(() => { window.bingVerificationAudio.pause(); return window.bingVerificationAudio.currentTime; });
  const changed = await page.evaluate(() => {
    window.bingVerificationAudio.playbackRate = 2;
    return { paused: window.bingVerificationAudio.paused, time: window.bingVerificationAudio.currentTime, rate: window.bingVerificationAudio.playbackRate, duration: window.bingVerificationAudio.duration };
  });
  assert.equal(changed.paused, true); assert.equal(changed.rate, 2); assert.ok(Math.abs(changed.time - pausedAt) < 0.06);
  assert.ok(changed.duration > 1);
  await page.evaluate(() => window.bingVerificationAudio.play());
  await page.waitForFunction(time => window.bingVerificationAudio.currentTime > time + 0.1, pausedAt);
  await page.evaluate(() => { window.bingVerificationAudio.pause(); URL.revokeObjectURL(window.bingVerificationAudio.src); });
  evidence.durationSeconds = changed.duration;
  evidence.checks.push('Real text-preview button -> ReaderAudio -> production IPC/Bing -> HTMLAudio, isolated no-key profile', 'Valid MP3 decoded by Electron HTMLAudio', 'Pause/resume and 2x change preserve current position; muted test, no subjective listening');
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.network = await application?.evaluate(() => globalThis.bingNetworkTrace).catch(() => undefined);
  evidence.error = String(error).slice(0, 1000);
  throw error;
} finally {
  await application?.close().catch(() => {});
  await writeFile(resolve(root, 'docs/bing-verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
