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
    expect(spoken(text)).toEqual(['更新公式如下', '大写 M 下标 t 等于 贝塔 乘以 大写 M，下标开始，t 减 一，下标结束 加 左括号，一 减 贝塔，右括号 乘以 g 下标 t', '其中系数不变。']);
    expect(splitSentences(text).map(sentence => sentence.sourceText).join('')).toBe(text);
    expect(requiresFormulaConfirmation(text)).toBe(false);
    expect(spoken('The cost is x = 0.9\nwhen the sample is fixed.')).toHaveLength(1);
  });

  it('does not split inside nested math parentheses, decimals, or existing pronunciation rules', () => {
    expect(spoken('结果 f((x)) + 0.9 保持不变；β_1^t 是权重。')).toEqual(['结果 f((x)) + 0.9 保持不变；贝塔 下标 一 的 t 次方 是权重。']);
    expect(toSpeechText('∂L/\n∂w')).toBe('大写 L 对 w 的偏导数');
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
  it('rejects v1 and v2 cursors, accepts current cursors, and restores without requesting audio', () => {
    const target: PdfTarget = { sourceId: 'source-one', documentId: 'book-one', pageIndex: 0, pageLabel: null, blockId: 'block-one', rect: null, sourceText: '同一句\n应当连续。下一句。' };
    const envelope: Envelope = { sessionId: 'session-one', generationId: 1, contextRevision: 1 };
    const sentenceIndex = 1;
    const cursor = { documentId: target.documentId, pageIndex: target.pageIndex, blockId: target.blockId, sentenceIndex, sentenceId: splitSentences(target.sourceText)[sentenceIndex].sentenceId, textVersion: textVersion(target.sourceText) };
    const requestSpeech = vi.fn(async () => new Blob());
    const audio = new AudioCoordinator({ requestSpeech, onChange: vi.fn(), onError: vi.fn() });
    expect(SEGMENTATION_VERSION).toBe('sentence-v3');
    const oldCursor = { ...cursor, sentenceId: cursor.sentenceId.replace('sentence-v3', 'sentence-v1'), textVersion: cursor.textVersion.replace('sentence-v3', 'sentence-v1') };
    expect(audio.restoreBookmark({ target, cursor: oldCursor }, envelope, 'live')).toBe(false);
    const v2Cursor = { ...cursor, sentenceId: cursor.sentenceId.replace('sentence-v3', 'sentence-v2'), textVersion: cursor.textVersion.replace('sentence-v3', 'sentence-v2') };
    expect(audio.restoreBookmark({ target, cursor: v2Cursor }, envelope, 'live')).toBe(false);
    expect(audio.restoreBookmark({ target, cursor }, envelope, 'live')).toBe(true);
    expect(audio.getSnapshot()).toMatchObject({ sentenceIndex: 1, status: 'silent' });
    expect(audio.getSnapshot().sentences[1].speechText).toBe('下一句。');
    expect(requestSpeech).not.toHaveBeenCalled();
    audio.dispose();
  });
});

describe('math speech in the complete reading pipeline', () => {
  it.each([
    ['系数 $\\beta_1^t$ 与 $x^2$。', '系数 贝塔 下标 一 的 t 次方 与 x 的 二 次方。'],
    [String.raw`偏差修正为 \(\frac{1}{1-\beta^t}\)。`, '偏差修正为 分数开始，分子为一，分母为一 减 贝塔 的 t 次方，分数结束。'],
    [String.raw`公式 $$x=0.9$$ 可核对。`, '公式 x 等于 零点九 可核对。'],
    [String.raw`结果 \[\sum_{i=1}^{n}x_i\]。`, '结果 求和开始，下限为i 等于 一，上限为n，求和项为x 下标 i，求和结束。'],
  ])('converts explicit spans without rewriting surrounding prose: %s', (source, expected) => {
    expect(toSpeechText(source)).toBe(expected);
    expect(requiresFormulaConfirmation(source)).toBe(false);
    expect(splitSentences(source).map(sentence => sentence.sourceText).join('')).toBe(source);
    expect(splitSentences(source).map(sentence => sentence.speechText).join('')).toBe(expected);
  });

  it('converts a display formula across its original line wraps without splitting inside LaTeX', () => {
    const source = '先核对\n\\[\\frac{1}{\n1-\\beta^t}\\]\n再继续。';
    const chunks = splitSentences(source);
    expect(chunks.map(sentence => sentence.sourceText).join('')).toBe(source);
    expect(chunks.map(sentence => sentence.speechText)).toEqual(['先核对', '分数开始，分子为一，分母为一 减 贝塔 的 t 次方，分数结束', '再继续。']);
    expect(chunks.every(sentence => !requiresFormulaConfirmation(sentence.sourceText))).toBe(true);
    expect(toSpeechText(source)).toBe('先核对\n分数开始，分子为一，分母为一 减 贝塔 的 t 次方，分数结束\n再继续。');
  });

  it('treats line-wrapped partial derivatives as one expression', () => {
    const source = '∂L/\r\n∂w';
    expect(spoken(source)).toEqual(['大写 L 对 w 的偏导数']);
    expect(splitSentences(source)[0].sourceText).toBe(source);
    expect(requiresFormulaConfirmation(source)).toBe(false);
  });

  it('converts standalone arithmetic but preserves bare numbers and mathematical English words', () => {
    expect(toSpeechText('x = 0.9。')).toBe('x 等于 零点九。');
    expect(toSpeechText('1/2')).toBe('分数开始，分子为一，分母为二，分数结束');
    for (const source of ['123.45', '2026', 'beta and sum', 'The cost is x = 0.9 when the sample is fixed.', '普通文字 0.9 和 2026 个。']) {
      expect(toSpeechText(source)).toBe(source);
      expect(requiresFormulaConfirmation(source)).toBe(false);
    }
  });

  it('converts only strong math runs between Chinese or English words', () => {
    const source = 'The weight β_1^t is 0.9. 梯度 ∂L/∂w 保持原意。';
    expect(toSpeechText(source)).toBe('The weight 贝塔 下标 一 的 t 次方 is 0.9. 梯度 大写 L 对 w 的偏导数 保持原意。');
    expect(requiresFormulaConfirmation(source)).toBe(false);
    expect(splitSentences(source).map(sentence => sentence.sourceText).join('')).toBe(source);
  });

  it('does not combine separate equations or list steps into an implicit product', () => {
    const source = 'x=1\ny=2\n1. 核对\n2. 继续';
    expect(spoken(source)).toEqual(['x 等于 一', 'y 等于 二', '1. 核对', '2. 继续']);
    expect(toSpeechText(source)).toBe('x 等于 一\ny 等于 二\n1. 核对\n2. 继续');
    expect(splitSentences(source).map(sentence => sentence.sourceText).join('')).toBe(source);
  });

  it.each([
    String.raw`请读 $\frac{1}{}$。`, String.raw`请读 \(x=1。`, String.raw`\unknown{x}`,
    '需要核对 x^ 和 ∫f(x)dx。', String.raw`$\int_0^1 f(x)$`, 'x = �',
    '代码 `x^2` 不应改写。', String.raw`请读 $x=1e-3$。`, String.raw`\[a/b c\]`,
  ])('retains uncertain source visibly and requires review before speaking: %s', source => {
    expect(toSpeechText(source)).toBe(source);
    expect(requiresFormulaConfirmation(source)).toBe(true);
    expect(splitSentences(source).map(sentence => sentence.sourceText).join('')).toBe(source);
  });

  it('retains the complete expanded reading and requires review above 1400 characters', () => {
    const source = Array.from({ length: 70 }, () => '1/2').join('+');
    expect(source.length).toBeLessThan(300);
    const expanded = toSpeechText(source);
    expect(expanded.length).toBeGreaterThan(1400);
    expect(expanded).toContain('分数开始，分子为一，分母为二，分数结束');
    expect(expanded.endsWith('分数结束')).toBe(true);
    expect(requiresFormulaConfirmation(source)).toBe(true);
    expect(splitSentences(source)[0]).toMatchObject({ sourceText: source, speechText: expanded });
  });

  it('preserves calendar-year and soft-wrap normalization alongside explicit math', () => {
    const source = '2026年我们保留\n历史信息，系数 $\\beta_1^t$；经过2026年仍要核对。';
    expect(toSpeechText(source)).toBe('二零二六年我们保留历史信息，系数 贝塔 下标 一 的 t 次方；经过2026年仍要核对。');
    expect(requiresFormulaConfirmation(source)).toBe(false);
    expect(splitSentences(source)).toHaveLength(1);
    expect(splitSentences(source)[0].sourceText).toBe(source);
  });
});

describe('formula boundary and OCR safety in segmentation', () => {
  it('does not treat a leading decimal or LaTeX spacing command as a sentence end', () => {
    expect(spoken('x = .1')).toEqual(['x 等于 零点一']);
    const formula = String.raw`\frac{1\!}{2}`;
    expect(spoken(formula)).toEqual(['分数开始，分子为一，分母为二，分数结束']);
    expect(splitSentences(formula)[0].sourceText).toBe(formula);
  });

  it('never approves unreadable OCR characters or hidden controls after whitespace normalization', () => {
    for (const source of ['这里的 � 无法识别。', 'x = \u000B1', '这里有\uE000字符。']) {
      expect(requiresFormulaConfirmation(source)).toBe(true);
      expect(splitSentences(source).map(sentence => sentence.sourceText).join('')).toBe(source);
    }
  });
});

describe('unwrapped LaTeX layout continuity', () => {
  it.each([
    ['\\frac{1}{\n1-\\beta^t}', '分数开始，分子为一，分母为一 减 贝塔 的 t 次方，分数结束'],
    ['\\frac{1}\n{2}', '分数开始，分子为一，分母为二，分数结束'],
    ['\\sum_{i=1}^{n}\nx_i', '求和开始，下限为i 等于 一，上限为n，求和项为x 下标 i，求和结束'],
  ])('keeps an incomplete formula and its mathematical continuation together: %s', (source, expected) => {
    expect(spoken(source)).toEqual([expected]);
    expect(splitSentences(source)[0].sourceText).toBe(source);
    expect(requiresFormulaConfirmation(source)).toBe(false);
  });
});

describe('review is per original sentence, not the entire selected passage', () => {
  it('accepts a long ordinary selection when every spoken sentence is within the limit', () => {
    const source = '这一句是可以直接朗读的普通文字。'.repeat(160);
    expect(source.length).toBeGreaterThan(1400);
    expect(toSpeechText(source).length).toBeGreaterThan(1400);
    expect(splitSentences(source).every(sentence => sentence.speechText.length < 1400)).toBe(true);
    expect(requiresFormulaConfirmation(source)).toBe(false);
  });

  it('accepts many independent display equations while retaining each boundary', () => {
    const source = Array.from({ length: 220 }, () => 'x=1').join('\n');
    expect(toSpeechText(source).length).toBeGreaterThan(1400);
    expect(splitSentences(source)).toHaveLength(220);
    expect(requiresFormulaConfirmation(source)).toBe(false);
  });

  it('rejects a long single formula instead of approving syntactically plausible chopped pieces', () => {
    const formula = Array.from({ length: 180 }, () => 'x^2').join('+');
    expect(formula.length).toBeGreaterThan(300);
    expect(requiresFormulaConfirmation(formula)).toBe(true);
    const source = '重要前缀需要保留。$' + formula + '$。之后继续。';
    expect(requiresFormulaConfirmation(source)).toBe(true);
    expect(splitSentences(source).map(sentence => sentence.sourceText).join('')).toBe(source);
    expect(splitSentences(source)[0].sourceText).toBe('重要前缀需要保留。');
  });

  it('rejects raw controls even when whitespace-only segmentation would produce no sentence', () => {
    expect(splitSentences('\u000B')).toEqual([]);
    expect(requiresFormulaConfirmation('\u000B')).toBe(true);
    expect(requiresFormulaConfirmation(' \r\n\t ')).toBe(false);
  });
});

describe('real PDF Unicode scripts through the reading pipeline', () => {
  it('speaks the fixture EMA recurrence and Unicode exponent without leaving script glyphs behind', () => {
    const source = '更新公式：Mₜ = β Mₜ₋₁ + (1 − β) gₜ。修正因子含有 βᵗ。';
    const speech = toSpeechText(source);
    expect(speech).toBe('更新公式：大写 M 下标 t 等于 贝塔 乘以 大写 M，下标开始，t 减 一，下标结束 加 左括号，一 减 贝塔，右括号 乘以 g 下标 t。修正因子含有 贝塔 的 t 次方。');
    expect(speech).not.toMatch(/[ₜ₋₁ᵗ]/u);
    expect(requiresFormulaConfirmation(source)).toBe(false);
    expect(splitSentences(source).map(sentence => sentence.sourceText).join('')).toBe(source);
  });

  it.each(['参数 βᵊ 是什么。', '参数 βᵦ 是什么。', '参数 β\u{107A5} 是什么。', 'M\u0000ₜ = βᵗ', '代码 `xᵗ`。'])('does not partly convert a formula then silently pass an unknown script: %s', source => {
    expect(toSpeechText(source)).toBe(source);
    expect(requiresFormulaConfirmation(source)).toBe(true);
    expect(splitSentences(source).map(sentence => sentence.sourceText).join('')).toBe(source);
  });

  it('recognizes Latin script markers even when there is no Greek letter or explicit delimiter', () => {
    const source = '变量 xᵢ、xₙ 和 xⁿ 保留字母。';
    expect(toSpeechText(source)).toBe('变量 x 下标 i、x 下标 n 和 x 的 n 次方 保留字母。');
    expect(requiresFormulaConfirmation(source)).toBe(false);
  });
});
