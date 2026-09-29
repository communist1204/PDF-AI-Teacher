/** Rectangles are [left, top, right, bottom] in unrotated crop-page coordinates. */
export type Rect = [number, number, number, number];
export type ViewportTransform = {
  viewBox: number[];
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
};
export const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));

export function orderedRect(rect: Rect): Rect {
  return [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
}

/** Converts CSS-pixel coordinates through the actual PDF.js transform, including crop/rotation. */
export function displayToPageRect(rect: Rect, viewport: ViewportTransform): Rect {
  const [xmin, ymin, xmax, ymax] = viewport.viewBox;
  const points = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]]
    .map(([x, y]) => viewport.convertToPdfPoint(x, y))
    .map(([x, y]) => [clamp((x - xmin) / (xmax - xmin)), clamp((ymax - y) / (ymax - ymin))]);
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}

export function pageToDisplayRect(rect: Rect, viewport: ViewportTransform): Rect {
  const [xmin, ymin, xmax, ymax] = viewport.viewBox;
  const points = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]]
    .map(([x, y]) => viewport.convertToViewportPoint(xmin + x * (xmax - xmin), ymax - y * (ymax - ymin)));
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  return [Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])), Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))];
}

export function pdfPageNumber(pageIndex: number): number {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new Error('无效 PDF 页索引');
  return pageIndex + 1;
}
