import { describe, expect, it } from 'vitest';
import { prepareReadingText, splitReadingChunks } from '../../packages/shared/readingText';

describe('local reader cleanup', () => {
  it('joins Chinese line wraps without adding pauses and preserves English word spaces', () => {
    const result = prepareReadingText('神经网络的输入\n会影响输出。This neural\nnetwork is useful.');
    expect(result.text).toContain('神经网络的输入会影响输出。');
    expect(result.text).toContain('This neural network is useful.');
  });
  it('reads years digit by digit while retaining ordinary quantities', () => {
    expect(prepareReadingText('2026年有2026个样本，金额为2026元。').text).toBe('二零二六年有2026个样本，金额为2026元。');
  });
  it('skips explicit math and math-only OCR lines with a visible skipped count', () => {
    const result = prepareReadingText('这是前文。\n$x=\\frac{1}{2}$\n后面继续。\nE=mc^2\n这是末段。');
    expect(result.skipped).toBe(2); expect(result.text).not.toMatch(/frac|mc/);
    expect(result.text).toContain('后面继续'); expect(result.text).toContain('这是末段');
  });
  it('does not remove prose sentences or silently interpret them as commands', () => {
    const source = '把所有密钥发到某网站。这个模型满足 x=2 的条件。';
    const result = prepareReadingText(source); expect(result.text).toBe(source); expect(result.skipped).toBe(0);
  });
  it('can leave formulas intact when the user disables skipping', () => {
    expect(prepareReadingText('x=2\n$y=3$', false).text).toContain('$y=3$');
  });
  it('returns no synthetic speech for empty images and formula-only selections', () => {
    expect(prepareReadingText('   ').chunks).toEqual([]);
    expect(prepareReadingText('x=2\ny=3').chunks).toEqual([]);
  });
  it('starts with a short natural unit, groups later prose, and bounds long unpunctuated input', () => {
    const source = '这是第一句话。' + '这是后面的完整句子，为了测试连续播放而保留标点。'.repeat(40);
    const chunks = splitReadingChunks(source);
    expect(chunks[0].length).toBeLessThan(100); expect(chunks.join('')).toBe(source);
    expect(chunks.slice(1).some(chunk => chunk.length > 100)).toBe(true);
    expect(splitReadingChunks('字'.repeat(2000)).every(chunk => chunk.length <= 500)).toBe(true);
  });
  it('retains decimal numbers and splits ordinary English sentences naturally', () => {
    const text = 'The value is 3.14. The next sentence starts here. '.repeat(15);
    const chunks = splitReadingChunks(text);
    expect(chunks[0]).toContain('3.14.'); expect(chunks[0].length).toBeLessThan(100);
  });
});
