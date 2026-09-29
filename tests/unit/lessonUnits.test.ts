import { describe, expect, it } from 'vitest';
import { createLessonUnits, MAX_LESSON_UNITS, MAX_PARAGRAPH_CHARACTERS } from '../../apps/web/src/features/voice/lessonUnits';
import { textVersion } from '../../apps/web/src/features/voice/sentences';
import type { PdfTarget } from '../../packages/shared/protocol';

const target: PdfTarget = { sourceId: 'source', documentId: 'content-fingerprint', pageIndex: 8, pageLabel: '2', blockId: 'block', rect: [0.1, 0.2, 0.8, 0.9], sourceText: '参数 β_1^t 的值为 0.9。\n先观察这一段。\n\n∂L/∂w 是偏导。最后一句！' };

describe('bounded classroom units', () => {
  it.each(['sentence', 'paragraph', 'selection'] as const)('%s preserves every selected character and actual source location', unit => {
    const units = createLessonUnits(target, unit);
    expect(units.map(value => value.sourceText).join('')).toBe(target.sourceText);
    expect(units.every(value => value.documentId === target.documentId && value.pageIndex === 8 && value.pageLabel === '2')).toBe(true);
    expect(units.every(value => JSON.stringify(value.rect) === JSON.stringify(target.rect))).toBe(true);
    expect(units.every(value => value.sourceId.length <= 200 && value.blockId.length <= 200)).toBe(true);
    expect(new Set(units.map(value => value.sourceId)).size).toBe(units.length);
    expect(units).toEqual(createLessonUnits(target, unit));
    expect(units[0].rect).not.toBe(target.rect);
  });

  it('ends at paragraph gaps and bounds long paragraphs without splitting emoji', () => {
    expect(createLessonUnits(target, 'paragraph').map(value => value.sourceText)).toEqual(['参数 β_1^t 的值为 0.9。\n先观察这一段。\n\n', '∂L/∂w 是偏导。最后一句！']);
    const sourceText = '甲'.repeat(999) + '😀'.repeat(900) + '\n末段';
    const units = createLessonUnits({ ...target, sourceText }, 'paragraph');
    expect(units.every(value => value.sourceText.length <= MAX_PARAGRAPH_CHARACTERS)).toBe(true);
    expect(units.map(value => value.sourceText).join('')).toBe(sourceText);
    expect(units.every(value => !/[\uD800-\uDBFF]$/.test(value.sourceText) && !/^[\uDC00-\uDFFF]/.test(value.sourceText))).toBe(true);
  });

  it('changes IDs and reading text versions after a correction; identifies same-name different books separately', () => {
    const before = createLessonUnits(target, 'selection')[0];
    const corrected = createLessonUnits({ ...target, sourceText: target.sourceText.replace('0.9', '0.8') }, 'selection')[0];
    const anotherBook = createLessonUnits({ ...target, documentId: 'other-content' }, 'selection')[0];
    expect(corrected.sourceId).not.toBe(before.sourceId);
    expect(corrected.blockId).not.toBe(before.blockId);
    expect(textVersion(corrected.sourceText)).not.toBe(textVersion(before.sourceText));
    expect(anotherBook.sourceId).not.toBe(before.sourceId);
  });

  it('rejects over-limit unit counts rather than silently dropping the tail', () => {
    expect(() => createLessonUnits({ ...target, sourceText: '句。'.repeat(MAX_LESSON_UNITS + 1) }, 'sentence')).toThrow('超过 100');
    expect(() => createLessonUnits({ ...target, sourceText: '字'.repeat(12001) }, 'selection')).toThrow('12000');
    expect(() => createLessonUnits({ ...target, sourceText: '  \n  ' }, 'paragraph')).toThrow('没有可读文字');
  });
});
