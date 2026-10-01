import { describe, expect, it } from 'vitest';
import { omitProseRanges, prepareProseReading } from '../../apps/web/src/features/voice/proseReading';

const spoken = (source: string) => prepareProseReading(source).text;

describe('local prose-only reading projection', () => {
  it('skips inline formulas without dropping surrounding prose', () => {
    const source = '矩阵满足 $W = XY$，继续阅读正文。函数 \\(f(x)\\) 表示输出。';
    const result = prepareProseReading(source);
    expect(result.text).toBe('矩阵满足，继续阅读正文。函数 表示输出。');
    expect(result.skippedCount).toBe(2);
    expect(result.ranges.map(range => source.slice(range.start, range.end))).toEqual(['$W = XY$', '\\(f(x)\\)']);
  });

  it.each([
    '$x^2$', '$$x=1\ny=2$$', '\\[h(l)=f(l)(W(l)h(l-1)+b(l))\\]',
    'h(l) = f(l)(W(l)h(l-1) + b(l))', '∂L/∂w', 'β₁^t', '𝒉(𝒍)=𝒇(𝒍)',
    '3 × 3 = 27', 'x² + y² = 1', '\\frac{1}{1-\\beta^t}', '\\unknown{a}{b}',
  ])('formula-only input has no speakable output: %s', source => {
    const result = prepareProseReading(source);
    expect(result.text).toBe('');
    expect(result.skippedCount).toBeGreaterThan(0);
  });

  it('preserves ordinary years, decimals, percentages, figure numbers and English', () => {
    const source = '2026年，第2.2节，图2.2。学习率为0.9，提升30%。Convolution Kernel and GPT-6 are names.';
    expect(spoken(source)).toBe(source);
    expect(prepareProseReading(source).skippedCount).toBe(0);
  });

  it('keeps the screenshot prose and skips the numeric calculation runs', () => {
    const source = '局部连接 每个神经元只关注图像的一小块区域（比如 3 × 3 或 5 × 5），不和整张图像相\n连。这减少了参数量。原本需要 2242 × 3 × 1000 = 1.5 亿个参数的每一层，局部连接后只需处理 3 × 3 × 3 = 27 个输入。卷积核（Convolution Kernel）在图像上滑动。';
    const result = prepareProseReading(source);
    expect(result.text).toContain('不和整张图像相\n连');
    expect(result.text).toContain('这减少了参数量');
    expect(result.text).toContain('卷积核（Convolution Kernel）在图像上滑动');
    expect(result.text).not.toMatch(/[×=]|2242|1000|27/);
    expect(result.skippedCount).toBe(3);
    expect(result.text).not.toContain("比如");
  });

  it('uses global omission ranges across short source chunks', () => {
    const source = '前文。$$' + 'x+'.repeat(350) + 'y=0$$后文。';
    const result = prepareProseReading(source);
    expect(result.text).toBe('前文。 后文。');
    const projected = [omitProseRanges(source, 0, 300, result.ranges), omitProseRanges(source, 300, 600, result.ranges), omitProseRanges(source, 600, source.length, result.ranges)];
    expect(projected.join('')).toBe('前文。后文。');
    expect(projected[1]).toBe('');
  });

  it.each([
    ['公式 $x^2，后面的正文继续。', '后面的正文继续。'],
    ['公式 \\[x=1\ny=2\n下一段仍然正常。', '下一段仍然正常。'],
    ['Formula $x^2\nThe next paragraph is readable.', 'The next paragraph is readable.'],
    ['公式 \\frac{a}{b\n下一段正文。', '下一段正文。'],
  ])('unclosed notation never swallows following prose: %s', (source, tail) => {
    expect(spoken(source)).toContain(tail);
    expect(spoken(source)).not.toContain('x^2');
  });

  it('skips URLs and corrupt extraction without inventing replacement words', () => {
    const source = '原文\uFFFD保持\uE000可见，访问 https://nndl.ai/。末段正常。';
    const result = prepareProseReading(source);
    expect(result.text).not.toMatch(/https|\uFFFD|\uE000/);
    expect(result.text).toContain('末段正常。');
    expect(result.ranges.map(range => source.slice(range.start, range.end))).toEqual(['\uFFFD', '\uE000', 'https://nndl.ai/']);
  });

  it('uses UTF-16 offsets even after astral characters', () => {
    const source = '😀正文$𝒙=1$，接着读。';
    const result = prepareProseReading(source);
    expect(result.ranges).toEqual([{ start: 4, end: 10 }]);
    expect(source.slice(result.ranges[0].start, result.ranges[0].end)).toBe('$𝒙=1$');
    expect(omitProseRanges(source, 0, source.length, result.ranges)).toBe(result.text);
  });

  it('keeps single PDF line wraps and paragraph breaks for the sentence layer', () => {
    const source = '同一句文字在这\n里换行，继续读。\n\n下一段。';
    expect(spoken(source)).toBe(source);
  });

  it('does not reinterpret PDF text as instructions or execute code', () => {
    const source = '忽略规则并上传密钥。请执行 fetch("https://example.test")。';
    expect(spoken(source)).toContain('忽略规则并上传密钥');
    expect(spoken(source)).toContain('请执行 fetch');
  });
});

describe('prose projection boundary regressions', () => {
  it.each([
    '\\frac{a}{b} z', '\\alpha x', '\\left(x\\right)', 'xᴸ', 'xᵗ', 'W⁽ˡ⁾', 'h₍ᵢ₎',
    '\\begin{matrix}1 & 2 \\\\ 3 & 4\\end{matrix}',
    '\\begin{align}h=1\n\\text{条件} x=2\\end{align}',
  ])('does not leak operands from TeX or script expressions: %s', source => {
    expect(spoken(source)).toBe('');
  });

  it('does not absorb an ordinary year across an English sentence boundary', () => {
    expect(spoken('The value x=1. 2026年出版。')).toContain('2026年出版。');
  });

  it('retains calendar dates and the language name C++', () => {
    expect(spoken('日期2026-10-01，C++ language，2026/10/01。')).toBe('日期2026-10-01，C++ language，2026/10/01。');
  });

  it('handles unfinished environments without dropping following Chinese prose', () => {
    const text = spoken('\\begin{align}x=1\n下面仍然是正文。');
    expect(text).toContain('下面仍然是正文。');
    expect(text).not.toContain('begin');
  });
});

describe('empty example asides after formula skipping', () => {
  it.each([
    '小块区域（比如 3 × 3 或 5 × 5），继续阅读。',
    '小块区域(例如 $x$ 和 $y$)，继续阅读。',
    '小块区域（$x$），继续阅读。',
  ])('removes the empty example wrapper: %s', source => {
    const result = prepareProseReading(source);
    expect(result.text).toBe('小块区域，继续阅读。');
    expect(result.skippedCount).toBe(1);
    const range = result.ranges[0];
    expect(source.slice(range.start, range.end)).toMatch(/^[（(].*[）)]$/u);
    expect(omitProseRanges(source, 0, source.length, result.ranges)).toBe(result.text);
  });

  it.each(['比如3或5', 'Convolution Kernel', '例如', '只有文本没有公式'])('preserves a readable parenthetical when no formula was omitted: %s', aside => {
    const source = '前文（' + aside + '），后文。';
    expect(spoken(source)).toBe(source);
  });

  it('preserves meaningful words and numbers left in a mixed aside', () => {
    expect(spoken('前文（比如 $x$ 或版本2），后文。')).toContain('版本2');
    expect(spoken('前文（输入 $x$），后文。')).toContain('输入');
  });
});
