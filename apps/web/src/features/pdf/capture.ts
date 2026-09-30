import { AnnotationMode, type PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfTarget } from '../../../../../packages/shared/protocol';
import { pageToDisplayRect } from './geometry';

export type CaptureSelection = (target: PdfTarget, signal: AbortSignal) => Promise<string>;
/** Render only the explicitly selected page locally, then send only its selected rectangle. */
export async function captureSelection(pdf: PDFDocumentProxy, target: PdfTarget, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!target.rect || target.pageIndex < 0 || target.pageIndex >= pdf.numPages) throw new Error('无法定位原文选区，请重新选中这一段。');
  const page = await pdf.getPage(target.pageIndex + 1); signal.throwIfAborted();
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(base.width, base.height)) });
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d'); if (!context) throw new Error('选区截图失败，请重新打开 PDF。');
  const task = page.render({ canvas, canvasContext: context, viewport, annotationMode: AnnotationMode.DISABLE });
  const abort = () => task.cancel(); signal.addEventListener('abort', abort, { once: true });
  try {
    await task.promise; signal.throwIfAborted();
    const [left, top, right, bottom] = pageToDisplayRect(target.rect, viewport);
    const x = Math.max(0, Math.floor(left) - 3), y = Math.max(0, Math.floor(top) - 3);
    const width = Math.min(canvas.width - x, Math.ceil(right) + 3 - x), height = Math.min(canvas.height - y, Math.ceil(bottom) + 3 - y);
    if (width < 1 || height < 1) throw new Error('选区没有可识别的画面，请重新选中这一段。');
    const crop = document.createElement('canvas'); crop.width = width; crop.height = height;
    crop.getContext('2d')!.drawImage(canvas, x, y, width, height, 0, 0, width, height);
    const image = crop.toDataURL('image/png'); crop.width = crop.height = 0;
    if (image.length > 3_000_000) throw new Error('选区截图过大，请缩小到一段文字或一个公式。');
    return image;
  } finally { signal.removeEventListener('abort', abort); canvas.width = canvas.height = 0; }
}
