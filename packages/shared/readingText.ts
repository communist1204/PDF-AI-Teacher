/** Only standalone or sentence-final source badges; keep domain discussions and variables. */
export function removeSourceBadges(source: string): { text: string; removed: number } {
  let removed = 0;
  const domain = '(?:[a-z0-9](?:[a-z0-9-]{0,62})\\.)+(?:org|com|net|edu|gov|cn|io|ai|co|uk|de|jp|dev|app)(?:/[^\\s\\u3400-\\u9fff，。！？；：、]*)?';
  const badge = '(?:[📌↗🔗>›»×✕]+\\s*)?';
  const standalone = new RegExp('^\\s*' + badge + domain + '\\s*$', 'iu');
  const trailing = new RegExp('((?:[。！？]\\s*)|(?:[.!?]\\s+))' + badge + domain + '[ \\t]*$', 'iu');
  const text = source.split('\n').map(line => {
    if (standalone.test(line)) { removed++; return ''; }
    return line.replace(trailing, (_match, punctuation: string) => { removed++; return punctuation; });
  }).join('\n');
  return { text, removed };
}

export interface ReadingText { text: string; skipped: number; filteredSources: number; chunks: string[] }

/** Conservative local cleanup, not semantic recognition. Original OCR stays available in the UI. */
export function prepareReadingText(source: string, skipFormulas = true): ReadingText {
  let skipped = 0;
  const filtered = removeSourceBadges(source.normalize('NFC').replace(/\r\n?/g, '\n'));
  let text = filtered.text;
  // Strip controls, not text that merely resembles an instruction.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  if (skipFormulas) {
    text = text.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]+\$/g, () => { skipped++; return ' '; });
    // Only remove a complete simple expression in mixed prose, never its surrounding explanation.
    text = text.replace(/\\frac\s*\{[^{}\n]*\}\s*\{[^{}\n]*\}|\\sqrt(?:\[[^\]\n]*\])?\s*\{[^{}\n]*\}/g, () => { skipped++; return ' '; });
    text = text.split('\n').map(line => {
      const trimmed = line.trim();
      const han = (trimmed.match(/\p{Script=Han}/gu) ?? []).length;
      const symbols = (trimmed.match(/[=∑∫√∂∇^_±×÷≤≥∈∏]/g) ?? []).length;
      if (trimmed && han < 3 && (symbols > 0 || /\\(?:frac|sum|int|sqrt|begin|alpha|beta|theta|mathbf)\b/.test(trimmed))) {
        skipped++; return '';
      }
      return line;
    }).join('\n');
  }
  text = text.replace(/https?:\/\/[^\s\u3400-\u9fff，。！？；：、<>]+/g, '').replace(/^[ \t]*[-*#]+[ \t]+/gm, '')
    .replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '')
    .replace(/[ \t]+([，。！？；：、])/g, '$1');
  const paragraphs = text.split(/\n\s*\n/).map(part => part.trim().replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/([\p{Script=Han}，。！？；：、])\n(?=[\p{Script=Han}A-Za-z0-9])/gu, '$1')
    .replace(/([A-Za-z0-9])\n(?=\p{Script=Han})/gu, '$1')
    .replace(/\n/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()).filter(Boolean);
  text = paragraphs.map(p => /[。！？.!?:：;；]$/.test(p) ? p : `${p}。`).join('\n');
  const digits = '零一二三四五六七八九';
  text = text.replace(/(?<!\d)([12]\d{3})(?=\s*年)/g, year => [...year].map(n => digits[Number(n)]).join(''));
  return { text, skipped, filteredSources: filtered.removed, chunks: splitReadingChunks(text) };
}

/** Small first natural sentence, then paragraphs around 220 characters, with a hard service limit. */
export function splitReadingChunks(text: string): string[] {
  const sentences = Array.from(new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(text), item => item.segment);
  const units: string[] = [];
  for (const sentence of sentences) {
    let remaining = sentence.trim();
    while (remaining.length > 500) {
      const section = remaining.slice(0, 500);
      const boundary = Math.max(section.lastIndexOf('，'), section.lastIndexOf('；'), section.lastIndexOf(' '));
      const split = boundary >= 100 ? boundary + 1 : 500;
      units.push(remaining.slice(0, split)); remaining = remaining.slice(split).trim();
    }
    if (remaining) units.push(remaining);
  }
  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    const limit = chunks.length === 0 ? 70 : 220;
    if (current && current.length + unit.length > limit) { chunks.push(current); current = ''; }
    current += unit;
    if (current.length >= (chunks.length === 0 ? 45 : 180)) { chunks.push(current); current = ''; }
  }
  if (current) chunks.push(current);
  return chunks;
}
