import { _electron as electron, expect } from '@playwright/test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { clearTimeout } from 'node:timers';

// Real packaged-app persistence check. No API/audio/PDF responses are mocked.
// Run after packaging; the application under test must implement local last-PDF restoration.
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/verify-desktop-reading-reopen.mjs [--executable <packaged.exe>]\nOpens public/sample.pdf, visits PDF page 2, writes a note, closes the native window, and restarts the same isolated test profile. The second launch must restore the PDF/page/note without choosing a file. Requires free port 4319. No API keys or paid calls. Saves 1280x720 screenshots and JSON under test-results/desktop-reading-reopen. Five-minute limit plus bounded cleanup.');
  process.exit(0);
}
const executableIndex = process.argv.indexOf('--executable');
if (executableIndex >= 0 && !process.argv[executableIndex + 1]) throw Error('--executable requires a packaged executable path');
const executablePath = resolve(executableIndex >= 0 ? process.argv[executableIndex + 1] : 'release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe');
const samplePath = resolve('public/sample.pdf');
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const profile = resolve('test-results', 'desktop-reading-reopen', runId);
const artifact = name => join(profile, name);
await mkdir(dirname(profile), { recursive: true });
await mkdir(profile); // A collision must fail, never reuse a pre-existing profile.
const env = {};
for (const [key, value] of Object.entries(process.env)) if (['systemroot', 'windir', 'systemdrive', 'comspec', 'temp', 'tmp'].includes(key.toLowerCase())) env[key] = value;
Object.assign(env, { PDF_TEACHER_DATA_DIR: profile, PDF_TEACHER_TEST_MODE: '1', DEMO_MODE: 'true' });
const note = '桌面自动恢复验收：停在 PDF 第 2 页，重开后保留这条本书笔记。' + runId;
const forbiddenRequests = [];
const remoteRequests = [];
const pageErrors = [];
const report = {
  date: new Date().toISOString(), status: 'running', executablePath, profile, samplePath,
  checks: {}, launches: [], forbiddenRequests, remoteRequests, pageErrors,
  modelAndAudio: '未测试真实模型、语音或账号：本验收只读取自制 PDF、浏览页码与本地笔记；无 Key，不发起问答、TTS、转写或实时语音。',
};
let application, page, stage = 'preflight', totalTimer, stopping = false;
const started = Date.now();
class EnvironmentBlocked extends Error {}
async function portAvailable() {
  const probe = createServer();
  await new Promise((done, reject) => {
    probe.once('error', error => reject(new EnvironmentBlocked(error.code === 'EADDRINUSE'
      ? '4319 端口已被使用；未关闭现有软件或进程。请端口空闲后再执行。'
      : '无法检查本机测试端口：' + error.code)));
    probe.listen(4319, '127.0.0.1', () => probe.close(done));
  });
}
async function launch(label) {
  if (stopping) throw Error('验收已结束，不再创建新应用。');
  await portAvailable();
  if (stopping) throw Error('验收已结束，不再创建新应用。');
  const launchedAt = Date.now();
  const instance = await electron.launch({ executablePath, args: [], env, timeout: 45000 });
  application = instance;
  if (stopping) { await instance.close(); application = undefined; throw Error('验收超时，已关闭本次启动的隔离应用。'); }
  instance.context().on('request', request => {
    const url = new URL(request.url());
    // Record only route names, never request bodies or credential-bearing query strings.
    if (/^\/api\/(?:ask|tts|speech|transcribe)(?:\/|$)/.test(url.pathname) || url.pathname.startsWith('/api/realtime')) forbiddenRequests.push({ launch: label, method: request.method(), path: url.pathname });
    if (url.protocol.startsWith('http') && !['127.0.0.1', 'localhost'].includes(url.hostname)) remoteRequests.push({ launch: label, origin: url.origin, path: url.pathname });
  });
  page = await instance.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => { if (pageErrors.length < 20) pageErrors.push({ launch: label, message: error.message }); });
  const native = await instance.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1280, 720);
    return { packaged: app.isPackaged, profile: app.getPath('userData'), windows: BrowserWindow.getAllWindows().length };
  });
  expect(native.packaged).toBe(true); expect(native.windows).toBe(1); expect(resolve(native.profile).toLowerCase()).toBe(profile.toLowerCase());
  await page.waitForLoadState('domcontentloaded'); await expect(page.locator('.teaching-route')).toBeVisible();
  const settings = await page.evaluate(() => window.desktopTeacher.getSettings());
  expect(settings.mode).toBe('demo'); expect(settings.hasApiKey).toBe(false); expect(settings.hasDoubaoApiKey).toBe(false);
  expect(settings.auth.status).toBe('signed_out'); expect(settings.auth.accounts).toEqual([]);
  const config = await page.evaluate(async () => {
    const response = await fetch('/api/config'); if (!response.ok) throw Error('无法读取隔离测试配置'); return response.json();
  });
  expect(config.mode).toBe('demo');
  report.launches.push({ label, native, elapsedToWorkspaceMs: Date.now() - launchedAt, mode: settings.mode, noApiKeys: true, signedOut: true, url: page.url() });
}
async function assertNoModelCalls() {
  const usage = await page.evaluate(async () => {
    const response = await fetch('/api/usage'); if (!response.ok) throw Error('无法读取隔离会话用量'); return response.json();
  });
  // The ledger also covers operations accepted before request listeners were attached at startup.
  expect(usage.records).toEqual([]); expect(usage.requestCount).toBe(0);
  expect(forbiddenRequests).toEqual([]); expect(remoteRequests).toEqual([]);
  return { records: usage.records.length, requestCount: usage.requestCount };
}
async function expectPageTwo() {
  await expect(page.getByRole('spinbutton', { name: 'PDF 页序号', exact: true })).toHaveValue('2', { timeout: 30000 });
  await expect(page.locator('.pdf-page')).toHaveAttribute('data-page-index', '1');
  await expect(page.locator('.pdf-scroll')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.pdf-document-title strong')).toHaveText(basename(samplePath));
  await expect(page.locator('.document-title')).toContainText('PDF 2 / 2');
  const canvas = page.locator('canvas[aria-label="PDF 第 2 页"]'); await expect(canvas).toBeVisible();
  await expect(page.locator('.textLayer')).toContainText('参数更新与学习位置');
  const rendered = await canvas.evaluate(canvas => {
    const context = canvas.getContext('2d');
    if (!context || canvas.width < 1 || canvas.height < 1) return { width: canvas.width, height: canvas.height, inkSamples: 0 };
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let inkSamples = 0;
    // Sparse real pixel sampling confirms this is a rendered page, not only an empty canvas element.
    for (let offset = 0; offset < pixels.length; offset += 4 * 17) if (pixels[offset + 3] > 0 && (pixels[offset] < 220 || pixels[offset + 1] < 220 || pixels[offset + 2] < 220)) inkSamples++;
    return { width: canvas.width, height: canvas.height, inkSamples };
  });
  expect(rendered.width).toBeGreaterThan(100); expect(rendered.height).toBeGreaterThan(100); expect(rendered.inkSamples).toBeGreaterThan(0);
  return { page: 2, fileName: await page.locator('.pdf-document-title strong').textContent(), canvas: rendered, textLayer: (await page.locator('.textLayer').innerText()).trim() };
}
async function openNotes() {
  const details = page.locator('details.notes');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  const field = page.getByRole('textbox', { name: '本书本地笔记', exact: true });
  await expect(field).toBeVisible(); await expect(field).toBeEnabled(); return field;
}
async function persistedReading() {
  return page.evaluate(async () => {
    // Read only this fresh test profile's existing learning database. Never create or alter stores.
    const databases = await window.indexedDB.databases();
    if (!databases.some(database => database.name === 'pdf-ai-teacher-learning')) return null;
    return new Promise(resolve => {
      let database, settled = false;
      const done = result => { if (settled) return; settled = true; window.clearTimeout(timer); database?.close(); resolve(result); };
      const timer = window.setTimeout(() => done(null), 2000);
      const opening = window.indexedDB.open('pdf-ai-teacher-learning');
      opening.onerror = () => done(null); opening.onblocked = () => done(null);
      opening.onsuccess = () => {
        database = opening.result;
        if (settled) { database.close(); return; }
        if (!database.objectStoreNames.contains('books')) { done(null); return; }
        const transaction = database.transaction('books', 'readonly');
        const request = transaction.objectStore('books').getAll(); let result = null;
        request.onsuccess = () => {
          const value = request.result.find(record => record.document?.fileName === 'sample.pdf');
          if (value) result = { fileName: value.document.fileName, documentId: value.document.documentId, pageIndex: value.pageIndex, note: value.note };
        };
        transaction.oncomplete = () => done(result); transaction.onabort = () => done(null); transaction.onerror = () => done(null);
      };
    });
  });
}
async function closeNativeWindow() {
  const owned = application; const child = owned.process();
  const closed = owned.waitForEvent('close', { timeout: 15000 });
  await Promise.all([closed, owned.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())]);
  await expect.poll(() => child.exitCode, { timeout: 10000 }).not.toBeNull();
  expect(child.exitCode).toBe(0);
  application = undefined; page = undefined;
  await portAvailable(); report.checks.windowCloseExitedProcessAndReleasedPort = true;
}
async function cleanup() {
  if (!application) return;
  const owned = application; const child = owned.process(); application = undefined; page = undefined;
  let timer;
  try {
    await Promise.race([owned.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('隔离应用清理超过 10 秒')), 10000); })]);
  } catch (error) {
    // Only this exact electron.launch child is eligible for emergency cleanup.
    if (child.exitCode === null) child.kill();
    throw error;
  } finally { clearTimeout(timer); }
}
async function run() {
  await access(executablePath).catch(() => { throw new EnvironmentBlocked('未找到打包软件，请先运行 desktop:package。'); });
  await access(samplePath).catch(() => { throw new EnvironmentBlocked('未找到 public/sample.pdf 自制测试材料。'); });
  await launch('initial'); report.checks.isolatedDemoNoKeys = true;
  stage = 'open-real-pdf-and-write-note';
  await page.locator('input[type="file"][aria-label="选择 PDF 文件"]').setInputFiles(samplePath);
  await expect(page.getByRole('spinbutton', { name: 'PDF 页序号', exact: true })).toHaveAttribute('max', '2');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  const pageNumber = page.getByRole('spinbutton', { name: 'PDF 页序号', exact: true });
  await pageNumber.fill('2'); await pageNumber.press('Enter');
  report.beforeClose = await expectPageTwo();
  const notes = await openNotes(); await notes.fill(note); await expect(notes).toHaveValue(note);
  // Observe the application's actual async save instead of relying on a blind sleep or writing a record ourselves.
  await expect.poll(persistedReading, { timeout: 15000 }).toMatchObject({ fileName: 'sample.pdf', pageIndex: 1, note });
  report.persistedBeforeClose = await persistedReading(); report.beforeUsage = await assertNoModelCalls();
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await page.screenshot({ path: artifact('before-close-720.png'), fullPage: false });
  report.checks.realPdfCanvasAndTextLayer = true; report.checks.pageTwoAndNoteSaved = true;

  stage = 'close-native-window';
  await closeNativeWindow();
  stage = 'automatic-reopen';
  await launch('reopened');
  // No open button, sample button, setInputFiles, page navigation or record injection after this launch.
  report.afterReopen = await expectPageTwo();
  expect(report.afterReopen.textLayer).toBe(report.beforeClose.textLayer);
  const restoredNotes = await openNotes(); await expect(restoredNotes).toHaveValue(note);
  report.persistedAfterReopen = await persistedReading();
  expect(report.persistedAfterReopen).toMatchObject(report.persistedBeforeClose);
  report.afterUsage = await assertNoModelCalls();
  await expect(page.locator('.error-banner')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: artifact('automatic-reopen-720.png'), fullPage: false });
  report.checks.automaticallyOpenedSamePdf = true; report.checks.restoredLastViewedPageWithoutNavigation = true;
  report.checks.noteRestored = true; report.checks.noAskSpeechTranscriptionOrRealtimeRequests = true;
  report.checks.actual720pScreenshots = true; report.status = 'passed';
}
try {
  await Promise.race([run(), new Promise((_, reject) => { totalTimer = setTimeout(() => reject(Error('桌面阅读恢复验收超过五分钟')), 300000); })]);
} catch (error) {
  stopping = true; report.status = error instanceof EnvironmentBlocked ? 'blocked' : 'failed'; report.stage = stage;
  report.error = error instanceof Error ? error.message : String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: artifact('failure-720.png'), fullPage: false, timeout: 5000 }).catch(() => {});
  process.exitCode = report.status === 'blocked' ? 2 : 1;
} finally {
  stopping = true; clearTimeout(totalTimer);
  await cleanup().catch(error => { report.cleanupError = error.message; report.status = 'failed'; process.exitCode = 1; });
  report.elapsedMs = Date.now() - started;
  await writeFile(artifact('report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); console.log('Report: ' + artifact('report.json'));
}