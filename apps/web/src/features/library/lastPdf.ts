import { DocumentIdSchema } from '../../../../../packages/shared/learning';

export const LAST_PDF_DATABASE = 'pdf-ai-teacher-reader';
export const LAST_PDF_STORE = 'last-pdf';
export const LAST_VIEW_KEY = 'pdf-ai-teacher:last-view';
export const RESTORE_READING_KEY = 'pdf-ai-teacher:restore-reading';
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
type LastPdf = { version: 1; documentId: string; fileName: string; blob: Blob };
type LastView = { documentId: string; pageIndex: number };
let writes: Promise<unknown> = Promise.resolve();

function failure(): Error { return new Error('无法保存上次的书。PDF 仍可阅读，学习记录会独立保存；请检查本机存储空间，下次可能需要重新选择文件。'); }
export function restoreReadingEnabled(): boolean {
  try { return localStorage.getItem(RESTORE_READING_KEY) !== 'false'; } catch { return true; }
}
export function lastView(documentId: string): LastView | null {
  const raw = localStorage.getItem(LAST_VIEW_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as LastView;
    return value.documentId === documentId && Number.isSafeInteger(value.pageIndex) && value.pageIndex >= 0 ? value : null;
  } catch { return null; }
}
export function rememberPage(documentId: string, pageIndex: number): void {
  if (!restoreReadingEnabled()) return;
  try { localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ documentId: DocumentIdSchema.parse(documentId), pageIndex })); }
  catch { throw failure(); }
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(LAST_PDF_DATABASE, 1); } catch { reject(failure()); return; }
    let settled = false;
    request.onupgradeneeded = () => request.result.createObjectStore(LAST_PDF_STORE);
    request.onsuccess = () => { if (settled) { request.result.close(); return; } settled = true; request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = request.onblocked = () => { settled = true; reject(failure()); };
  });
}
async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(LAST_PDF_STORE, mode);
      const request = operation(tx.objectStore(LAST_PDF_STORE));
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(failure()); };
    } catch { db.close(); reject(failure()); }
  });
}
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.catch(() => undefined).then(operation); writes = result; return result;
}
/** Only the last successfully parsed PDF; never part of learning exports or a network request. */
export async function rememberPdf(value: LastPdf): Promise<void> {
  if (!restoreReadingEnabled()) return;
  if (!DocumentIdSchema.safeParse(value.documentId).success || !(value.blob instanceof Blob) || !value.blob.size || value.blob.size > MAX_PDF_BYTES) throw failure();
  await enqueue(() => transact('readwrite', store => store.put(value, 'last')));
}
export async function loadLastPdf(): Promise<LastPdf | null> {
  if (!restoreReadingEnabled()) return null;
  const value: unknown = await transact('readonly', store => store.get('last'));
  if (!value) return null;
  const item = value as LastPdf;
  if (item.version !== 1 || !DocumentIdSchema.safeParse(item.documentId).success || typeof item.fileName !== 'string' || !item.fileName || item.fileName.length > 512 || !(item.blob instanceof Blob) || !item.blob.size || item.blob.size > MAX_PDF_BYTES) throw new Error('上次的 PDF 缓存不可用，请重新选择文件。学习记录仍保留。');
  // A failed replacement must not reopen an older, unrelated book on the next launch.
  if (!lastView(item.documentId)) throw new Error('上次的 PDF 未能完整保存，请重新选择文件；已保存的学习记录仍可恢复。');
  return item;
}
export async function setRestoreReading(enabled: boolean): Promise<void> {
  localStorage.setItem(RESTORE_READING_KEY, String(enabled));
  if (!enabled) {
    localStorage.removeItem(LAST_VIEW_KEY);
    await enqueue(() => transact('readwrite', store => store.delete('last')));
  }
}
