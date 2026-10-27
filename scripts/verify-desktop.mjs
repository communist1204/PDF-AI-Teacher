import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
await mkdir(resolve(root, 'test-results'), { recursive: true });
await mkdir(resolve(root, 'docs/screenshots'), { recursive: true });
const profile = await mkdtemp(resolve(root, 'test-results/desktop-profile-'));
const env = { ...process.env, SCREEN_READER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.SCREEN_READER_TEST_EXE;
const launch = () => electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [resolve(root, 'desktop-build/main.cjs')] }), env });
const evidence = { capturedAt: new Date().toISOString(), packaged: Boolean(executablePath), realCloudCalls: false, humanListening: false, checks: [] };
let application, page;
try {
  application = await launch();
  page = await application.firstWindow();
  await page.getByRole('button', { name: '截图朗读', exact: true }).waitFor();
  await page.waitForFunction(() => window.reader !== undefined);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const settings = await page.evaluate(() => window.reader.getSettings());
  assert.equal(settings.hasVisionKey, false); assert.equal(settings.preferences.allowVisionCloud, false);
  assert.equal(settings.hasApiKey, false); assert.equal(settings.preferences.allowCloud, false);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  evidence.checks.push('Isolated profile; no real key; cloud off; renderer has no Node access');
  await page.screenshot({ path: resolve(root, 'docs/screenshots/toolbar.png') });
  await page.getByRole('button', { name: '声音设置', exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).waitFor();
  await page.screenshot({ path: resolve(root, 'docs/screenshots/settings.png') });
  await page.getByLabel('朗读来源').selectOption('bing');
  assert.equal(await page.getByLabel('允许将我主动截图', { exact: false }).isChecked(), false);
  await page.getByRole('button', { name: '保存并试听这段声音' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(root, 'docs/screenshots/bing-settings.png') });
  await page.getByLabel('识别方式').selectOption('smart');
  await page.getByLabel('OpenAI 看图 API Key', { exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.getByLabel('允许将我主动框选的图片', { exact: false }).isChecked(), false);
  await page.screenshot({ path: resolve(root, 'docs/screenshots/vision-settings.png') });
  await page.getByLabel('识别方式').selectOption('local');
  await page.getByLabel('朗读来源').selectOption('doubao');
  await page.getByRole('button', { name: '收起面板', exact: true }).click();
  await page.getByLabel('朗读速度', { exact: true }).selectOption('1.5');
  await page.waitForFunction(async () => (await window.reader.getSettings()).preferences.rate === 1.5);
  evidence.checks.push('Settings panel opens; speed 1.5x saves without requesting speech');

  // Only self-authored verification text is captured. No external app content is used.
  const fixtureId = await application.evaluate(async ({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().bounds;
    const fixture = new BrowserWindow({ ...area, frame: false, alwaysOnTop: true, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    fixture.setAlwaysOnTop(true, 'screen-saver');
    await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="margin:80px;font:36px Microsoft YaHei,Segoe UI,sans-serif;line-height:1.8;background:white;color:black"><h1 style="font-size:42px">截图朗读验收</h1><p>这是我们自己编写的测试文字。</p><p>2026年，我们学习新的知识。</p><p>读到这里，可以暂停，然后继续。</p><p>Screen reader verification.</p></body></html>'));
    fixture.show(); fixture.focus();
    return fixture.id;
  });
  async function captureFixture() {
    const began = Date.now();
    await page.getByRole('button', { name: '截图朗读', exact: true }).evaluate(button => button.click());
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().endsWith('/capture.html') && w.isVisible()).length), { timeout: 15000 }).toBeGreaterThan(0);
    const overlay = application.windows().find(p => p.url().endsWith('/capture.html'));
    assert.ok(overlay);
    await overlay.waitForFunction(() => document.body.dataset.ready === 'true' && document.querySelector('#screen').complete && document.querySelector('#screen').naturalWidth > 0);
    evidence.captureReadyMs ??= []; evidence.captureReadyMs.push(Date.now() - began);
    return overlay;
  }
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().endsWith('/capture.html')).length)).toBeGreaterThan(0);
  const poolIds = await application.evaluate(({ BrowserWindow }) => {
    globalThis.captureShowChecks = [];
    const windows = BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().endsWith('/capture.html'));
    for (const w of windows) w.on('show', () => { void w.webContents.executeJavaScript("({ready:document.body.dataset.ready,decoded:document.querySelector('#screen').complete&&document.querySelector('#screen').naturalWidth>0})").then(value => globalThis.captureShowChecks.push(value)); });
    return windows.map(w => w.id);
  });
  const overlay = await captureFixture();
  await overlay.screenshot({ path: resolve(root, 'test-results/capture-overlay.png') });
  await overlay.mouse.move(60, 60); await overlay.mouse.down(); await overlay.mouse.move(1000, 570, { steps: 15 }); await overlay.mouse.up();
  await page.getByRole('heading', { name: '声音与设置', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '查看识别文字', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#recognized-text')?.value.includes('2026'), undefined, { timeout: 30000 });
  const text = await page.locator('#recognized-text').inputValue();
  assert.match(text, /2026/); assert.match(text, /测试文字|测试.*文字/);
  evidence.checks.push('Real screen crop -> local Windows OCR recognized authored Chinese text and year');
  evidence.ocrText = text;
  await page.screenshot({ path: resolve(root, 'docs/screenshots/recognized-text.png') });
  await application.evaluate(async ({ BrowserWindow }, id) => {
    const fixture = BrowserWindow.fromId(id);
    await fixture.webContents.executeJavaScript("document.body.innerHTML='<h1>第二次截图验收</h1><p>2031年，这是更新后的测试文字。</p><p>旧截图不会再次出现。</p>'");
    fixture.show(); fixture.focus();
  }, fixtureId);
  const repeated = await captureFixture();
  await repeated.mouse.move(60, 60); await repeated.mouse.down(); await repeated.mouse.move(1000, 570, { steps: 8 }); await repeated.mouse.up();
  await page.getByRole('heading', { name: '声音与设置', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '查看识别文字', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#recognized-text')?.value.includes('2031'), undefined, { timeout: 30000 });
  assert.ok(!(await page.locator('#recognized-text').inputValue()).includes('2026'));
  const currentPool = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().endsWith('/capture.html')).map(w => w.id));
  assert.deepEqual(currentPool, poolIds);
  await page.getByRole('button', { name: '收起面板', exact: true }).click();
  const cancelledOverlay = await captureFixture();
  await cancelledOverlay.keyboard.press('Escape');
  await page.getByText('已取消截图', { exact: true }).waitFor();
  await cancelledOverlay.waitForFunction(() => !document.querySelector('#screen').hasAttribute('src'));
  const showChecks = await application.evaluate(() => globalThis.captureShowChecks);
  assert.ok(showChecks.length >= 3); assert.ok(showChecks.every(value => value.ready === 'true' && value.decoded));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().endsWith('/capture.html') && w.isVisible()).length), 0);
  evidence.checks.push('Warm blank overlays reused for fresh captures; every show had decoded image; Esc hides overlays and clears image');
  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), fixtureId);
  // Exercise the real HTMLAudio element with generated silence, never a cloud request.
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('reader:begin-speech'); ipcMain.handle('reader:begin-speech', () => {});
    globalThis.verificationSpeechCalls = 0;
    ipcMain.removeHandler('reader:speak'); ipcMain.handle('reader:speak', (_event, request) => {
      globalThis.verificationSpeechCalls++;
      const wave = Buffer.alloc(44 + 24000 * 2 * 12);
      wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
      wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
      wave.writeUInt32LE(24000, 24); wave.writeUInt32LE(48000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
      wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
      return { generationId: request.generationId, chunkId: request.chunkId, audio: new Uint8Array(wave) };
    });
  });
  await page.evaluate(async () => {
    const settings = await window.reader.getSettings();
    await window.reader.saveSettings({ preferences: { ...settings.preferences, allowCloud: true }, apiKey: 'offline-verification-not-a-real-key' });
  });
  await page.reload();
  await page.waitForFunction(() => window.reader !== undefined);
  await page.evaluate(() => {
    const original = window.HTMLMediaElement.prototype.play;
    window.HTMLMediaElement.prototype.play = function () { window.verificationAudio = this; return original.call(this); };
  });
  await page.getByRole('button', { name: '查看识别文字', exact: true }).click();
  await page.getByLabel('识别文字', { exact: true }).fill('第一段用来确认我们可以回到刚才听过的内容，现在请认真听这句话，稍后可以点击按钮重听。第二段提供一段足够长的测试内容，以确认前进回退时播放器使用已经准备好的音频，文字不需要重新截图识别。');
  await page.getByRole('button', { name: '朗读这段文字', exact: true }).click();
  await page.waitForFunction(() => window.verificationAudio?.currentTime > 0.15);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const pausedAt = await page.evaluate(() => window.verificationAudio.currentTime);
  await page.getByLabel('朗读速度', { exact: true }).selectOption('3');
  const afterRate = await page.evaluate(() => ({ paused: window.verificationAudio.paused, time: window.verificationAudio.currentTime, rate: window.verificationAudio.playbackRate }));
  assert.equal(afterRate.paused, true); assert.equal(afterRate.rate, 3); assert.ok(Math.abs(afterRate.time - pausedAt) < 0.06);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.waitForFunction(time => window.verificationAudio.currentTime > time + 0.1, pausedAt);
  const requests = await application.evaluate(() => globalThis.verificationSpeechCalls);
  await page.getByRole('button', { name: '下一段', exact: true }).click();
  await expect(page.locator('.segment-position')).toHaveText('2 / 2 段');
  await page.waitForFunction(() => window.verificationAudio.currentTime > 0.1);
  await page.getByRole('button', { name: '上一段', exact: true }).click();
  await expect(page.locator('.segment-position')).toHaveText('1 / 2 段');
  await page.getByRole('button', { name: '重听本段', exact: true }).click();
  await page.waitForFunction(() => window.verificationAudio.currentTime > 0.1);
  assert.equal(await application.evaluate(() => globalThis.verificationSpeechCalls), requests);
  await page.getByRole('button', { name: '收起面板', exact: true }).click();
  await page.screenshot({ path: resolve(root, 'docs/screenshots/replay-toolbar.png') });
  evidence.checks.push('Real HTMLAudio previous/next/replay preserve rate and reuse existing audio with no new synthesis');
  await page.getByRole('button', { name: '停止朗读', exact: true }).click();
  assert.equal(await page.evaluate(() => window.verificationAudio.paused), true);
  await page.evaluate(async () => { const settings = await window.reader.getSettings(); await window.reader.saveSettings({ preferences: { ...settings.preferences, allowCloud: false, rate: 1.5 }, clearApiKey: true }); });
  evidence.checks.push('Real HTMLAudio decoded synthetic WAV; pause/resume and 3x rate preserve position; stop works (mock synthesis, no cloud)');
  assert.deepEqual(errors, []);
  await application.close(); application = undefined;
  application = await launch(); page = await application.firstWindow();
  await page.waitForFunction(async () => window.reader && (await window.reader.getSettings()).preferences.rate === 1.5);
  assert.equal((await page.evaluate(() => window.reader.getSettings())).hasApiKey, false);
  evidence.checks.push('Encrypted settings survive restart; no credential inherited by test profile');
  evidence.status = 'passed';
} catch (error) { evidence.status = 'failed'; evidence.error = String(error); await page?.screenshot({ path: resolve(root, 'test-results/desktop-failure.png') }).catch(() => {}); throw error; }
finally {
  await application?.close().catch(() => {});
  await writeFile(resolve(root, executablePath ? 'docs/packaged-verification.json' : 'docs/desktop-verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
