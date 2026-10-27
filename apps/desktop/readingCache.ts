import { createHash } from 'node:crypto';
import type { ScreenRecognition } from '../../packages/shared/screenReading';
type Result = Omit<ScreenRecognition, 'id' | 'elapsedMs'>;
/** A small process-only cache: no screenshot, text, or audio is written to disk. */
export class ReadingCache {
  private entries = new Map<string, Result>();
  key(png: Buffer, profileId: string, model: string, skipFormulas: boolean): string {
    return createHash('sha256').update(JSON.stringify([profileId, model, skipFormulas])).update(png).digest('hex');
  }
  get(key: string): Result | undefined { const value = this.entries.get(key); return value ? structuredClone(value) : undefined; }
  put(key: string, value: Result, signal: AbortSignal): void {
    if (signal.aborted || value.reviewRequired || !value.text.trim()) return;
    this.entries.delete(key); this.entries.set(key, structuredClone(value));
    while (this.entries.size > 4) this.entries.delete(this.entries.keys().next().value!);
  }
  clear(): void { this.entries.clear(); }
}
