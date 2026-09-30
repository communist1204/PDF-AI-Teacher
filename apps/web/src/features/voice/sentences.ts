import type { Sentence } from '../../../../../packages/shared/protocol';
import { mathToSpeech } from './mathSpeech';

// Both chunk boundaries and pronunciation changes deliberately invalidate bookmarks.
export const SEGMENTATION_VERSION = 'sentence-v3';
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

const MAX_SPEECH_CHARACTERS = 1400;
const STRONG_MATH = /[α-ωΑ-Ωϵϑϰϖϱϕ∂∑∫√∞^_⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]|\\[A-Za-z]+/u;
interface ExplicitSpan { start: number; end: number; closed: boolean; code: boolean }
interface SpeechAnalysis { speechText: string; reviewRequired: boolean }

/** Exact delimiters are stronger evidence than guesses about surrounding prose. */
function explicitSpans(text: string): ExplicitSpan[] {
  const spans: ExplicitSpan[] = [];
  for (let at = 0; at < text.length;) {
    if (text[at] === '\\' && text[at + 1] === '$') { at += 2; continue; }
    const code = text[at] === '`';
    const opener = code ? (text.startsWith('```', at) ? '```' : '`')
      : text.startsWith('$$', at) ? '$$' : text[at] === '$' ? '$'
      : text.startsWith('\\(', at) ? '\\(' : text.startsWith('\\[', at) ? '\\[' : '';
    if (!opener) { at += 1; continue; }
    const closer = opener === '\\(' ? '\\)' : opener === '\\[' ? '\\]' : opener;
    let closeAt = text.indexOf(closer, at + opener.length);
    while (closeAt >= 0 && closer.startsWith('$') && text[closeAt - 1] === '\\') closeAt = text.indexOf(closer, closeAt + closer.length);
    const end = closeAt < 0 ? text.length : closeAt + closer.length;
    spans.push({ start: at, end, closed: closeAt >= 0, code });
    at = end;
  }
  return spans;
}

function convertMathRun(text: string, explicit = false): SpeechAnalysis {
  const leading = /^\s*/u.exec(text)![0];
  const trailing = /\s*$/u.exec(text)![0];
  const value = text.trim();
  // Sentence punctuation is outside an unwrapped formula, not a missing operand.
  const punctuation = explicit ? '' : /[。！？!?;；:.]$/u.exec(value)?.[0] ?? '';
  const formula = punctuation ? value.slice(0, -punctuation.length) : value;
  const result = mathToSpeech(formula, { format: explicit ? 'latex' : 'unicode' });
  return result.status === 'converted'
    ? { speechText: leading + result.speechText + punctuation + trailing, reviewRequired: false }
    : { speechText: text, reviewRequired: true };
}

/** Bare math is limited to runs with a strong marker; English words end a run. */
function convertInlineMath(text: string): SpeechAnalysis {
  let output = ''; let run = ''; let reviewRequired = false;
  const flush = () => {
    if (!run) return;
    if (STRONG_MATH.test(run)) {
      const result = convertMathRun(run);
      output += result.speechText; reviewRequired ||= result.reviewRequired;
    } else output += run;
    run = '';
  };
  for (let at = 0; at < text.length;) {
    const remaining = text.slice(at);
    const command = /^\\(?:[A-Za-z]+|[,;! ])/u.exec(remaining)?.[0];
    if (command) { run += command; at += command.length; continue; }
    const word = /^[A-Za-z]+/u.exec(remaining)?.[0];
    if (word && word.length > 1) { flush(); output += word; at += word.length; continue; }
    const char = text[at++];
    if (/[A-Za-z\dα-ωΑ-Ωϵϑϰϖϱϕ∂∑∫√∞=+*/<>≤≥≠≈_^−×·÷⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁽⁾₀₁₂₃₄₅₆₇₈₉₊₋₍₎()[\]{}\s.-]/u.test(char)) run += char;
    else { flush(); output += char; }
  }
  flush();
  return { speechText: output, reviewRequired };
}

function analyzeBlock(text: string): SpeechAnalysis {
  const spans = explicitSpans(text);
  if (!spans.length && isStandaloneFormula(text)) return convertMathRun(text);
  let speechText = ''; let reviewRequired = false; let from = 0;
  for (const span of spans) {
    const prefix = convertInlineMath(text.slice(from, span.start));
    speechText += prefix.speechText; reviewRequired ||= prefix.reviewRequired;
    const source = text.slice(span.start, span.end);
    if (!span.closed || span.code) {
      speechText += source;
      reviewRequired ||= !span.closed || STRONG_MATH.test(source);
    } else {
      const result = convertMathRun(source, true);
      speechText += result.speechText; reviewRequired ||= result.reviewRequired;
    }
    from = span.end;
  }
  const tail = convertInlineMath(text.slice(from));
  return { speechText: speechText + tail.speechText, reviewRequired: reviewRequired || tail.reviewRequired };
}

function analyzeSpeech(sourceText: string): SpeechAnalysis {
  let from = 0; let speechText = '';
  let reviewRequired = /[\uFFFD\u200B-\u200F]|\p{Co}|\p{Cc}/u.test(sourceText.replace(/[\t\r\n]/gu, ''));
  const ends = [...hardLineEnds(sourceText), sourceText.length];
  for (const end of ends) {
    const source = sourceText.slice(from, end);
    const boundary = end < sourceText.length && /[\r\n]$/u.test(source);
    const normalized = pronounceCalendarYears(joinPdfLineWraps(source).trim());
    const result = analyzeBlock(normalized);
    speechText += result.speechText + (boundary ? '\n' : '');
    reviewRequired ||= result.reviewRequired;
    from = end;
  }
  speechText = speechText.trim();
  return { speechText, reviewRequired: reviewRequired || speechText.length > MAX_SPEECH_CHARACTERS };
}

/** Original source is retained separately; unknown formulas remain visible for review. */
export function toSpeechText(sourceText: string): string { return analyzeSpeech(sourceText).speechText; }

/** Call on original source before playback; a long/unknown formula never means permission. */
export function requiresFormulaConfirmation(text: string): boolean {
  // Check before splitting: a source made entirely of invisible controls has no sentences.
  if (/[\uFFFD\u200B-\u200F]|\p{Co}|\p{Cc}/u.test(text.replace(/[\t\r\n]/gu, ''))) return true;
  // A long, unwrapped formula must not become several independently approved fragments.
  let from = 0;
  for (const end of [...hardLineEnds(text), text.length]) {
    const source = text.slice(from, end).trim();
    if (source.length > MAX_SOURCE_CHARACTERS && isStandaloneFormula(source)) return true;
    from = end;
  }
  return splitSentences(text).some(sentence => analyzeSpeech(sentence.sourceText).reviewRequired);
}

function startsListItem(line: string): boolean {
  return /^\s*(?:[•●▪‣]|[-*+]\s|\d{1,3}[.)、]\s|[（(]\d{1,3}[）)]|[一二三四五六七八九十]+、)/u.test(line);
}

function isStandaloneFormula(line: string): boolean {
  const value = line.trim().replace(/[。！？!?;；:.]$/u, '');
  if (/^(?:\$|\\\[|\\\()/u.test(value)) return true;
  // English words and Han prose are not inferred to be mathematical identifiers.
  return value.length > 0 && !/[\p{Script=Han}。！？!?]/u.test(value)
    && !/[A-Za-z]{2,}/u.test(value.replace(/\\[A-Za-z]+/gu, ''))
    && (STRONG_MATH.test(value) || /[=+*/<>≈≠≤≥−×·÷]|[A-Za-z\d]\s*-/u.test(value));
}

/** Preserve paragraphs, lists and display formulas, not wraps inside a formula. */
function hardLineEnds(text: string): Set<number> {
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/g)];
  const spans = explicitSpans(text);
  const ends = new Set<number>();
  for (let i = 0; i < lines.length - 1; i += 1) {
    const current = lines[i]; const next = lines[i + 1][0];
    const end = current.index + current[0].length;
    if (spans.some(span => span.start < end && end < span.end)) continue;
    const paragraphOrList = !current[0].trim() || !next.trim() || startsListItem(next);
    const nextMath = isStandaloneFormula(next) || /^[\s{}()[\]\d.+*/_^−-]+$/u.test(next);
    const continuation = nextMath && isStandaloneFormula(current[0]) && convertMathRun(current[0]).reviewRequired;
    if (paragraphOrList || (!continuation && (isStandaloneFormula(current[0]) || isStandaloneFormula(next)))) ends.add(end);
  }
  return ends;
}

export function splitSentences(sourceText: string): Sentence[] {
  if (!sourceText.trim()) return [];
  const pieces: string[] = [];
  const lineEnds = hardLineEnds(sourceText);
  const protectedSpans = explicitSpans(sourceText);
  let start = 0;
  let terminalPending = false;
  // Bound original chunks; expanded speech over 1400 characters requires review.
  for (let i = 0; i < sourceText.length; i += 1) {
    const char = sourceText[i];
    const decimal = char === '.' && /[\d=+*/(\s−-]/u.test(sourceText[i - 1] ?? '') && /\d/.test(sourceText[i + 1] ?? '');
    const lineStart = Math.max(sourceText.lastIndexOf('\n', i), sourceText.lastIndexOf('\r', i)) + 1;
    const listNumber = char === '.' && /^\s*\d{1,3}$/u.test(sourceText.slice(lineStart, i)) && /\s/u.test(sourceText[i + 1] ?? '');
    const terminal = (/[。！？!?]/u.test(char) && sourceText[i - 1] !== '\\') || (char === '.' && !decimal && !listNumber);
    // Keep punctuation runs and closing quotes together, instead of a lone quoted tail.
    if (terminal) terminalPending = true;
    else if (!/[。！？!?.…）)】］」』”’"']/u.test(char)) terminalPending = false;
    const followedByClosing = /[。！？!?.…）)】］」』”’"']/u.test(sourceText[i + 1] ?? '');
    const insideSpan = protectedSpans.some(span => span.start <= i && i < span.end - 1);
    const boundary = !insideSpan && ((terminalPending && !followedByClosing) || lineEnds.has(i + 1));
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
