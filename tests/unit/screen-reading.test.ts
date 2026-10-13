import { describe, expect, it } from 'vitest';
import { capturePixelRect, cleanOcrText } from '../../packages/shared/screenReading';

describe('screen crop pixels', () => {
  it('uses actual screenshot pixels for high-DPI normalized selections', () => {
    expect(capturePixelRect({ x: .25, y: .1, width: .5, height: .4 }, { width: 3840, height: 2160 })).toEqual({ x: 960, y: 216, width: 1920, height: 864 });
  });
  it('rounds outward without cropping away edge glyphs', () => {
    expect(capturePixelRect({ x: .1234, y: .1234, width: .1, height: .1 }, { width: 1920, height: 1080 })).toEqual({ x: 236, y: 133, width: 193, height: 109 });
  });
  for (const value of [null, {}, { x: -.1, y: 0, width: .3, height: .3 }, { x: .9, y: 0, width: .3, height: .3 }, { x: 0, y: 0, width: Infinity, height: 1 }, { x: 0, y: 0, width: .0001, height: .1 }]) {
    it('rejects invalid/outside/tiny selections: ' + JSON.stringify(value), () => {
      expect(() => capturePixelRect(value, { width: 1920, height: 1080 })).toThrow();
    });
  }
  it('removes Han segmentation spaces but preserves English/numbers and line breaks', () => {
    expect(cleanOcrText(' 神 经 网 络 。\r\nDeep learning in 2026 年。 ')).toBe('神经网络。\nDeep learning in 2026 年。');
  });
});
