// Real Electron screen capture + Windows OCR using only an original on-screen fixture.
import { _electron as electron, expect } from '@playwright/test';
import electronPath from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const packaged = process.argv.includes('--packaged');
const env = { ...process.env, PDF_TEACHER_DATA_DIR: resolve('test-results', 'screen-capture-' + Date.now()), PDF_TEACHER_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath: packaged ? resolve('release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe') : electronPath, args: packaged ? [] : [resolve('desktop-build')], env, timeout: 45000 });
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('button', { name: '声音设置', exact: true })).toBeVisible();
  const bounds = await app.evaluate(async ({ BrowserWindow, screen }) => {
    const display = screen.getPrimaryDisplay();
    const win = new BrowserWindow({ x: display.workArea.x + 30, y: display.workArea.y + 30, width: Math.min(1040, display.workArea.width - 60), height: 420, frame: false, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html lang="zh-CN"><body style="margin:30px;font:28px/1.8 Microsoft YaHei,sans-serif;background:white;color:black"><div id="fixture">截图朗读测试。神经网络可以学习数据中的规律。<br>2026年，我们一起学习。<br>Deep learning helps us understand patterns.</div></body></html>'));
    win.show();
    return { display: display.bounds, scaleFactor: display.scaleFactor, fixture: win.getBounds() };
  });
  const capturePromise = page.evaluate(() => window.desktopTeacher.screenReading.capture());
  const deadline = Date.now() + 15000;
  let overlay;
  while (Date.now() < deadline) {
    overlay = app.windows().find(win => !win.isClosed() && win.url().endsWith('/capture.html'));
    if (overlay) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!overlay) throw Error('Screen selection overlay did not open');
  await expect(overlay.locator('#screen')).toHaveJSProperty('complete', true);
  await expect(overlay.locator('#screen')).not.toHaveJSProperty('naturalWidth', 0);
  const x = bounds.fixture.x - bounds.display.x + 10, y = bounds.fixture.y - bounds.display.y + 10;
  await overlay.mouse.move(x, y); await overlay.mouse.down(); await overlay.mouse.move(x + bounds.fixture.width - 20, y + 250, { steps: 10 }); await overlay.mouse.up();
  const capture = await capturePromise; expect(capture).not.toBeNull();
  await mkdir('docs/screenshots', { recursive: true });
  await writeFile('docs/screenshots/screen-capture-ocr-fixture.png', Buffer.from(capture.imageDataUrl.split(',')[1], 'base64'));
  const started = Date.now();
  const recognized = await page.evaluate(id => window.desktopTeacher.screenReading.recognize(id), capture.id);
  expect(recognized.text).toContain('神经网络可以学习数据中的规律'); expect(recognized.text).toContain('Deep learning');
  const staleRejected = await page.evaluate(async id => { try { await window.desktopTeacher.screenReading.recognize(id); return false; } catch { return true; } }, capture.id);
  expect(staleRejected).toBe(true);
  const cancelledPromise = page.evaluate(() => window.desktopTeacher.screenReading.capture());
  await expect.poll(() => app.windows().filter(win => win !== overlay && !win.isClosed() && win.url().endsWith('/capture.html')).length).toBeGreaterThan(0);
  const cancelWindow = app.windows().find(win => win !== overlay && !win.isClosed() && win.url().endsWith('/capture.html'));
  await expect(cancelWindow.locator('#hint')).toBeVisible();
  await cancelWindow.keyboard.press('Escape').catch(error => { if (!/Target page, context or browser has been closed/.test(String(error))) throw error; });
  expect(await cancelledPromise).toBeNull();
  const restored = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))?.isVisible());
  expect(restored).toBe(true);
  const priorWindows = new Set(app.windows());
  await page.getByRole('button', { name: '截图识字', exact: true }).click();
  await expect.poll(() => app.windows().filter(win => !priorWindows.has(win) && !win.isClosed() && win.url().endsWith('/capture.html')).length).toBeGreaterThan(0);
  const uiOverlay = app.windows().find(win => !priorWindows.has(win) && !win.isClosed() && win.url().endsWith('/capture.html'));
  await expect(uiOverlay.locator('#screen')).not.toHaveJSProperty('naturalWidth', 0);
  await uiOverlay.mouse.move(x, y); await uiOverlay.mouse.down(); await uiOverlay.mouse.move(x + bounds.fixture.width - 20, y + 250, { steps: 10 });
  await uiOverlay.mouse.up().catch(error => { if (!/Target page, context or browser has been closed/.test(String(error))) throw error; });
  await expect(page.getByRole('textbox', { name: '截图识别文字', exact: true })).toHaveValue(/神经网络可以学习数据中的规律/);
  await page.screenshot({ path: 'docs/screenshots/screen-capture-desktop-panel.png', fullPage: true });
  await page.getByRole('button', { name: '关闭截图识字', exact: true }).click();
  const record = { date: new Date().toISOString(), kind: packaged ? 'packaged-screen-capture-ocr' : 'development-screen-capture-ocr', displayScaleFactor: bounds.scaleFactor, cropPixels: { width: capture.width, height: capture.height }, elapsedMs: Date.now() - started, recognition: recognized, staleCaptureRejected: staleRejected, escapeCancels: true, mainWindowRestored: true, realCloudTts: '未调用', screenshotPersisted: 'Only original verification fixture saved by test; product does not save screenshots' };
  await writeFile('docs/screen-capture-verification.json', JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record, null, 2));
} finally { await app?.close(); }
