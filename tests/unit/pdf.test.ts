import { describe, expect, it } from 'vitest';
import { displayToPageRect, pageToDisplayRect, pdfPageNumber, unionRects, type ViewportTransform } from '../../apps/web/src/features/pdf/geometry';
import { extractPageText, sourceIdentity, textHash } from '../../apps/web/src/features/pdf/text';

function viewport(rotation: number, scale: number): ViewportTransform {
  // Deliberately offset crop box; canonical top-left space is 200 × 100.
  return {
    viewBox: [30, 50, 230, 150],
    convertToViewportPoint(x, y) {
      const a = x - 30, b = 150 - y;
      const point = rotation === 90 ? [100 - b, a] : rotation === 180 ? [200 - a, 100 - b] : rotation === 270 ? [b, 200 - a] : [a, b];
      return point.map(n => n * scale);
    },
    convertToPdfPoint(x, y) {
      const a = x / scale, b = y / scale;
      const point = rotation === 90 ? [b, 100 - a] : rotation === 180 ? [200 - a, 100 - b] : rotation === 270 ? [200 - b, a] : [a, b];
      return [30 + point[0], 150 - point[1]];
    },
  };
}

describe('PDF coordinates and stable source identity', () => {
  for (const rotation of [0, 90, 180, 270]) for (const scale of [0.5, 1, 2.5]) {
    it(`round trips cropped page at ${rotation}° / ${scale}×`, () => {
      const transform = viewport(rotation, scale);
      const rect: [number, number, number, number] = [0.1, 0.2, 0.6, 0.8];
      const result = displayToPageRect(pageToDisplayRect(rect, transform), transform);
      result.forEach((value, index) => expect(value).toBeCloseTo(rect[index]));
    });
  }
  it('uses correct clockwise orientation and clamps off-page selection', () => {
    expect(pageToDisplayRect([0, 0, 0.2, 0.1], viewport(90, 1))).toEqual([90, 0, 100, 40]);
    expect(displayToPageRect([-10, -10, 500, 500], viewport(0, 1))).toEqual([0, 0, 1, 1]);
    expect(unionRects([[0, 1, 3, 4], [2, 0, 5, 2]])).toEqual([0, 0, 5, 4]);
  });
  it('converts page indices centrally and rejects invalid indices', () => {
    expect(pdfPageNumber(0)).toBe(1);
    expect(pdfPageNumber(103)).toBe(104);
    expect(() => pdfPageNumber(-1)).toThrow();
  });
  it('keeps text IDs stable but isolates changes, locations and documents', () => {
    const identity = sourceIdentity('doc-a', 0, 'β₁ᵗ 不是 β₁×t', 'run1:0-run2:4');
    expect(sourceIdentity('doc-a', 0, 'β₁ᵗ 不是 β₁×t', 'run1:0-run2:4')).toEqual(identity);
    expect(sourceIdentity('doc-a', 0, 'β₁ᵗ', 'run1:0-run2:4').blockId).not.toBe(identity.blockId);
    expect(sourceIdentity('doc-a', 0, 'β₁ᵗ 不是 β₁×t', 'run3:0-run4:4').blockId).not.toBe(identity.blockId);
    expect(sourceIdentity('doc-b', 0, 'β₁ᵗ 不是 β₁×t', 'run1:0-run2:4').sourceId).not.toBe(identity.sourceId);
    expect(textHash('中文')).not.toBe(textHash('英文'));
  });
});

describe('conservative text extraction', () => {
  const run = (str: string, x: number, y: number, width = 20) => ({ str, transform: [1, 0, 0, 10, x, y], width, height: 10 });
  it('retains formula glyphs and original text while reconstructing lines', () => {
    const result = extractPageText([run('偏差修正', 0, 100), run('β₁ᵗ', 20, 100), run('m̂ = m/(1−β₁ᵗ)', 0, 80)]);
    expect(result.sourceText).toBe('偏差修正β₁ᵗm̂ = m/(1−β₁ᵗ)');
    expect(result.readingText).toBe('偏差修正β₁ᵗ\nm̂ = m/(1−β₁ᵗ)');
  });
  it('marks empty or suspicious extracted pages instead of guessing', () => {
    expect(extractPageText([]).hasText).toBe(false);
    expect(extractPageText([]).warning).toContain('扫描页');
    expect(extractPageText([run('a�', 0, 100)]).warning).toContain('核对');
    expect(extractPageText([run('左栏末尾', 0, 20), run('右栏开头', 100, 100)]).warning).toContain('多栏');
  });
});
