import { DocumentIdSchema, LearningRecordSchema, MAX_SAVED_BOOKS, type BookMetadata, type LearningRecord } from '../../../../../packages/shared/learning';
import type { DocumentRecord } from '../../../../../packages/shared/protocol';
import { validateRecord } from './records';

export const LEARNING_DATABASE = 'pdf-ai-teacher-learning';
export const LEARNING_STORE = 'books';
const DATABASE_VERSION = 1;

function storageError(error: unknown): Error {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'QuotaExceededError') return new Error('浏览器本地存储已满，本次内容仍保留在当前页面。请先导出学习记录，再删除不需要的书籍记录后重试；关闭页面前请保存导出。');
  if (error instanceof Error && error.message.startsWith('学习记录')) return error;
  return new Error('无法访问浏览器本地学习记录。本次内容仍保留在当前页面，请先导出；检查浏览器是否禁用网站存储，或关闭占用旧版页面的标签页后重试。');
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(storageError(null)); return; }
    let request: IDBOpenDBRequest;
    try { request = globalThis.indexedDB.open(LEARNING_DATABASE, DATABASE_VERSION); }
    catch (error) { reject(storageError(error)); return; }
    let settled = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LEARNING_STORE)) database.createObjectStore(LEARNING_STORE, { keyPath: 'document.documentId' });
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => { settled = true; reject(storageError(request.error)); };
    request.onblocked = () => { settled = true; reject(storageError(null)); };
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, setResult: (result: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = database.transaction(LEARNING_STORE, mode); }
    catch (error) { database.close(); reject(storageError(error)); return; }
    let result: T;
    let failure: Error | undefined;
    tx.oncomplete = () => { database.close(); resolve(result); };
    tx.onabort = () => { database.close(); reject(failure ?? storageError(tx.error)); };
    tx.onerror = event => { failure ??= storageError((event.target as IDBRequest).error ?? tx.error); };
    const fail = (error: Error) => { failure = error; tx.abort(); };
    try { operation(tx.objectStore(LEARNING_STORE), value => { result = value; }, fail); }
    catch (error) { fail(storageError(error)); }
  });
}

/** No PDF blob, microphone data, credentials or active session state is persisted. */
export async function saveRecord(value: LearningRecord): Promise<void> {
  const record = validateRecord(value);
  await transaction<void>('readwrite', (store, done, fail) => {
    const put = () => {
      let request:IDBRequest;
      try { request=store.put(record); } catch(error) { fail(storageError(error)); return; }
      request.onsuccess = () => done(undefined);
    };
    const count = store.count();
    count.onsuccess = () => {
      if (count.result < MAX_SAVED_BOOKS) { put(); return; }
      const existing = store.getKey(record.document.documentId);
      existing.onsuccess = () => {
        if (existing.result !== undefined) put();
        else fail(new Error(`学习记录已达到 ${MAX_SAVED_BOOKS} 本上限。本次内容仍在当前页面，请先导出，再删除不需要的书籍记录后重试。`));
      };
    };
  });
}

/** Reopening a PDF restores only its exact fingerprint, page count and parser version. */
export async function loadRecord(document: DocumentRecord): Promise<LearningRecord | null> {
  DocumentIdSchema.parse(document.documentId);
  const record = await transaction<unknown>('readonly', (store, done) => {
    const request = store.get(document.documentId);
    request.onsuccess = () => done(request.result);
  });
  return record === undefined ? null : validateRecord(record, document);
}

/** Deletes only this book's metadata, notes, conversation and board history. */
export async function deleteRecord(documentId: string): Promise<void> {
  DocumentIdSchema.parse(documentId);
  await transaction<void>('readwrite', (store, done) => {
    const request = store.delete(documentId);
    request.onsuccess = () => done(undefined);
  });
}

export async function listBooks(): Promise<BookMetadata[]> {
  const values = await transaction<unknown[]>('readonly', (store, done) => {
    const request = store.getAll();
    request.onsuccess = () => done(request.result);
  });
  return values.map(value => {
    // Listing remains available when a later segmentation version invalidates a bookmark.
    // Full source/cursor integrity is still required by loadRecord before anything is restored.
    const parsed = LearningRecordSchema.safeParse(value);
    if (!parsed.success) throw new Error('学习记录格式已损坏，无法读取书架。请先导出当前页面的记录，再清理该网站的本地学习记录。');
    const record = parsed.data;
    return { documentId: record.document.documentId, fileName: record.document.fileName, pageCount: record.document.pageCount, pageIndex: record.pageIndex, updatedAt: record.updatedAt, messageCount: record.messages.length, entryCount: record.entries.length, hasBookmark: record.readingBookmark !== null };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
