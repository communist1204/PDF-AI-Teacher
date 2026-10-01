import type { Response, ResponseStreamEvent } from 'openai/resources/responses/responses';
import { HttpError } from './errors';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 512;
const MAX_PARTS = 512;
type ObjectValue = Record<string, unknown>;
type MessageState = { id: string; allowed: boolean; incomplete: boolean; parts: Map<number, string>; refused: boolean };
function object(value: unknown): ObjectValue | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined; }
function index(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < MAX_ITEMS; }
function finalMessage(item: ObjectValue): boolean {
  // phase is part of the official SDK. Reject non-final channel metadata too,
  // if an upstream transport supplies it; never treat analysis as the answer.
  return item.type === 'message' && item.role === 'assistant'
    && (item.phase == null || item.phase === 'final_answer')
    && (item.channel == null || item.channel === 'final' || item.channel === 'final_answer');
}

/** Assemble only final assistant text from documented Responses SSE events.
 * Caller must reject failed/incomplete streams and require response.completed
 * before finish(). No incremental contents are exposed as a usable lesson.
 */
export class ResponseTextCollector {
  private readonly messages = new Map<number, MessageState>();
  private totalBytes = 0;
  constructor(private readonly requestId?: string) {}
  private limit(): never { throw new HttpError(502, 'model_output_too_large', '模型返回内容超出本机安全上限，未执行板书。请缩小问题后手动重试。', this.requestId); }
  private put(state: MessageState, contentIndex: number, text: string, append = false): void {
    if (!state.allowed || state.incomplete || !index(contentIndex)) return;
    if (!state.parts.has(contentIndex) && state.parts.size >= MAX_PARTS) this.limit();
    const old = state.parts.get(contentIndex) ?? '';
    const bytes = this.totalBytes - Buffer.byteLength(old) + (append ? Buffer.byteLength(old) : 0) + Buffer.byteLength(text);
    if (bytes > MAX_TEXT_BYTES) this.limit();
    state.parts.set(contentIndex, append ? old + text : text);
    this.totalBytes = bytes;
  }
  private clear(state: MessageState): void {
    for (const text of state.parts.values()) this.totalBytes -= Buffer.byteLength(text);
    state.parts.clear();
  }
  private message(outputIndex: number, value: unknown, replaceContent: boolean): void {
    const item = object(value);
    if (!item || !index(outputIndex) || typeof item.id !== 'string' || item.id.length > 256) return;
    let state = this.messages.get(outputIndex);
    if (state && state.id !== item.id) return;
    if (!state) {
      if (this.messages.size >= MAX_ITEMS) this.limit();
      state = { id: item.id, allowed: finalMessage(item), incomplete: item.status === 'incomplete', parts: new Map(), refused: false };
      this.messages.set(outputIndex, state);
    } else {
      state.allowed = state.allowed && finalMessage(item);
      state.incomplete ||= item.status === 'incomplete';
    }
    if (!state.allowed || state.incomplete) { this.clear(state); return; }
    if (!Array.isArray(item.content)) return;
    if (item.content.length > MAX_PARTS) this.limit();
    if (replaceContent && item.content.length) this.clear(state);
    item.content.forEach((value, contentIndex) => {
      const part = object(value);
      if (part?.type === 'output_text' && typeof part.text === 'string' && (replaceContent || part.text.length)) this.put(state!, contentIndex, part.text);
      if (part?.type === 'refusal') state!.refused = true;
    });
  }
  accept(event: ResponseStreamEvent): void {
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      this.message(event.output_index, event.item, true); return;
    }
    if (event.type !== 'response.output_text.delta' && event.type !== 'response.output_text.done' && event.type !== 'response.content_part.done' && event.type !== 'response.refusal.done') return;
    const state = this.messages.get(event.output_index);
    // Metadata is required to know that text belongs to a final assistant message.
    if (!state || state.id !== event.item_id || !state.allowed || state.incomplete) return;
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') this.put(state, event.content_index, event.delta, true);
    if (event.type === 'response.output_text.done' && typeof event.text === 'string') this.put(state, event.content_index, event.text);
    if (event.type === 'response.content_part.done') {
      if (event.part.type === 'output_text') this.put(state, event.content_index, event.part.text);
      if (event.part.type === 'refusal') state.refused = true;
    }
    if (event.type === 'response.refusal.done') state.refused = true;
  }
  finish(response: Response): { text: string; refused: boolean } {
    if (response.status !== 'completed') return { text: '', refused: false };
    const output = Array.isArray(response.output) ? response.output : [];
    if (output.length > MAX_ITEMS) this.limit();
    // A complete final snapshot wins over repeated delta/done event copies.
    const snapshot = new ResponseTextCollector(this.requestId);
    output.forEach((item, outputIndex) => snapshot.message(outputIndex, item, true));
    const final = snapshot.result();
    if (final.refused || final.text.trim()) return final;
    // Empty final output can occur through a streaming transport. Keep known
    // final content, while applying terminal metadata (notably incomplete or
    // commentary) before using any event-assembled fallback.
    output.forEach((item, outputIndex) => this.message(outputIndex, item, false));
    return this.result();
  }
  private result(): { text: string; refused: boolean } {
    const eligible = [...this.messages.entries()].sort(([a], [b]) => a - b).map(([, state]) => state).filter(state => state.allowed && !state.incomplete);
    const refused = eligible.some(state => state.refused);
    const text = refused ? '' : eligible.flatMap(state => [...state.parts.entries()].sort(([a], [b]) => a - b).map(([, text]) => text)).join('');
    return { text, refused };
  }
}
