export type ScreenCapture = { id: string; imageDataUrl: string; width: number; height: number };
export type ScreenRecognition = { id: string; text: string; language: string; elapsedMs: number };
export type ScreenReadingBridge = {
  capture(): Promise<ScreenCapture | null>;
  recognize(id: string): Promise<ScreenRecognition>;
  cancel(): Promise<void>;
};
export type CaptureRect = { x: number; y: number; width: number; height: number };

/** UI uses normalized coordinates; actual capturer pixels, not monitor DPI, define the crop. */
export function capturePixelRect(value: unknown, size: { width: number; height: number }): CaptureRect {
  const rect = value as CaptureRect | null;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
    || rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001
    || ![size.width, size.height].every(n => Number.isInteger(n) && n > 0 && n <= 32000)) throw Error('截图范围无效，请重新框选。');
  const x = Math.floor(rect.x * size.width), y = Math.floor(rect.y * size.height);
  const right = Math.min(size.width, Math.ceil((rect.x + rect.width) * size.width));
  const bottom = Math.min(size.height, Math.ceil((rect.y + rect.height) * size.height));
  if (right - x < 8 || bottom - y < 8) throw Error('选区太小，请框选一段清晰文字。');
  return { x, y, width: right - x, height: bottom - y };
}

/** Windows Chinese OCR separates individual Han words with spaces; keep Latin word boundaries. */
export function cleanOcrText(text: string): string {
  // Strip OCR control characters while preserving line/word boundaries.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/(?<=[\p{Script=Han}])[ \t]+(?=[\p{Script=Han}，。！？；：、])/gu, '')
    .replace(/[ \t]+([，。！？；：、])/gu, '$1').trim();
}
