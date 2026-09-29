import { describe, expect, it } from 'vitest';
import { LEARNING_FORMAT, MAX_RECORD_BYTES, type LearningRecord } from '../../packages/shared/learning';
import { exportRecord, importRecord, markdownExport, validateRecord } from '../../apps/web/src/features/library/records';
import { loadRecord, saveRecord } from '../../apps/web/src/features/library/storage';
import { splitSentences, textVersion } from '../../apps/web/src/features/voice/sentences';
import { makeDemoPlan } from '../../apps/server/src/demo';
import type { PdfTarget } from '../../packages/shared/protocol';

const documentId = `sha256-${'a'.repeat(64)}`;
const otherDocumentId = `sha256-${'b'.repeat(64)}`;
function fixture(): LearningRecord {
  const target: PdfTarget = { documentId, sourceId: `${documentId}:p1-unit`, blockId: 'p1-unit', pageIndex: 1, pageLabel: '一', rect: [0.1, 0.1, 0.8, 0.4], sourceText: '第一句。第二句。' };
  const context = { documentId, sources: [target], imageDataUrl: null, selectedBoardText: null };
  const plan = makeDemoPlan({ sessionId: 'not-persisted', generationId: 1, contextRevision: 1, question: '为什么？', context, history: [] });
  return {
    format: LEARNING_FORMAT, version: 1,
    document: { documentId, fileName: '练习.pdf', pageCount: 2, pageLabels: ['前言', '一'], extractionVersion: 'pdfjs-layout-v1' },
    pageIndex: 1, target, messages: [{ id: 'm1', role: 'user', text: '为什么？' }, { id: 'm2', role: 'assistant', text: '演示回答', demo: true }],
    entries: [{ id: 'entry1', plan, context, mode: 'demo' }], activeStep: 1, note: '记住偏差修正。',
    readingBookmark: { target, cursor: { documentId, pageIndex: 1, blockId: target.blockId, sentenceId: splitSentences(target.sourceText)[1].sentenceId, textVersion: textVersion(target.sourceText), sentenceIndex: 1 } },
    teachingProgress: { entryId: 'entry1', stepIndex: 1, completedStepIds: ['demo-scope'], interrupted: true, units: [target], unitIndex: 0, mode: 'read-explain', phase: 'explaining' },
    preferences: { mode: 'read-explain', unit: 'paragraph', autoResume: false }, updatedAt: '2026-09-29T10:00:00.000Z',
  };
}

describe('versioned learning record import/export', () => {
  it('round-trips Chinese notes, original text, board sources, paragraph progress and independent bookmarks', () => {
    const record = fixture();
    const json = exportRecord(record);
    expect(importRecord(json, record.document)).toEqual(record);
    expect(json).not.toMatch(/sessionId|csrfToken|apiKey|recording|generationId/);
    const restored = importRecord(json);
    restored.readingBookmark!.target.sourceText = 'changed';
    expect(record.readingBookmark!.target.sourceText).toBe('第一句。第二句。');
  });

  it('matches by content fingerprint rather than filename', () => {
    const record = fixture();
    expect(importRecord(exportRecord(record), { ...record.document, fileName: '重命名.pdf' }).document.documentId).toBe(documentId);
    expect(() => importRecord(exportRecord(record), { ...record.document, documentId: otherDocumentId })).toThrow('不能跨书恢复');
    expect(() => importRecord(exportRecord(record), { ...record.document, pageCount: 3 })).toThrow('不能跨书恢复');
    expect(() => importRecord(exportRecord(record), { ...record.document, extractionVersion: 'new-parser' })).toThrow('解析版本');
  });

  it('rejects unknown format versions and invalid JSON rather than guessing a migration', () => {
    expect(() => importRecord('{not json}')).toThrow('不是有效的 JSON');
    expect(() => validateRecord({ ...fixture(), version: 2 })).toThrow('版本不受支持');
    expect(() => validateRecord({ ...fixture(), format: 'foreign-record' })).toThrow('格式');
  });

  it.each(['sessionId', 'csrfToken', 'apiKey', 'recording', 'pdfBlob'])('rejects top-level secret or unsupported field %s', key => {
    expect(() => validateRecord({ ...fixture(), [key]: 'must-not-be-stored' })).toThrow();
  });

  it('rejects secret and executable fields nested inside shared schemas that ordinarily strip unknown fields', () => {
    const record = fixture();
    const changed = JSON.parse(JSON.stringify(record));
    changed.entries[0].plan.steps[0].boardBlocks[0].apiKey = 'must-not-be-stored';
    expect(() => validateRecord(changed)).toThrow('未允许的字段');
    changed.entries[0].plan.steps[0].boardBlocks[0] = { id: 'script', type: 'html', html: '<script>steal()</script>' };
    expect(() => validateRecord(changed)).toThrow('格式');
  });

  it('rejects out-of-range reading pages and mismatched page-label counts', () => {
    expect(() => validateRecord({ ...fixture(), pageIndex: 2 })).toThrow('页码超出');
    const record = fixture(); record.document.pageLabels = ['only-one'];
    expect(() => validateRecord(record)).toThrow('标签数量');
  });

  it('rejects cross-book source references at every persisted source location', () => {
    for (const location of ['target', 'entry', 'bookmark', 'unit']) {
      const record = structuredClone(fixture());
      if (location === 'target') record.target!.documentId = otherDocumentId;
      if (location === 'entry') record.entries[0].context.sources[0].documentId = otherDocumentId;
      if (location === 'bookmark') record.readingBookmark!.target.documentId = otherDocumentId;
      if (location === 'unit') record.teachingProgress!.units[0].documentId = otherDocumentId;
      expect(() => validateRecord(record)).toThrow('其他 PDF');
    }
  });

  it('rejects bad page, inverted rectangle, unrelated identity and conflicting text under one source ID', () => {
    for (const change of [
      (target: PdfTarget) => { target.pageIndex = 2; },
      (target: PdfTarget) => { target.rect = [0.8, 0.8, 0.1, 0.1]; },
      (target: PdfTarget) => { target.sourceId = 'unrelated'; },
    ]) {
      const record = fixture(); change(record.target!);
      expect(() => validateRecord(record)).toThrow();
    }
    const record = JSON.parse(JSON.stringify(fixture())) as LearningRecord;
    record.entries[0].context.sources[0].sourceText = '不同的原文';
    expect(() => validateRecord(record)).toThrow('不同内容');
  });

  it('rejects forged plan citations and duplicate stable IDs', () => {
    const record = fixture();
    record.entries[0].plan.steps[0].sourceIds = ['invented'];
    expect(() => validateRecord(record)).toThrow('来源引用');
    const duplicate = fixture(); duplicate.messages[1].id = 'm1';
    expect(() => validateRecord(duplicate)).toThrow('对话 ID');
  });

  it('does not restore changed text versions, sentence IDs or out-of-range sentence cursors', () => {
    for (const field of ['textVersion', 'sentenceId', 'sentenceIndex', 'pageIndex', 'blockId'] as const) {
      const record = fixture();
      if (field === 'sentenceIndex' || field === 'pageIndex') record.readingBookmark!.cursor[field] = 99;
      else record.readingBookmark!.cursor[field] = 'stale';
      expect(() => validateRecord(record)).toThrow('书签');
    }
  });

  it('rejects nonexistent or unplayed teaching steps and invalid unit cursors', () => {
    const record = fixture(); record.teachingProgress!.completedStepIds = ['unknown-step'];
    expect(() => validateRecord(record)).toThrow('不存在的步骤');
    const invalidUnit = fixture(); invalidUnit.teachingProgress!.unitIndex = 2;
    expect(() => validateRecord(invalidUnit)).toThrow('单元位置');
    const invalidEntry = fixture(); invalidEntry.teachingProgress!.entryId = 'unknown-entry';
    expect(() => validateRecord(invalidEntry)).toThrow('教案不存在');
    const invalidActive = fixture(); invalidActive.activeStep = 3;
    expect(() => validateRecord(invalidActive)).toThrow('黑板当前步骤');
  });

  it('restores a selected older board entry independently of the latest answer', () => {
    const record = fixture();
    const next = structuredClone(record.entries[0]); next.id = 'entry2'; next.plan.steps = [next.plan.steps[0]];
    record.entries.push(next); record.activeEntryId = 'entry1'; record.activeStep = 2;
    expect(validateRecord(record).activeEntryId).toBe('entry1');
    record.activeEntryId = 'entry2';
    expect(() => validateRecord(record)).toThrow('黑板当前步骤');
    record.activeEntryId = 'missing';
    expect(() => validateRecord(record)).toThrow('黑板当前教案');
  });
  it('allows a saved reading phase before a plan exists and a completed waiting phase', () => {
    const record = fixture();
    record.teachingProgress = { ...record.teachingProgress!, entryId: null, stepIndex: 0, completedStepIds: [], phase: 'reading' };
    expect(validateRecord(record).teachingProgress?.entryId).toBeNull();
    record.teachingProgress.unitIndex = 1; record.teachingProgress.phase = 'waiting';
    expect(validateRecord(record).teachingProgress?.unitIndex).toBe(1);
  });

  it('bounds input size and collections while allowing an empty book state', () => {
    expect(() => importRecord(' '.repeat(MAX_RECORD_BYTES + 1))).toThrow('8 MiB');
    const record = fixture(); record.messages = Array.from({ length: 501 }, (_, index) => ({ id: `message-${index}`, role: 'user', text: 'ok' }));
    expect(() => validateRecord(record)).toThrow('长度');
    const empty = { ...fixture(), target: null, entries: [], messages: [], activeStep: 0, readingBookmark: null, teachingProgress: null };
    expect(validateRecord(empty).entries).toEqual([]);
  });

  it('exports source pages, labels, equations, table and demo disclosure without active HTML or unsafe code fences', () => {
    const record = fixture();
    record.note = '<script>alert(1)</script> [click](javascript:alert(1))';
    record.entries[0].plan.steps[1].boardBlocks.push({ id: 'fence', type: 'math', label: null, latex: 'x```\n<script>evil()</script>' });
    const markdown = markdownExport(record);
    expect(markdown).toContain('PDF 第 2 / 2 页');
    expect(markdown).toContain('书面页码 一');
    expect(markdown).toContain('演示内容');
    expect(markdown).toContain('```latex');
    expect(markdown).toContain('````latex\nx```');
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown).not.toContain('[click](javascript:');
    expect(markdown).toContain('| t | Mₜ |');
    expect(markdown).toContain('选段第 2 句');
  });

  it('reports an actionable storage error when IndexedDB is unavailable, preserving the caller record', async () => {
    const record = fixture();
    await expect(saveRecord(record)).rejects.toThrow('本次内容仍保留');
    await expect(loadRecord(record.document)).rejects.toThrow('请先导出');
    expect(record.note).toBe('记住偏差修正。');
  });
});
