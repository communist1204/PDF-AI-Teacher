import { describe, expect, it } from 'vitest';
import { splitSentences, splitSourceSentences, sourceTextVersion, textVersion } from '../../apps/web/src/features/voice/sentences';

describe('source prose projection and cursor identity', () => {
  it('keeps raw subtitle and year/wrap pronunciation, removes inline formulas without model use', () => {
    const text = '在2026年，模型\\n学会了表达。式子为 $x=y$，这是映射。'.replace('\\n','\n');
    const sentences = splitSourceSentences(text, 'prose');
    expect(sentences.map(s => s.sourceText).join('')).toBe(text);
    const speech = sentences.map(s => s.speechText).join('');
    expect(speech).toContain('二零二六年');
    expect(speech).toContain('模型学会了表达');
    expect(speech).toContain('这是映射');
    expect(speech).not.toContain('x=y');
    expect(sentences.every(s => s.sentenceId.startsWith('prose-v1-'))).toBe(true);
  });
  it('skips a display-only sentence but retains original identifiers for later prose', () => {
    const source = '先看概念。\n$$x=y$$\n再看直觉。';
    const prose = splitSourceSentences(source, 'prose');
    expect(prose).toHaveLength(2);
    expect(prose[1].sourceText).toContain('再看直觉');
    const original = splitSentences(source).find(s => s.sourceText.includes('再看直觉'))!;
    expect(prose[1].sentenceId).toBe('prose-v1-' + original.sentenceId);
  });
  it('a long explicit formula cannot leak when a source chunk boundary falls within it', () => {
    const source = '前文。$$' + 'a+'.repeat(350) + 'b$$后文。';
    const prose = splitSourceSentences(source, 'prose');
    expect(prose.map(s => s.speechText).join('')).toBe('前文。后文。');
    expect(prose.map(s => s.speechText).join('')).not.toContain('a');
  });
  it('strict capability stays available and policy changes invalidate old bookmarks', () => {
    const source = '值为 $x=y$。';
    expect(splitSourceSentences(source)).toEqual(splitSentences(source));
    expect(sourceTextVersion(source)).toBe(textVersion(source));
    expect(sourceTextVersion(source, 'prose')).not.toBe(textVersion(source));
    expect(splitSourceSentences('$$x=y$$','prose')).toEqual([]);
  });
});
