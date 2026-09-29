import type { Sentence } from '../../../../../packages/shared/protocol';

// Version changes deliberately invalidate bookmarks when segmentation changes.
export const SEGMENTATION_VERSION = 'sentence-v1';

export function textVersion(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${SEGMENTATION_VERSION}-${text.length}-${(hash >>> 0).toString(16)}`;
}

/** A deliberately small, auditable conversion set; sourceText is never rewritten. */
export function toSpeechText(sourceText: string): string {
  return sourceText
    .replace(/\\frac\s*\{\\partial\s*L\}\s*\{\\partial\s*w\}/g, '损失 L 对参数 w 的偏导')
    .replace(/∂\s*L\s*\/\s*∂\s*w/g, '损失 L 对参数 w 的偏导')
    .replace(/(?:β|\\beta)\s*_\s*\{?1\}?\s*\^\s*\{?t\}?/g, 'beta 一的 t 次方');
}

/** The UI must ask the learner to confirm unclear mathematics before reading. */
export function requiresFormulaConfirmation(text: string): boolean {
  const remainder = toSpeechText(text);
  return /[∂∑∫√^_]|\\[a-zA-Z]+|[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/u.test(remainder);
}

export function splitSentences(sourceText: string): Sentence[] {
  if (!sourceText.trim()) return [];
  const pieces: string[] = [];
  let start = 0;
  // 300 source characters also keep the supported formula expansions below 1000.
  for (let i = 0; i < sourceText.length; i += 1) {
    const char = sourceText[i];
    const decimal = char === '.' && /\d/.test(sourceText[i - 1] ?? '') && /\d/.test(sourceText[i + 1] ?? '');
    const boundary = /[。！？!?；;\n]/u.test(char) || (char === '.' && !decimal);
    const limit = i - start + 1 >= 300;
    // Do not split a surrogate pair when a long paragraph reaches the chunk limit.
    const highSurrogate = sourceText.charCodeAt(i) >= 0xd800 && sourceText.charCodeAt(i) <= 0xdbff;
    if ((boundary || limit) && !highSurrogate) {
      pieces.push(sourceText.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < sourceText.length) pieces.push(sourceText.slice(start));
  // Retain whitespace in the original text, attaching whitespace-only tails.
  const chunks: string[] = [];
  for (const piece of pieces) {
    if (!piece.trim() && chunks.length && chunks[chunks.length - 1].length + piece.length <= 300) chunks[chunks.length - 1] += piece;
    else chunks.push(piece);
  }
  return chunks.map((source, index) => ({
    sentenceId: `${textVersion(sourceText)}-${index}`,
    sourceText: source,
    speechText: toSpeechText(source),
  }));
}
