import { ReadingAssistResponseSchema, type ReadingAssistRequest, type ReadingAssistResponse } from '../../../../packages/shared/readingAssist';
import type { AppConfig, AskRequest, AskResponse, Envelope, TranscriptionRequest, TranscriptionResponse } from '../../../../packages/shared/protocol';
import { sameEnvelope, TranscriptionResponseSchema, validatePlan } from '../../../../packages/shared/protocol';

// Share only concurrent initialization, including development StrictMode's repeated effect.
// Clear after completion so explicit reconnection still reads fresh session state.
let pendingConfig: Promise<AppConfig> | undefined;
export function getConfig(): Promise<AppConfig> {
  pendingConfig ??= (async () => {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('无法连接本地服务，请确认软件已启动，或重新打开软件。');
    return response.json() as Promise<AppConfig>;
  })().finally(() => { pendingConfig = undefined; });
  return pendingConfig;
}
async function checked(response: Response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = body.message || (typeof body.error === 'string' ? body.error : body.error?.message) || '请求失败，请重试。';
    throw new Error(message);
  }
  return response;
}
export function apiClient(config: AppConfig, lane: 'main' | 'speech' = 'main') {
  const post = (path: string, body: unknown, signal?: AbortSignal) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': config.csrfToken, ...(lane === 'speech' && (path === '/api/tts' || path === '/api/cancel') ? { 'x-task-lane': 'speech' } : {}) }, body: JSON.stringify(body), signal }).then(checked);
  return {
    async ask(request: AskRequest, signal: AbortSignal): Promise<AskResponse> {
      const result: AskResponse & { warning?: string } = await (await post('/api/ask', request, signal)).json();
      if (!sameEnvelope(request, result)) throw new Error('已丢弃过期回答');
      if (result.warning === 'invalid_model_output') throw new Error('模型返回的教案未通过结构或来源校验，未执行板书。可以重试这次提问，或缩小选区后重新提问。');
      result.plan = validatePlan(result.plan, request.context, request.contextRevision);
      return result;
    },
    async readingAssist(request: ReadingAssistRequest, signal: AbortSignal): Promise<ReadingAssistResponse> {
      const result = ReadingAssistResponseSchema.parse(await (await post('/api/reading-assist', request, signal)).json());
      if (!sameEnvelope(request, result)) throw new Error('已丢弃过期的朗读稿');
      return result;
    },
    async speech(text: string, envelope: Envelope, speed: number, signal: AbortSignal) {
      const response = await post('/api/tts', { ...envelope, text, speed }, signal);
      if (response.headers.get('x-session-id') !== envelope.sessionId || Number(response.headers.get('x-generation-id')) !== envelope.generationId || Number(response.headers.get('x-context-revision')) !== envelope.contextRevision) throw new Error('已丢弃过期音频');
      return response.blob();
    },
    async transcribe(request: TranscriptionRequest, signal: AbortSignal): Promise<TranscriptionResponse> {
      const response = await post('/api/transcribe', request, signal);
      const result: TranscriptionResponse = await response.json();
      TranscriptionResponseSchema.parse(result);
      if (!sameEnvelope(request, result)) throw new Error('已丢弃过期转写');
      return result;
    },
    cancel(envelope: Envelope) { return post('/api/cancel', envelope).catch(() => undefined); },
    clearCache() { return post('/api/cache/clear', { sessionId: config.sessionId }); }
  };
}
