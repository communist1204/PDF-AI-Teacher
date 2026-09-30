import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

const readerDatabase = 'pdf-ai-teacher-reader';
const readerStore = 'last-pdf';
const viewKey = 'pdf-ai-teacher:last-view';

type SavedBook = { document: { documentId: string; fileName: string }; pageIndex: number; note: string };
type ReadingProbe = { delayed: boolean; released: boolean; release?: () => void; speaks: number; audioPlays: number };

async function savedBooks(page: Page): Promise<SavedBook[]> {
  return page.evaluate(() => new Promise<SavedBook[]>((resolve, reject) => {
    const open = indexedDB.open('pdf-ai-teacher-learning');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('books')) { db.close(); resolve([]); return; }
      const tx = db.transaction('books'); const request = tx.objectStore('books').getAll();
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}

async function cachedBook(page: Page): Promise<{ documentId: string; fileName: string; bytes: number } | null> {
  return page.evaluate(({ database, store }) => new Promise<{ documentId: string; fileName: string; bytes: number } | null>((resolve, reject) => {
    const open = indexedDB.open(database);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(store)) { db.close(); resolve(null); return; }
      const tx = db.transaction(store); const request = tx.objectStore(store).get('last');
      tx.oncomplete = () => {
        const value = request.result as { documentId: string; fileName: string; blob: Blob } | undefined;
        db.close(); resolve(value ? { documentId: value.documentId, fileName: value.fileName, bytes: value.blob.size } : null);
      };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { database: readerDatabase, store: readerStore });
}

async function ready(page: Page, displayedPage: number, pageCount = 2) {
  await expect(page.getByRole('spinbutton', { name: 'PDF 页序号' })).toHaveAttribute('max', String(pageCount));
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('spinbutton', { name: 'PDF 页序号' })).toHaveValue(String(displayedPage));
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  await expect(page.locator('.document-title')).toContainText(`PDF ${displayedPage} / ${pageCount}`);
}

async function uploadSample(page: Page) {
  await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles('public/sample.pdf');
  await ready(page, 1);
}

async function writeNote(page: Page, text: string) {
  if (!(await page.locator('.notes').evaluate(element => (element as HTMLDetailsElement).open))) await page.locator('.notes summary').click();
  await page.getByRole('textbox', { name: '本书本地笔记', exact: true }).fill(text);
}

async function noteValue(page: Page, value: string) {
  if (!(await page.locator('.notes').evaluate(element => (element as HTMLDetailsElement).open))) await page.locator('.notes summary').click();
  await expect(page.getByRole('textbox', { name: '本书本地笔记', exact: true })).toHaveValue(value);
}

async function otherPdf() {
  const pdf = await PDFDocument.load(await readFile('public/sample.pdf'));
  pdf.removePage(0);
  return { name: 'sample.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const probe: ReadingProbe = { delayed: false, released: false, speaks: 0, audioPlays: 0 };
    Object.defineProperty(window, '__readingProbe', { value: probe });
    const speak = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = utterance => { probe.speaks++; speak(utterance); };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { probe.audioPlays++; return play.call(this); };
  });
});

test('上传真实 PDF 后刷新自动回到第 2 页，保留笔记且不自动调用模型或发声', async ({ page }, testInfo) => {
  const requests: string[] = [];
  page.on('request', request => { if (/\/api\/(?:ask|tts|transcribe|realtime)(?:[/?]|$)/.test(request.url())) requests.push(request.url()); });
  await page.goto('/'); await uploadSample(page);
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await ready(page, 2);
  await writeNote(page, '下次继续学习参数更新。');
  await expect.poll(async () => (await cachedBook(page))?.bytes ?? 0).toBeGreaterThan(0);
  await expect.poll(async () => (await savedBooks(page))[0]?.note).toBe('下次继续学习参数更新。');
  // Make the synchronous view newer than both learning snapshots. Startup should
  // use the last viewed page without losing the older book notes.
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('pdf-ai-teacher-learning'); open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result; const tx = db.transaction('books', 'readwrite'); const store = tx.objectStore('books'); const request = store.getAll();
        request.onsuccess = () => { for (const value of request.result) store.put({ ...value, pageIndex: 0 }); };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    for (const key of Object.keys(localStorage)) if (key.startsWith('pdf-ai-teacher-recovery:')) {
      const record = JSON.parse(localStorage.getItem(key)!); localStorage.setItem(key, JSON.stringify({ ...record, pageIndex: 0 }));
    }
  });
  // An abrupt navigation can leave the older IndexedDB record behind. Suppress
  // only this test's pagehide flush so the real startup precedence is exercised.
  await page.evaluate(() => window.addEventListener('pagehide', event => event.stopImmediatePropagation(), { capture: true }));
  await page.reload(); await ready(page, 2); await noteValue(page, '下次继续学习参数更新。');
  expect(await page.evaluate(() => {
    const probe = (window as unknown as { __readingProbe: ReadingProbe }).__readingProbe;
    return { speaks: probe.speaks, audioPlays: probe.audioPlays };
  })).toEqual({ speaks: 0, audioPlays: 0 });
  expect(requests).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: testInfo.outputPath('reading-reopened-720.png'), fullPage: true });
});

test('关闭启动恢复会清除 PDF 缓存，刷新不再打开书但手动重开仍保留页码和笔记', async ({ page }, testInfo) => {
  await page.goto('/'); await uploadSample(page);
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await ready(page, 2);
  await writeNote(page, '关闭 PDF 缓存不会删除这条笔记。');
  await expect.poll(async () => (await savedBooks(page))[0]?.note).toBe('关闭 PDF 缓存不会删除这条笔记。');
  await expect.poll(async () => (await cachedBook(page))?.bytes ?? 0).toBeGreaterThan(0);
  await page.getByRole('button', { name: '设置与用量', exact: true }).click();
  const restore = page.getByRole('checkbox', { name: '启动时恢复上次的书和页码', exact: true });
  await expect(restore).toBeChecked(); await restore.click(); await expect(restore).toBeEnabled(); await expect(restore).not.toBeChecked();
  await expect.poll(() => cachedBook(page)).toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), viewKey)).toBeNull();
  expect((await savedBooks(page))[0]?.note).toBe('关闭 PDF 缓存不会删除这条笔记。');
  await page.setViewportSize({ width: 1280, height: 720 }); await restore.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('reading-restore-disabled-720.png'), fullPage: true });
  await page.reload();
  await expect(page.getByRole('heading', { name: '把教材放在这里', exact: true })).toBeVisible();
  await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles('public/sample.pdf');
  await ready(page, 2); await noteValue(page, '关闭 PDF 缓存不会删除这条笔记。');
  expect(await cachedBook(page)).toBeNull();
});

test('同名不同内容的 PDF 按内容指纹恢复，最新一本书不会套用前一本的页码和笔记', async ({ page }) => {
  await page.goto('/'); await uploadSample(page);
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await ready(page, 2);
  await writeNote(page, '两页原书的独立笔记。');
  await expect.poll(async () => (await savedBooks(page))[0]?.note).toBe('两页原书的独立笔记。');
  const first = (await savedBooks(page))[0];
  await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles(await otherPdf());
  await ready(page, 1, 1); await noteValue(page, '');
  await writeNote(page, '同名的一页书。');
  await expect.poll(async () => (await savedBooks(page)).find(book => book.document.documentId !== first.document.documentId)?.note).toBe('同名的一页书。');
  const second = (await savedBooks(page)).find(book => book.document.documentId !== first.document.documentId)!;
  await expect.poll(async () => (await cachedBook(page))?.documentId).toBe(second.document.documentId);
  await page.reload(); await ready(page, 1, 1); await noteValue(page, '同名的一页书。');
  await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles('public/sample.pdf');
  await ready(page, 2); await noteValue(page, '两页原书的独立笔记。');
});

test('启动时缓存读取迟到，用户手选的新 PDF 保持优先并成为下次恢复目标', async ({ page }) => {
  await page.goto('/'); await uploadSample(page);
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await ready(page, 2);
  await expect.poll(async () => (await cachedBook(page))?.bytes ?? 0).toBeGreaterThan(0);
  const previous = (await cachedBook(page))!.documentId;
  await page.addInitScript(() => {
    let armed = true; const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (query: IDBValidKey | IDBKeyRange) {
      const request = get.call(this, query);
      if (armed && this.name === 'last-pdf' && this.transaction.mode === 'readonly' && query === 'last') {
        armed = false; const tx = this.transaction;
        request.addEventListener('success', () => {
          const complete = tx.oncomplete;
          tx.oncomplete = function (event) {
            const probe = (window as unknown as { __readingProbe: ReadingProbe }).__readingProbe;
            probe.delayed = true;
            probe.release = () => { probe.released = true; complete?.call(tx, event); };
          };
        });
      }
      return request;
    };
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __readingProbe: ReadingProbe }).__readingProbe.delayed)).toBe(true);
  await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles(await otherPdf()); await ready(page, 1, 1);
  await writeNote(page, '启动期间主动换书。');
  await page.evaluate(() => (window as unknown as { __readingProbe: ReadingProbe }).__readingProbe.release!());
  await expect.poll(async () => (await cachedBook(page))?.documentId).not.toBe(previous);
  await ready(page, 1, 1); await noteValue(page, '启动期间主动换书。');
  await expect.poll(async () => (await savedBooks(page)).find(book => book.document.documentId !== previous)?.note).toBe('启动期间主动换书。');
  // The delayed callback has resolved; a second navigation proves it did not
  // replace the recent book behind the visible reader.
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __readingProbe: ReadingProbe }).__readingProbe.delayed)).toBe(true);
  await page.evaluate(() => (window as unknown as { __readingProbe: ReadingProbe }).__readingProbe.release!());
  await ready(page, 1, 1); await noteValue(page, '启动期间主动换书。');
});

test('最近 PDF 写入配额不足时仍能阅读和保存学习记录，明确提示下次需手动打开', async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'last-pdf') throw new DOMException('PDF cache quota exceeded', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await page.goto('/'); await uploadSample(page);
  await expect(page.getByRole('status').filter({ hasText: '无法保存上次的书' })).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await ready(page, 2);
  await writeNote(page, 'PDF 缓存失败，学习笔记仍然保存。');
  await expect.poll(async () => (await savedBooks(page))[0]?.note).toBe('PDF 缓存失败，学习笔记仍然保存。');
  await expect.poll(async () => (await savedBooks(page))[0]?.pageIndex).toBe(1);
  expect(await cachedBook(page)).toBeNull();
  await page.reload(); await expect(page.getByRole('heading', { name: '把教材放在这里', exact: true })).toBeVisible();
  await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles('public/sample.pdf');
  await ready(page, 2); await noteValue(page, 'PDF 缓存失败，学习笔记仍然保存。');
});
