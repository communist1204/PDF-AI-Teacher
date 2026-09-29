import { describe, expect, it, vi } from 'vitest';
import { LEARNING_FORMAT, MAX_RECORD_BYTES, type LearningRecord } from '../../packages/shared/learning';
import { clearRecovery, readRecovery, RECOVERY_KEY_PREFIX, removeRecovery, writeRecovery, type RecoveryStorage } from '../../apps/web/src/features/library/recovery';

const documentId = `sha256-${'a'.repeat(64)}`;
const otherDocumentId = `sha256-${'b'.repeat(64)}`;
function record(): LearningRecord {
  return {
    format: LEARNING_FORMAT, version: 1,
    document: { documentId, fileName: '同名练习.pdf', pageCount: 2, pageLabels: ['前言', '一'], extractionVersion: 'pdfjs-layout-v1' },
    pageIndex: 1, target: null, messages: [], entries: [], activeStep: 0, activeEntryId: null, note: '刷新前刚写下的笔记',
    readingBookmark: null, teachingProgress: null, preferences: { mode: 'read-explain', unit: 'paragraph', autoResume: false },
    updatedAt: '2026-09-29T10:00:00.000Z',
  };
}
function memoryStorage(): RecoveryStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}

describe('synchronous refresh recovery journal', () => {
  it('can immediately restore a complete snapshot without waiting for an IndexedDB task', () => {
    const store = memoryStorage(); const snapshot = record();
    expect(writeRecovery(snapshot, store)).toBeUndefined();
    expect(readRecovery(snapshot.document, store)).toEqual(snapshot);
    snapshot.note = 'later in-memory mutation';
    expect(readRecovery(snapshot.document, store)?.note).toBe('刷新前刚写下的笔记');
  });

  it('returns null for a book without a pending journal and isolates same-name PDFs', () => {
    const store = memoryStorage(); const first = record();
    expect(readRecovery(first.document, store)).toBeNull();
    writeRecovery(first, store);
    expect(readRecovery({ ...first.document, documentId: otherDocumentId }, store)).toBeNull();
    const other = { ...record(), document: { ...first.document, documentId: otherDocumentId }, note: '另一册' };
    writeRecovery(other, store); removeRecovery(documentId, store);
    expect(readRecovery(first.document, store)).toBeNull();
    expect(readRecovery(other.document, store)?.note).toBe('另一册');
  });

  it('removes a journal only after the identical timestamp and content were committed', () => {
    const store = memoryStorage(); const old = record();
    writeRecovery(old, store);
    const newer = { ...old, note: '未落盘的新笔记', updatedAt: '2026-09-29T10:00:01.000Z' };
    writeRecovery(newer, store); clearRecovery(old, store);
    expect(readRecovery(old.document, store)).toEqual(newer);
    clearRecovery(newer, store);
    expect(readRecovery(old.document, store)).toBeNull();
  });

  it('keeps changed content even if edits share the same millisecond timestamp', () => {
    const store = memoryStorage(); const previous = record();
    const current = { ...previous, note: '同一毫秒里的新内容' };
    writeRecovery(current, store); clearRecovery(previous, store);
    expect(readRecovery(current.document, store)?.note).toBe(current.note);
    clearRecovery(current, store);
    expect(readRecovery(current.document, store)).toBeNull();
  });

  it('compares parsed whitelisted content, not object property order', () => {
    const store = memoryStorage(); const snapshot = record();
    const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
    store.setItem(RECOVERY_KEY_PREFIX + documentId, JSON.stringify(reordered));
    clearRecovery(snapshot, store);
    expect(readRecovery(snapshot.document, store)).toBeNull();
  });

  it('rejects credentials before mutating an existing good journal', () => {
    const store = memoryStorage(); const snapshot = record();
    writeRecovery(snapshot, store);
    expect(() => writeRecovery({ ...snapshot, apiKey: 'not-allowed' } as LearningRecord, store)).toThrow();
    expect(readRecovery(snapshot.document, store)).toEqual(snapshot);
    expect(store.values.get(RECOVERY_KEY_PREFIX + documentId)).not.toContain('apiKey');
  });

  it('rejects journals with forged document identity, page count, parser version or page cursor', () => {
    const store = memoryStorage(); const snapshot = record();
    for (const document of [{ ...snapshot.document, documentId: otherDocumentId }, { ...snapshot.document, pageCount: 3 }, { ...snapshot.document, extractionVersion: 'different-parser' }]) {
      store.setItem(RECOVERY_KEY_PREFIX + documentId, JSON.stringify({ ...snapshot, document }));
      expect(() => readRecovery(snapshot.document, store)).toThrow();
    }
    store.setItem(RECOVERY_KEY_PREFIX + documentId, JSON.stringify({ ...snapshot, pageIndex: 2 }));
    expect(() => readRecovery(snapshot.document, store)).toThrow('页码超出');
  });

  it('rejects malformed or oversized JSON and does not destroy it as a side effect of failed clearing', () => {
    const store = memoryStorage(); const snapshot = record(); const key = RECOVERY_KEY_PREFIX + documentId;
    store.setItem(key, '{broken');
    expect(() => readRecovery(snapshot.document, store)).toThrow('不是有效的 JSON');
    expect(() => clearRecovery(snapshot, store)).toThrow();
    expect(store.getItem(key)).toBe('{broken');
    store.setItem(key, ' '.repeat(MAX_RECORD_BYTES + 1));
    expect(() => readRecovery(snapshot.document, store)).toThrow('8 MiB');
  });

  it('reports smaller browser quotas without modifying the caller or deleting a previous snapshot', () => {
    const store = memoryStorage(); const snapshot = record(); writeRecovery(snapshot, store);
    const limited: RecoveryStorage = { ...store, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    expect(() => writeRecovery({ ...snapshot, note: 'new edit' }, limited)).toThrow('仍会尝试保存到 IndexedDB');
    expect(readRecovery(snapshot.document, store)).toEqual(snapshot);
    expect(snapshot.note).toBe('刷新前刚写下的笔记');
  });

  it('provides actionable errors when storage reads or removals are blocked', () => {
    const snapshot = record(); const blocked = { getItem: () => { throw new DOMException('blocked', 'SecurityError'); }, setItem: () => {}, removeItem: () => { throw new DOMException('blocked', 'SecurityError'); } };
    expect(() => readRecovery(snapshot.document, blocked)).toThrow('网站存储权限');
    expect(() => removeRecovery(documentId, blocked)).toThrow('网站存储权限');
  });

  it('catches access to a disabled global localStorage getter and restores the environment', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('disabled', 'SecurityError'); } });
    try { expect(() => writeRecovery(record())).toThrow('无法写入'); }
    finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); }
  });

  it('does not access other keys or mutate storage for an invalid book identity', () => {
    const store: RecoveryStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    expect(() => removeRecovery('another-app-key', store)).toThrow('文档指纹无效');
    expect(store.removeItem).not.toHaveBeenCalled();
    clearRecovery(record(), { ...store, getItem: () => null });
    expect(store.removeItem).not.toHaveBeenCalled();
  });
});
