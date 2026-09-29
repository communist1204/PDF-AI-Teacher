import { LearningRecordSchema, MAX_RECORD_BYTES, type LearningRecord } from '../../../../../packages/shared/learning';
import { validatePlan, type DocumentRecord, type SourceRef } from '../../../../../packages/shared/protocol';
import { splitSentences, textVersion } from '../voice/sentences';

/** Existing protocol schemas strip unknown fields; imports must reject them instead. */
function rejectUnknownProperties(input: unknown, parsed: unknown): void {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    input.forEach((item, index) => rejectUnknownProperties(item, parsed[index]));
  } else if (input !== null && typeof input === 'object' && parsed !== null && typeof parsed === 'object') {
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(parsed, key)) throw new Error('学习记录含有未允许的字段；不能导入凭证、录音或可执行内容。');
      rejectUnknownProperties((input as Record<string, unknown>)[key], (parsed as Record<string, unknown>)[key]);
    }
  }
}

function fail(message: string): never { throw new Error(`学习记录无效：${message}`); }
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label}重复。`);
}

/** Validates cross-book integrity and returns a detached, whitelisted copy. */
export function validateRecord(value: unknown, expectedDocument?: DocumentRecord): LearningRecord {
  return validateRecordContent(value, expectedDocument);
}

function validateRecordContent(value: unknown, expectedDocument?: DocumentRecord, enforceBytes = true): LearningRecord {
  const result = LearningRecordSchema.safeParse(value);
  if (!result.success) {
    const unknown = value as { version?: unknown } | null;
    if (unknown && unknown.version !== 1) fail('版本不受支持，请使用版本 1 的 JSON 学习记录。');
    fail('字段、格式或长度不符合要求，请重新导出有效的 JSON 学习记录。');
  }
  const record = result.data;
  rejectUnknownProperties(value, record);
  if (enforceBytes && new TextEncoder().encode(JSON.stringify(record, null, 2)).byteLength > MAX_RECORD_BYTES) fail('单本记录超过 8 MiB，请先导出不含截图的 Markdown 保留笔记与板书，再清理本书历史。');
  const document = record.document;
  if (expectedDocument && (document.documentId !== expectedDocument.documentId || document.pageCount !== expectedDocument.pageCount)) fail('记录与当前 PDF 的内容指纹或页数不同，不能跨书恢复。');
  if (expectedDocument && document.extractionVersion !== expectedDocument.extractionVersion) fail('PDF 文本解析版本已变化，旧位置不能直接恢复。请保留导出文件并重新选择原文。');
  if (document.pageLabels && document.pageLabels.length !== document.pageCount) fail('页码标签数量与 PDF 页数不一致。');
  if (record.pageIndex >= document.pageCount) fail('阅读页码超出 PDF 范围。');
  const registry = new Map<string, string>();
  const source = (item: SourceRef) => {
    if (item.documentId !== document.documentId || item.pageIndex >= document.pageCount) fail('来源指向其他 PDF 或不存在的页面。');
    if (!item.sourceId || !item.blockId || !item.sourceId.startsWith(`${document.documentId}:`)) fail('来源标识未绑定当前 PDF。');
    if (item.rect && (item.rect[0] >= item.rect[2] || item.rect[1] >= item.rect[3])) fail('来源框选坐标无效。');
    const identity = JSON.stringify([item.documentId, item.pageIndex, item.blockId, item.rect, item.sourceText, item.pageLabel]);
    if (registry.has(item.sourceId) && registry.get(item.sourceId) !== identity) fail('同一来源标识绑定了不同内容。');
    registry.set(item.sourceId, identity);
  };
  if (record.target) source(record.target);
  unique(record.messages.map(message => message.id), '对话 ID');
  unique(record.entries.map(entry => entry.id), '教案 ID');
  for (const entry of record.entries) {
    if (entry.plan.contextRevision < 0) fail('教案上下文版本无效。');
    if (entry.context.documentId !== document.documentId) fail('教案上下文属于其他 PDF。');
    unique(entry.context.sources.map(item => item.sourceId), '上下文来源 ID');
    entry.context.sources.forEach(source);
    try { validatePlan(entry.plan, entry.context, entry.plan.contextRevision); }
    catch { fail('教案步骤或来源引用无效。'); }
  }
  const activeEntry = record.activeEntryId ? record.entries.find(entry => entry.id === record.activeEntryId) : record.entries.at(-1);
  if (record.activeEntryId && !activeEntry) fail('黑板当前教案不存在。');
  if (record.activeStep >= Math.max(1, activeEntry?.plan.steps.length ?? 0)) fail('黑板当前步骤超出已有教案范围。');
  if (record.readingBookmark) {
    const { target, cursor } = record.readingBookmark;
    source(target);
    const sentences = splitSentences(target.sourceText);
    if (cursor.documentId !== target.documentId || cursor.pageIndex !== target.pageIndex || cursor.blockId !== target.blockId || cursor.textVersion !== textVersion(target.sourceText) || sentences[cursor.sentenceIndex]?.sentenceId !== cursor.sentenceId) fail('阅读书签的文本版本或句子位置已失效，不能跳过未读内容。');
  }
  const progress = record.teachingProgress;
  if (progress) {
    progress.units.forEach(source);
    if (progress.unitIndex > progress.units.length) fail('陪读单元位置超出范围。');
    unique(progress.completedStepIds, '已讲步骤 ID');
    const entry = record.entries.find(item => item.id === progress.entryId);
    if (progress.entryId !== null && !entry) fail('教学进度对应的教案不存在。');
    if (!entry && (progress.stepIndex !== 0 || progress.completedStepIds.length)) fail('没有教案时不能记录已讲步骤。');
    if (entry && (progress.stepIndex > entry.plan.steps.length || progress.completedStepIds.some(id => !entry.plan.steps.some(step => step.stepId === id)))) fail('教学进度引用了不存在的步骤。');
    if (progress.phase === 'explaining' && (!entry || progress.stepIndex >= entry.plan.steps.length || progress.unitIndex >= progress.units.length)) fail('当前讲解步骤不存在。');
  }
  return record;
}

/** Explicit version dispatch is the migration boundary for future local formats. */
export function importRecord(json: string, expectedDocument?: DocumentRecord): LearningRecord {
  if (new TextEncoder().encode(json).byteLength > MAX_RECORD_BYTES) fail('导入文件超过 8 MiB 上限。');
  let value: unknown;
  try { value = JSON.parse(json); } catch { fail('不是有效的 JSON 文件。'); }
  return validateRecord(value, expectedDocument);
}

export function exportRecord(record: LearningRecord): string {
  return JSON.stringify(validateRecord(record), null, 2);
}

// Escape user text for Markdown consumers; raw HTML, links and embedded scripts stay text.
function markdownText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}[\]()#+.!|~-])/g, '\\$1');
}
function fenced(text: string, language: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
}

export function markdownExport(input: LearningRecord): string {
  // Markdown omits images: keep all schema/source checks, but allow rescue of oversized JSON records.
  const record = validateRecordContent(input, undefined, false);
  const lines = [`# ${markdownText(record.document.fileName)} · 学习记录`, '', `更新：${record.updatedAt}`, `PDF 第 ${record.pageIndex + 1} / ${record.document.pageCount} 页`, '', '## 我的笔记', '', markdownText(record.note) || '（暂无）', '', '## 对话', ''];
  for (const message of record.messages) lines.push(`### ${message.role === 'user' ? '我' : message.demo ? '老师（演示内容）' : '老师'}`, '', markdownText(message.text), '');
  lines.push('## 黑板', '');
  for (const entry of record.entries) {
    lines.push(`### 教案 ${markdownText(entry.id)}${entry.mode === 'demo' ? '（演示内容）' : ''}`, '');
    for (const step of entry.plan.steps) {
      lines.push(`#### ${markdownText(step.title)}`, '', markdownText(step.explanationMarkdown), '');
      for (const block of step.boardBlocks) {
        if (block.type === 'text') lines.push(markdownText(block.markdown), '');
        else if (block.type === 'math') lines.push(block.label ? markdownText(block.label) : '公式', '', fenced(block.latex, 'latex'), '');
        else if (block.type === 'callout') lines.push(`> ${markdownText(block.text).replace(/\n/g, '\n> ')}`, '');
        else if (block.type === 'table') {
          lines.push(`| ${block.headers.map(markdownText).join(' | ')} |`, `| ${block.headers.map(() => '---').join(' | ')} |`);
          block.rows.forEach(row => lines.push(`| ${row.map(cell => markdownText(cell).replace(/\r?\n/g, ' ')).join(' | ')} |`));
          lines.push('');
        } else lines.push(fenced(JSON.stringify(block, null, 2), 'json'), '');
      }
      if (step.exampleOrigin === 'teacher_created') lines.push('例子来源：老师自拟，非教材原文。', '');
      for (const id of step.sourceIds) {
        const source = entry.context.sources.find(item => item.sourceId === id)!;
        lines.push(`来源：PDF 第 ${source.pageIndex + 1} 页${source.pageLabel ? ` · 书面页码 ${markdownText(source.pageLabel)}` : ''}`, `来源 ID：${markdownText(source.sourceId)}`, '', fenced(source.sourceText || '（框选图像区域）', 'text'), '');
      }
    }
    if (entry.plan.checkQuestion) lines.push(`检查问题：${markdownText(entry.plan.checkQuestion)}`, '');
  }
  if (record.readingBookmark) lines.push('## 阅读书签', '', `PDF 第 ${record.readingBookmark.cursor.pageIndex + 1} 页 · 选段第 ${record.readingBookmark.cursor.sentenceIndex + 1} 句（恢复时从句首重播）`, '');
  return lines.join('\n');
}
