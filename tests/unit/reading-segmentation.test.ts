import { describe, expect, it, vi } from 'vitest';
import { AudioCoordinator } from '../../apps/web/src/features/voice/AudioCoordinator';
import { requiresFormulaConfirmation, SEGMENTATION_VERSION, splitSentences, textVersion, toSpeechText } from '../../apps/web/src/features/voice/sentences';
import type { Envelope, PdfTarget } from '../../packages/shared/protocol';

const spoken = (text: string) => splitSentences(text).map(sentence => sentence.speechText);

describe('PDF reading segmentation', () => {
  it('keeps one Chinese sentence across layout wraps and semicolons in one request', () => {
    const text = '这里保留九成的历史\n信息；剩下的一成，\r\n  来自本次观测。';
    expect(spoken(text)).toEqual(['这里保留九成的历史信息；剩下的一成，来自本次观测。']);
    expect(splitSentences(text)[0].sourceText).toBe(text);
  });

  it('preserves spaces between English tokens, decimal values, and literal hyphens', () => {
    expect(spoken('The moving\n average is 0.9; the next\r\nvalue is 0.1.')).toEqual(['The moving average is 0.9; the next value is 0.1.']);
    expect(toSpeechText('non-\nlinear')).toBe('non- linear'); // Do not silently guess a broken word.
    expect(toSpeechText('1\n2')).toBe('1 2'); // Two numeric tokens must not become twelve.
  });

  it('keeps real paragraphs, including whitespace-only blank lines, separate', () => {
    const text = '\r\n第一段没有句号\r\n \t\r\n第二段也没有句号';
    expect(spoken(text)).toEqual(['第一段没有句号', '第二段也没有句号']);
    expect(splitSentences(text).map(sentence => sentence.sourceText).join('')).toBe(text);
    expect(toSpeechText('第一段\n\n第二段')).toBe('第一段\n\n第二段');
  });

  it('keeps explicit list items apart without mistaking their layout wraps for items', () => {
    const text = '步骤如下\n1. 先保留历史\n信息\n2. 再加入观测值\n• 最后核对';
    expect(spoken(text)).toEqual(['步骤如下', '1. 先保留历史信息', '2. 再加入观测值', '• 最后核对']);
    expect(splitSentences(text).map(sentence => sentence.sourceText).join('')).toBe(text);
  });

  it('keeps standalone mathematics on its own and retains all symbols for correction', () => {
    const text = '更新公式如下\nM_t = β M_{t-1} + (1 − β)g_t\n其中系数不变。';
    expect(spoken(text)).toEqual(['更新公式如下', 'M_t = β M_{t-1} + (1 − β)g_t', '其中系数不变。']);
    expect(splitSentences(text).map(sentence => sentence.sourceText).join('')).toBe(text);
    expect(requiresFormulaConfirmation(text)).toBe(true);
    expect(spoken('The cost is x = 0.9\nwhen the sample is fixed.')).toHaveLength(1);
  });

  it('does not split inside nested math parentheses, decimals, or existing pronunciation rules', () => {
    expect(spoken('结果 f((x)) + 0.9 保持不变；β_1^t 是权重。')).toEqual(['结果 f((x)) + 0.9 保持不变；beta 一的 t 次方 是权重。']);
    expect(toSpeechText('∂L/\n∂w')).toBe('损失 L 对参数 w 的偏导');
    expect(requiresFormulaConfirmation('∂L/\n∂w')).toBe(false);
  });

  it('keeps closing quotation marks with the sentence they close', () => {
    expect(spoken('他说：“先看这一句。”然后继续？')).toEqual(['他说：“先看这一句。”', '然后继续？']);
  });

  it('round-trips source and limits chunks without splitting surrogate pairs', () => {
    const text = '字'.repeat(299) + '🧠'.repeat(170) + '\r\n' + '∂L/∂w'.repeat(90) + '。\n';
    const chunks = splitSentences(text);
    expect(chunks.map(sentence => sentence.sourceText).join('')).toBe(text);
    expect(chunks.every(sentence => sentence.sourceText.length <= 300 && sentence.speechText.length <= 1000)).toBe(true);
    expect(chunks.every(sentence => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(sentence.sourceText))).toBe(true);
    expect(chunks).toEqual(splitSentences(text));
    expect(splitSentences(' \r\n\t\n ')).toEqual([]);
  });
});

describe('conservative Chinese calendar-year pronunciation', () => {
  it.each([
    ['2026年出版。', '二零二六年出版。'],
    ['2026 年出版。', '二零二六年出版。'],
    ['公元2026年。', '公元二零二六年。'],
    ['2026年度报告。', '二零二六年度报告。'],
    ['在\n2026\n年发布。', '在二零二六年发布。'],
    ['1998年到2026年。', '一九九八年到二零二六年。'],
  ])('reads calendar year digit by digit: %s', (source, expected) => {
    expect(toSpeechText(source)).toBe(expected);
    expect(splitSentences(source).map(sentence => sentence.sourceText).join('')).toBe(source);
  });

  it.each([
    '历时2026年。', '经过2026年。', '长达2026年。', '持续了2026年。',
    '用了2026年。', '约2026年。', '超过2026年。', '2026年之久。',
    '等待2026年时间。', '需要2026年的时间。', '相隔2026年。',
    '2026个，2026元，2026.5，编号2026。', '编号2026年。', '第2026年。',
    'x = 2026年。', '$2026年$。', String.raw`\mathrm{2026年}。`, '`2026年`。',
    '12026年。', 'v2026年。', '0.2026年。',
  ])('leaves duration, numbers, identifiers, and math unchanged: %s', source => {
    expect(toSpeechText(source)).toBe(source);
  });
});

describe('reading bookmarks after resegmentation', () => {
  it('rejects v1 cursors, accepts current cursors, and restores without requesting audio', () => {
    const target: PdfTarget = { sourceId: 'source-one', documentId: 'book-one', pageIndex: 0, pageLabel: null, blockId: 'block-one', rect: null, sourceText: '同一句\n应当连续。下一句。' };
    const envelope: Envelope = { sessionId: 'session-one', generationId: 1, contextRevision: 1 };
    const sentenceIndex = 1;
    const cursor = { documentId: target.documentId, pageIndex: target.pageIndex, blockId: target.blockId, sentenceIndex, sentenceId: splitSentences(target.sourceText)[sentenceIndex].sentenceId, textVersion: textVersion(target.sourceText) };
    const requestSpeech = vi.fn(async () => new Blob());
    const audio = new AudioCoordinator({ requestSpeech, onChange: vi.fn(), onError: vi.fn() });
    expect(SEGMENTATION_VERSION).toBe('sentence-v2');
    const oldCursor = { ...cursor, sentenceId: cursor.sentenceId.replace('sentence-v2', 'sentence-v1'), textVersion: cursor.textVersion.replace('sentence-v2', 'sentence-v1') };
    expect(audio.restoreBookmark({ target, cursor: oldCursor }, envelope, 'live')).toBe(false);
    expect(audio.restoreBookmark({ target, cursor }, envelope, 'live')).toBe(true);
    expect(audio.getSnapshot()).toMatchObject({ sentenceIndex: 1, status: 'silent' });
    expect(audio.getSnapshot().sentences[1].speechText).toBe('下一句。');
    expect(requestSpeech).not.toHaveBeenCalled();
    audio.dispose();
  });
});
