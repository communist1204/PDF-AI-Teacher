import { SourceSchema, type PdfTarget } from '../../../../../packages/shared/protocol';
import { splitSentences, textVersion } from './sentences';

export type LessonUnit = 'sentence' | 'paragraph' | 'selection';
export const MAX_LESSON_UNITS = 100;
export const MAX_PARAGRAPH_CHARACTERS = 1000;

function paragraphs(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  // Preserve line breaks verbatim; blank lines close a paragraph. PDF line wraps
  // can be combined until the bounded unit size, without dropping any symbols.
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    let remainder = line;
    while (remainder.length) {
      let available = MAX_PARAGRAPH_CHARACTERS - current.length;
      if (remainder.length > available && available > 0 && /[\uD800-\uDBFF]/.test(remainder[available - 1])) available -= 1;
      if (!available) { chunks.push(current); current = ''; continue; }
      current += remainder.slice(0, available);
      remainder = remainder.slice(available);
      if (current.length >= MAX_PARAGRAPH_CHARACTERS || remainder.length) { chunks.push(current); current = ''; }
    }
    if (!line.trim() && current) {
      if (current.trim()) chunks.push(current);
      else if (chunks.length && chunks[chunks.length - 1].length + current.length <= MAX_PARAGRAPH_CHARACTERS) chunks[chunks.length - 1] += current;
      else continue;
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Only splits the chosen text. No page lookup, background reading or truncation. */
export function createLessonUnits(target: PdfTarget, unit: LessonUnit): PdfTarget[] {
  if (!SourceSchema.safeParse(target).success) throw new Error('选区内容无效或超过 12000 字，请缩小范围。');
  if (!target.sourceText.trim()) throw new Error('这个选区没有可读文字，请选择原文，或先修正提取结果。');
  const chunks = unit === 'sentence' ? splitSentences(target.sourceText).map(sentence => sentence.sourceText) : unit === 'paragraph' ? paragraphs(target.sourceText) : [target.sourceText];
  if (chunks.length > MAX_LESSON_UNITS) throw new Error(`本次选区超过 ${MAX_LESSON_UNITS} 个教学单元，请缩小范围；尚未开始朗读。`);
  if (chunks.some(chunk => !chunk.trim())) throw new Error('选区包含过长的空白段，请修正提取结果后再开始；原文未被截断。');
  const version = textVersion(target.sourceText);
  const identity = textVersion(`${target.documentId}:${target.pageIndex}:${target.sourceId}:${target.blockId}`);
  return chunks.map((sourceText, index) => ({
    ...target,
    // The rectangle remains the honest parent selection, never an invented line box.
    rect: target.rect ? [...target.rect] : null,
    sourceId: `lesson:${identity}:${version}:${unit}:${index}`,
    blockId: `lesson:${textVersion(target.blockId)}:${version}:${unit}:${index}`,
    sourceText,
  }));
}
