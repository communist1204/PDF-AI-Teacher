export const EXTRACTION_VERSION = 'pdfjs-layout-v1';
export type TextRun = { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean };
export type ExtractedPage = { sourceText: string; readingText: string; warning: string | null; hasText: boolean };

/** Fast deterministic hash for text IDs; document identity uses SHA-256 separately. */
export function textHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function sourceIdentity(documentId: string, pageIndex: number, text: string, locator: string) {
  const blockId = `p${pageIndex}-${EXTRACTION_VERSION}-${textHash(text)}-${textHash(locator)}`;
  return { blockId, sourceId: `${documentId}:${blockId}` };
}

/** Keep original text-object order, retain formula glyphs, and only join reliable line fragments. */
export function extractPageText(runs: TextRun[]): ExtractedPage {
  const visible = runs.filter(run => run.str.trim());
  if (!visible.length) return { sourceText: '', readingText: '', warning: '本页没有可用文本层，可能是扫描页。可以框选讲解；尚不支持逐字朗读扫描页。', hasText: false };
  const sourceText = runs.map(run => `${run.str}${run.hasEOL ? '\n' : ''}`).join('');
  let readingText = '';
  let previous: TextRun | undefined;
  let suspiciousGaps = 0;
  let reverseLines = 0;
  for (const run of visible) {
    if (previous) {
      const lineHeight = Math.max(Math.abs(previous.height), Math.abs(run.height), 1);
      const sameLine = Math.abs(run.transform[5] - previous.transform[5]) < lineHeight * 0.45;
      const gap = run.transform[4] - previous.transform[4] - previous.width;
      if (!sameLine || previous.hasEOL) {
        readingText += '\n';
        if (run.transform[5] - previous.transform[5] > lineHeight * 2) reverseLines++;
      } else if (gap > lineHeight * 0.2 && !/\s$/.test(previous.str) && !/^\s/.test(run.str)) {
        readingText += ' ';
        if (gap > lineHeight * 3) suspiciousGaps++;
      }
    }
    readingText += run.str;
    previous = run;
  }
  const unreadable = /[\uFFFD\uE000-\uF8FF]/.test(sourceText) || [...sourceText].some(character => character.charCodeAt(0) < 9);
  const warning = unreadable
    ? '文本层包含无法可靠识别的字符。请与原页核对，公式建议框选确认。'
    : suspiciousGaps > 1 || reverseLines > 0
      ? '本页可能存在多栏、表格或特殊排版，阅读顺序尚未确认。建议分段选中并核对原文。'
      : null;
  return { sourceText, readingText: readingText.trim(), warning, hasText: true };
}
