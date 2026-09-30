import type { Sentence } from '../../../../../packages/shared/protocol';

// Both chunk boundaries and pronunciation changes deliberately invalidate bookmarks.
export const SEGMENTATION_VERSION = 'sentence-v2';
const MAX_SOURCE_CHARACTERS = 300;

export function textVersion(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${SEGMENTATION_VERSION}-${text.length}-${(hash >>> 0).toString(16)}`;
}

/** PDF layout wraps are not sentence ends. Never guess missing/dehyphenated words. */
function joinPdfLineWraps(text: string): string {
  return text.replace(/[^\S\r\n]*(?:\r\n?|\n)(?:[^\S\r\n]*(?:\r\n?|\n))*[^\S\r\n]*/gu, (breaks: string, offset: number) => {
    if ((breaks.match(/\r\n?|\n/g)?.length ?? 0) > 1) return '\n\n';
    const before = text.slice(0, offset).at(-1) ?? '';
    const after = text[offset + breaks.length] ?? '';
    // Chinese layout wraps do not introduce word spaces; Latin/numeric tokens do.
    return /[\p{Script=Han}，。！？；：、]/u.test(before + after) ? '' : ' ';
  });
}

const DURATION_BEFORE = /(?:历时|经过|长达|持续了?|用了|耗时|用时|花了|需要|历经|已有|相隔|间隔|每隔|大?约|大概|将近|超过|不足|不到|至少|最多|近|逾|达|满|共|累计|总计|合计|长约|为期|还有|再过|过了|等待了?|经历了?|过去了?|编号(?:为)?|序号(?:为)?|代号(?:为)?|第)\s*$/u;
const DURATION_AFTER = /^(?:多|余|之久|时间|左右|以上|以下|半|的时间|零)/u;

/** Only unambiguous four-digit calendar-year spelling; not a general number parser. */
function pronounceCalendarYears(text: string): string {
  return text.replace(/(?<![\dA-Za-z_.])([12]\d{3})[ \t]*年/gu, (match: string, year: string, offset: number) => {
    const before = text.slice(0, offset);
    const after = text.slice(offset + match.length);
    if (DURATION_BEFORE.test(before) || DURATION_AFTER.test(after)) return match;
    // Leave mathematical/code spans and identifiers for the existing correction flow.
    if (/[\dA-Za-z_=+*/^−-]\s*$/u.test(before) || /\\[A-Za-z]+[^。！？!?\n]*$/u.test(before)) return match;
    if ((before.match(/(?<!\\)\$/g)?.length ?? 0) % 2 || (before.match(/`/g)?.length ?? 0) % 2) return match;
    return [...year].map(digit => '零一二三四五六七八九'[Number(digit)]).join('') + '年';
  });
}

/** A deliberately small, auditable conversion set; sourceText is never rewritten. */
export function toSpeechText(sourceText: string): string {
  return pronounceCalendarYears(joinPdfLineWraps(sourceText).trim())
    .replace(/\\frac\s*\{\\partial\s*L\}\s*\{\\partial\s*w\}/g, '损失 L 对参数 w 的偏导')
    .replace(/∂\s*L\s*\/\s*∂\s*w/g, '损失 L 对参数 w 的偏导')
    .replace(/(?:β|\\beta)\s*_\s*\{?1\}?\s*\^\s*\{?t\}?/g, 'beta 一的 t 次方');
}

/** The UI must ask the learner to confirm unclear mathematics before reading. */
export function requiresFormulaConfirmation(text: string): boolean {
  const remainder = toSpeechText(text);
  return /[∂∑∫√^_]|\\[a-zA-Z]+|[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/u.test(remainder);
}

function startsListItem(line: string): boolean {
  return /^\s*(?:[•●▪‣]|[-*+]\s|\d{1,3}[.)、]\s|[（(]\d{1,3}[）)]|[一二三四五六七八九十]+、)/u.test(line);
}

function isStandaloneFormula(line: string): boolean {
  const value = line.trim();
  if (/^(?:\$|\\\[|\\\()/u.test(value)) return true;
  // Deliberately conservative: a prose sentence containing x = 1 is still prose.
  return value.length > 0 && !/[\p{Script=Han}。！？!?]/u.test(value)
    && !/[a-zA-Z]{4,}/u.test(value.replace(/\\[a-zA-Z]+/gu, ''))
    && /[=≈≠≤≥∑∫]|\\(?:frac|sum|int)\b/u.test(value);
}

/** Preserve paragraph/list/display-formula boundaries, not ordinary PDF line wraps. */
function hardLineEnds(text: string): Set<number> {
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/g)];
  const ends = new Set<number>();
  for (let i = 0; i < lines.length - 1; i += 1) {
    const current = lines[i];
    const next = lines[i + 1][0];
    if (!current[0].trim() || !next.trim() || startsListItem(next) || isStandaloneFormula(current[0]) || isStandaloneFormula(next)) {
      ends.add(current.index + current[0].length);
    }
  }
  return ends;
}

export function splitSentences(sourceText: string): Sentence[] {
  if (!sourceText.trim()) return [];
  const pieces: string[] = [];
  const lineEnds = hardLineEnds(sourceText);
  let start = 0;
  let terminalPending = false;
  // 300 source characters also keep the supported formula expansions below 1000.
  for (let i = 0; i < sourceText.length; i += 1) {
    const char = sourceText[i];
    const decimal = char === '.' && /\d/.test(sourceText[i - 1] ?? '') && /\d/.test(sourceText[i + 1] ?? '');
    const lineStart = Math.max(sourceText.lastIndexOf('\n', i), sourceText.lastIndexOf('\r', i)) + 1;
    const listNumber = char === '.' && /^\s*\d{1,3}$/u.test(sourceText.slice(lineStart, i)) && /\s/u.test(sourceText[i + 1] ?? '');
    const terminal = /[。！？!?]/u.test(char) || (char === '.' && !decimal && !listNumber);
    // Keep punctuation runs and closing quotes together, instead of a lone quoted tail.
    if (terminal) terminalPending = true;
    else if (!/[。！？!?.…）)】］」』”’"']/u.test(char)) terminalPending = false;
    const followedByClosing = /[。！？!?.…）)】］」』”’"']/u.test(sourceText[i + 1] ?? '');
    const boundary = (terminalPending && !followedByClosing) || lineEnds.has(i + 1);
    const limit = i - start + 1 >= MAX_SOURCE_CHARACTERS;
    if (boundary || limit) {
      // Leave a complete surrogate pair for the next chunk, staying within the bound.
      const highSurrogate = sourceText.charCodeAt(i) >= 0xd800 && sourceText.charCodeAt(i) <= 0xdbff;
      const end = highSurrogate ? i : i + 1;
      if (end > start) { pieces.push(sourceText.slice(start, end)); start = end; terminalPending = false; }
    }
  }
  if (start < sourceText.length) pieces.push(sourceText.slice(start));
  // Retain every original character, attaching whitespace-only tails when bounded.
  const chunks: string[] = [];
  for (const piece of pieces) {
    if (!piece.trim() && chunks.length && chunks[chunks.length - 1].length + piece.length <= MAX_SOURCE_CHARACTERS) chunks[chunks.length - 1] += piece;
    else if (chunks.length && !chunks[chunks.length - 1].trim() && chunks[chunks.length - 1].length + piece.length <= MAX_SOURCE_CHARACTERS) chunks[chunks.length - 1] += piece;
    else chunks.push(piece);
  }
  return chunks.map((source, index) => ({
    sentenceId: `${textVersion(sourceText)}-${index}`,
    sourceText: source,
    speechText: toSpeechText(source),
  }));
}
