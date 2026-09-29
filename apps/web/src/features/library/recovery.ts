import { DocumentIdSchema, type LearningRecord } from '../../../../../packages/shared/learning';
import type { DocumentRecord } from '../../../../../packages/shared/protocol';
import { exportRecord, importRecord } from './records';

/** The small synchronous journal supplements IndexedDB during refresh/close. */
export type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const RECOVERY_KEY_PREFIX = 'pdf-ai-teacher-recovery:';

function recoveryKey(documentId: string): string {
  if (!DocumentIdSchema.safeParse(documentId).success) throw new Error('刷新恢复记录的文档指纹无效。');
  return `${RECOVERY_KEY_PREFIX}${documentId}`;
}

function storageFailure(error: unknown, action: 'write' | 'read' | 'clear'): Error {
  const name = error !== null && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new Error('浏览器的刷新恢复存储空间不足，最新快照未写入。学习内容仍在当前页面，应用仍会尝试保存到 IndexedDB；请等待保存成功或先导出，再刷新或关闭页面。');
  }
  const operation = action === 'write' ? '写入' : action === 'read' ? '读取' : '清理';
  return new Error(`无法${operation}本书的刷新恢复快照。请检查浏览器的网站存储权限；当前页面内容仍保留，IndexedDB 可用时仍能保存，请先导出再关闭页面。`);
}

function getStorage(storage?: RecoveryStorage): RecoveryStorage {
  // Accessing localStorage itself may throw SecurityError, so callers resolve it inside try.
  const selected = storage ?? globalThis.localStorage;
  if (!selected) throw new Error('Local storage unavailable');
  return selected;
}

function readRaw(documentId: string, storage?: RecoveryStorage): string | null {
  const key = recoveryKey(documentId);
  try { return getStorage(storage).getItem(key); }
  catch (error) { throw storageFailure(error, 'read'); }
}

/** Synchronously persists a detached, strict version-1 snapshot; never stores API state. */
export function writeRecovery(record: LearningRecord, storage?: RecoveryStorage): void {
  const json = exportRecord(record); // Whitelists every field and enforces the 8 MiB record bound.
  const key = recoveryKey(record.document.documentId);
  try { getStorage(storage).setItem(key, json); }
  catch (error) { throw storageFailure(error, 'write'); }
}

/** A malformed, mismatched or stale-version journal is rejected, never silently applied. */
export function readRecovery(document: DocumentRecord, storage?: RecoveryStorage): LearningRecord | null {
  const raw = readRaw(document.documentId, storage);
  return raw === null ? null : importRecord(raw, document);
}

/** An older successful IndexedDB write must not clear a newer pending snapshot. */
export function clearRecovery(record: LearningRecord, storage?: RecoveryStorage): void {
  const expected = exportRecord(record);
  const raw = readRaw(record.document.documentId, storage);
  if (raw === null) return;
  const current = importRecord(raw, record.document);
  if (current.updatedAt !== record.updatedAt || exportRecord(current) !== expected) return;
  const key = recoveryKey(record.document.documentId);
  try { getStorage(storage).removeItem(key); }
  catch (error) { throw storageFailure(error, 'clear'); }
}

/** Explicit delete/import invalidation is scoped to one content fingerprint. */
export function removeRecovery(documentId: string, storage?: RecoveryStorage): void {
  const key = recoveryKey(documentId);
  try { getStorage(storage).removeItem(key); }
  catch (error) { throw storageFailure(error, 'clear'); }
}
