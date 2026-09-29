import type { AppConfig, AskRequest, AskResponse, Envelope, TranscriptionRequest, TranscriptionResponse } from '../../../../packages/shared/protocol';
import { sameEnvelope, TranscriptionResponseSchema, validatePlan } from '../../../../packages/shared/protocol';

export async function getConfig(): Promise<AppConfig> {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('无法连接本地服务，请确认启动终端仍在运行。');
  return response.json();
}
async function checked(response: Response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = body.message || (typeof body.error === 'string' ? body.error : body.error?.message) || '请求失败，请重试。';
    throw new Error(message);
  }
  return response;
}
export function apiClient(config: AppConfig) {
  const post = (path: string, body: unknown, signal?: AbortSignal) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': config.csrfToken }, body: JSON.stringify(body), signal }).then(checked);
  return {
    async ask(request: AskRequest, signal: AbortSignal): Promise<AskResponse> {
      const result: AskResponse = await (await post('/api/ask', request, signal)).json();
      if (!sameEnvelope(request, result)) throw new Error('已丢弃过期回答');
      result.plan = validatePlan(result.plan, request.context, request.contextRevision);
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
