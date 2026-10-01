import { UNICODE_SCRIPT_MARKERS } from './mathSpeech';

/** Local reading projection. Original UTF-16 offsets remain the only source anchors. */
export interface ProseOmission { start: number; end: number }
export interface ProseReading { text: string; skippedCount: number; ranges: ProseOmission[] }

const CORRUPT = /[\uFFFD\u200B-\u200F]|\p{Co}|\p{Cc}/u;
const MATH_SYMBOL = /[α-ωΑ-Ωϵϑϰϖϱϕ∂∑∫√∞_^⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉\u210E\u{1D400}-\u{1D7FF}]|\p{Sm}/u;
const MATH_CHARACTER = /[A-Za-z\dα-ωΑ-Ωϵϑϰϖϱϕ∂∑∫√∞=+*/<>≤≥≠≈_^−×·÷⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁽⁾₀₁₂₃₄₅₆₇₈₉₊₋₍₎()[\]{}\s.,:−\-\u210E\u{1D400}-\u{1D7FF}]|\p{Sm}/u;
const MATH_WORDS = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'max', 'min', 'lim', 'argmax', 'argmin', 'det']);

function mergeRanges(ranges: ProseOmission[]): ProseOmission[] {
  const sorted = ranges.filter(range => range.end > range.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ProseOmission[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** An unmatched opener stops at prose, rather than swallowing the rest of a PDF page. */
function unclosedEnd(source: string, start: number): number {
  let at = start;
  while (at < source.length) {
    const char = String.fromCodePoint(source.codePointAt(at)!);
    if (/[\p{Script=Han}，。！？；]/u.test(char) || /^(?:\r?\n){2}/u.test(source.slice(at, at + 4))) break;
    const command = /^\\[A-Za-z]+/u.exec(source.slice(at))?.[0];
    if (command) { at += command.length; continue; }
    const word = /^[A-Za-z]{2,}/u.exec(source.slice(at))?.[0];
    if (word && !MATH_WORDS.has(word)) break;
    if (word) { at += word.length; continue; }
    if (!MATH_CHARACTER.test(char) && !UNICODE_SCRIPT_MARKERS.test(char) && !/[\\$`]/u.test(char) && !CORRUPT.test(char)) break;
    at += char.length;
  }
  return at;
}

function delimitedRanges(source: string): ProseOmission[] {
  const ranges: ProseOmission[] = [];
  for (let at = 0; at < source.length;) {
    if (source.startsWith('\\$', at)) { at += 2; continue; }
    const opener = source.startsWith('$$', at) ? '$$' : source.startsWith('\\[', at) ? '\\['
      : source.startsWith('\\(', at) ? '\\(' : source[at] === '$' ? '$'
      : source.startsWith('~~~', at) ? '~~~' : source[at] === '`' ? (source.startsWith('```', at) ? '```' : '`') : '';
    if (!opener) {
      const environment = /^\\begin\{([A-Za-z*]+)\}/u.exec(source.slice(at));
      if (environment) {
        const closing = '\\end{' + environment[1] + '}';
        const close = source.indexOf(closing, at + environment[0].length);
        const end = close < 0 ? unclosedEnd(source, at + environment[0].length) : close + closing.length;
        ranges.push({ start: at, end }); at = end; continue;
      }
      at += 1; continue;
    }
    const closer = opener === '\\[' ? '\\]' : opener === '\\(' ? '\\)' : opener;
    let closeAt = source.indexOf(closer, at + opener.length);
    while (closeAt >= 0 && source[closeAt - 1] === '\\') closeAt = source.indexOf(closer, closeAt + closer.length);
    // Currency is ordinary prose, not an unfinished inline formula.
    if (opener === '$' && closeAt < 0 && /^\d+(?:\.\d+)?(?:\s|[，。！？；]|$)/u.test(source.slice(at + 1))) { at += 1; continue; }
    const end = closeAt >= 0 ? closeAt + closer.length : unclosedEnd(source, at + opener.length);
    // Plain inline code/quoted English is readable; mathematical code is not.
    const content = source.slice(at + opener.length, closeAt < 0 ? end : closeAt);
    const isPlainCode = opener === '`' && !hasMath(content) && !/[\\{}]/u.test(content);
    if (isPlainCode && closeAt >= 0) ranges.push({ start: at, end: at + opener.length }, { start: closeAt, end });
    else ranges.push({ start: at, end: Math.max(end, at + opener.length) });
    at = Math.max(end, at + opener.length);
  }
  return ranges;
}

function hasMath(value: string): boolean {
  if (/^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|C\+\+)$/u.test(value.trim())) return false;
  return MATH_SYMBOL.test(value) || UNICODE_SCRIPT_MARKERS.test(value) || /[=+*/<>≤≥≠≈×÷]/u.test(value)
    || /[A-Za-z\d)\]}]\s*[−-]\s*[A-Za-z\d([{]/u.test(value)
    || /[A-Za-z][([]\s*[A-Za-z\d]/u.test(value);
}

function blankRanges(source: string, ranges: readonly ProseOmission[]): string {
  const pieces: string[] = []; let from = 0;
  for (const range of ranges) {
    pieces.push(source.slice(from, range.start), ' '.repeat(range.end - range.start)); from = range.end;
  }
  return pieces.join('') + source.slice(from);
}

/** Skip TeX commands together with balanced argument groups, including unknown commands. */
function commandRanges(source: string): ProseOmission[] {
  const ranges: ProseOmission[] = [];
  for (let at = 0; at < source.length;) {
    const match = /^\\[A-Za-z]+\*?/u.exec(source.slice(at));
    if (!match) { at += 1; continue; }
    let end = at + match[0].length;
    while (end < source.length) {
      const space = /^[ \t]*/u.exec(source.slice(end))![0].length;
      const begin = end + space;
      const opener = source[begin]; const closer = opener === '{' ? '}' : opener === '[' ? ']' : '';
      if (!closer) break;
      let depth = 1; let next = begin + 1;
      for (; next < source.length && depth; next += 1) {
        if (/[\r\n]/u.test(source[next]) && /^(?:\r?\n){2}/u.test(source.slice(next, next + 4))) break;
        if (source[next] === opener) depth += 1;
        else if (source[next] === closer) depth -= 1;
      }
      if (depth) { end = unclosedEnd(source, begin); break; }
      end = next;
    }
    ranges.push({ start: at, end }); at = end;
  }
  return ranges;
}

function bareMathRanges(source: string): ProseOmission[] {
  const ranges: ProseOmission[] = [];
  let runStart = 0; let at = 0;
  const flush = (end: number) => {
    const run = source.slice(runStart, end);
    if (!hasMath(run)) return;
    const leading = /^[\s.,:]+/u.exec(run)?.[0].length ?? 0;
    const trailing = /[\s.,:]+$/u.exec(run)?.[0].length ?? 0;
    if (end - trailing > runStart + leading) ranges.push({ start: runStart + leading, end: end - trailing });
  };
  while (at < source.length) {
    const char = String.fromCodePoint(source.codePointAt(at)!);
    const word = /^[A-Za-z]{2,}/u.exec(source.slice(at))?.[0];
    const mathWord = !!word && MATH_WORDS.has(word) && /^\s*[([{]/u.test(source.slice(at + word.length));
    const sentencePeriod = char === '.' && !(/\d/u.test(source[at - 1] ?? '') && /\d/u.test(source[at + 1] ?? ''))
      && !(source[at - 1] === '.' || source[at + 1] === '.');
    if (sentencePeriod || (word && !mathWord) || (!MATH_CHARACTER.test(char) && !UNICODE_SCRIPT_MARKERS.test(char)) || /^(?:\r?\n){2}/u.test(source.slice(at, at + 4))) {
      flush(at); at += word?.length ?? char.length; runStart = at;
    } else at += word?.length ?? char.length;
  }
  flush(at);
  return ranges;
}

/** Project an original source interval; no offset refers to the shortened spoken text. */
export function omitProseRanges(source: string, start: number, end: number, ranges: readonly ProseOmission[]): string {
  const lower = Math.max(0, Math.min(source.length, start));
  const upper = Math.max(lower, Math.min(source.length, end));
  let from = lower; const pieces: string[] = [];
  for (const range of ranges) {
    if (range.end <= lower) continue;
    if (range.start >= upper) break;
    pieces.push(source.slice(from, Math.max(from, range.start)), ' ');
    from = Math.min(upper, Math.max(from, range.end));
  }
  pieces.push(source.slice(from, upper));
  // Removing a formula may leave only its wrapper; do not speak an empty parenthesis.
  return pieces.join('').replace(/[（([{]\s*[）)\]}]/gu, ' ')
    .replace(/[ \t]{2,}/gu, ' ').replace(/\s+([，。！？；：、,.!?;:])/gu, '$1')
    .replace(/([，；：、,;:])[ \t]*([，。！？；：、,.!?;:])/gu, '$2').trim();
}

/** Remove an example aside only when omissions leave nothing except connective words. */
function emptyExampleAsides(source: string, ranges: readonly ProseOmission[]): ProseOmission[] {
  const openings: Array<{ start: number; closer: string }> = [];
  const omissions: ProseOmission[] = [];
  for (let at = 0; at < source.length; at += 1) {
    if (source[at] === '(' || source[at] === '（') openings.push({ start: at, closer: source[at] === '(' ? ')' : '）' });
    else if (source[at] === ')' || source[at] === '）') {
      const opening = openings.pop();
      if (!opening || opening.closer !== source[at]) continue;
      const containsOmission = ranges.some(range => range.start < at && range.end > opening.start + 1);
      if (!containsOmission) continue;
      const remaining = omitProseRanges(source, opening.start + 1, at, ranges);
      if (/^(?:(?:比如|例如|以及|如|或|和|与|及)|[\s，、,;；])*$/u.test(remaining)) omissions.push({ start: opening.start, end: at + 1 });
    }
  }
  return omissions;
}

/** Default prose-only reading is deterministic and never calls an AI or network API. */
export function prepareProseReading(source: string): ProseReading {
  let ranges = delimitedRanges(source);
  let remaining = blankRanges(source, mergeRanges(ranges));
  for (const match of remaining.matchAll(/(?:https?:\/\/|www\.)[^\s\p{Script=Han}，。！？；<>]+/gu)) {
    const value = match[0].replace(/[.,!?;:]+$/u, '');
    ranges.push({ start: match.index, end: match.index + value.length });
  }
  for (let at = 0; at < remaining.length;) {
    const char = String.fromCodePoint(remaining.codePointAt(at)!);
    if (char !== '\n' && char !== '\r' && char !== '\t' && CORRUPT.test(char)) ranges.push({ start: at, end: at + char.length });
    at += char.length;
  }
  remaining = blankRanges(source, mergeRanges(ranges));
  const commands = commandRanges(remaining);
  ranges.push(...commands);
  remaining = blankRanges(source, mergeRanges(ranges));
  // A command is still a mathematical boundary marker after its arguments are hidden.
  // This also skips adjacent bare operands, e.g. a fraction followed by z.
  const marked = remaining.split('');
  for (const command of commands) marked[command.start] = '=';
  remaining = marked.join('');
  ranges.push(...bareMathRanges(remaining));
  ranges = mergeRanges(ranges);
  ranges = mergeRanges([...ranges, ...emptyExampleAsides(source, ranges)]);
  const text = omitProseRanges(source, 0, source.length, ranges);
  return { text: /[\p{L}\p{N}]/u.test(text) ? text : '', skippedCount: ranges.length, ranges };
}

