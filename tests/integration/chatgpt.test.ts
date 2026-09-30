import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/server/src/app';
import { readConfig } from '../../apps/server/src/config';
import { makeDemoPlan } from '../../apps/server/src/demo';
import { ChatGptTeachingProvider, type TeachingProvider } from '../../apps/server/src/provider';
import type { AppConfig, AskRequest } from '../../packages/shared/protocol';

const HOST = '127.0.0.1:4317';
const config = () => ({ ...readConfig({}), demoMode: false, authMode: 'chatgpt' as const, chatModel: 'account-selected-theory', visionModel: 'account-selected-vision', chatReasoningEffort: 'high' as const });
const body: AskRequest = { sessionId: 'test-session', generationId: 1, contextRevision: 1, question: '推导为什么要作修正', context: { documentId: 'book', sources: [{ sourceId: 'source', documentId: 'book', pageIndex: 0, pageLabel: null, blockId: 'block', rect: null, sourceText: 'M0=0，beta=0.9。' }], selectedBoardText: null, imageDataUrl: null }, history: [] };
function completed(plan: unknown = makeDemoPlan(body)) {
  return { type: 'response.completed', sequence_number: 1, response: { id: 'resp_mock', object: 'response', status: 'completed', created_at: 0, model: 'account-selected-theory', output: [{ type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: typeof plan === 'string' ? plan : JSON.stringify(plan), annotations: [] }] }], usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 } } };
}
function sse(events: unknown[]) { return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_mock_chatgpt' } }); }
async function client(app: ReturnType<typeof createApp>) {
  const response = await request(app).get('/api/config').set('Host', HOST).expect(200);
  return { config: response.body as AppConfig, cookie: response.headers['set-cookie'][0].split(';')[0] };
}
function post(app: ReturnType<typeof createApp>, browser: Awaited<ReturnType<typeof client>>, endpoint: string, payload: object) { return request(app).post(endpoint).set({ Host: HOST, Origin: `http://${HOST}`, Cookie: browser.cookie, 'x-csrf-token': browser.config.csrfToken }).send({ ...body, sessionId: browser.config.sessionId, ...payload }); }

describe('ChatGPT plan Responses adapter (all provider requests mocked)', () => {
  it('uses an independently refreshed token at the official public route, omits incompatible fields and waits for completion', async () => {
    const getAccessToken = vi.fn(async () => 'mock-oauth-only');
    let sent!: Record<string, unknown>; let url = ''; let headers!: Headers;
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => { url = String(input); headers = new Headers(init?.headers); sent = JSON.parse(init!.body as string); return sse([{ type: 'response.output_text.delta', delta: '{not-the-final-json', sequence_number: 0 }, completed()]); });
    const provider = new ChatGptTeachingProvider({ ...config(), baseUrl: 'https://never-send-oauth.example/v1' }, { getAccessToken }, fetcher as typeof fetch);
    const result = await provider.ask(body, 'account-selected-theory', new AbortController().signal);
    expect(url).toBe('https://api.openai.com/v1/responses'); expect(headers.get('authorization')).toBe('Bearer mock-oauth-only');
    expect(sent).toMatchObject({ model: 'account-selected-theory', store: false, stream: true, reasoning: { effort: 'high' } });
    expect(sent).not.toHaveProperty('max_output_tokens'); expect(sent).not.toHaveProperty('previous_response_id'); expect(sent).not.toHaveProperty('temperature');
    expect(Array.isArray(sent.input)).toBe(true); expect(sent.instructions).toContain('没有工具权限'); expect(JSON.stringify(sent.text)).toContain('teaching_plan');
    expect(result).toMatchObject({ plan: makeDemoPlan(body), requestId: 'req_mock_chatgpt', inputTokens: 12, outputTokens: 34 });
    expect(fetcher).toHaveBeenCalledOnce(); expect(getAccessToken).toHaveBeenCalledOnce();
  });
  it('preserves explicit image input and vision effort without assuming universal model access', async () => {
    let sent!: Record<string, unknown>;
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => { sent = JSON.parse(init!.body as string); return sse([completed()]); });
    await new ChatGptTeachingProvider({ ...config(), visionReasoningEffort: null }, { getAccessToken: async () => 'mock-only' }, fetcher as typeof fetch).ask({ ...body, context: { ...body.context, imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' } }, 'account-selected-vision', new AbortController().signal);
    expect(sent.model).toBe('account-selected-vision'); expect(sent).not.toHaveProperty('reasoning'); expect(JSON.stringify(sent.input)).toContain('input_image');
  });
  it.each(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_user_not_eligible', 'subscription_sharing_unsupported_capability'])('rejects %s arriving after partial output without billing fallback', async code => {
    const fetcher = vi.fn(async () => sse([{ type: 'response.output_text.delta', delta: 'private-incomplete-text' }, { type: 'response.failed', response: { status: 'failed', error: { code, message: 'raw-sensitive-message' } } }]));
    const provider = new ChatGptTeachingProvider({ ...config(), apiKey: 'independent-api-key' }, { getAccessToken: async () => 'mock-oauth' }, fetcher as typeof fetch);
    await expect(provider.ask(body, config().chatModel, new AbortController().signal)).rejects.toMatchObject({ code, requestId: 'req_mock_chatgpt' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects interrupted streams and invalid completed JSON, and reports incomplete separately', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(sse([{ type: 'response.output_text.delta', delta: 'partial' }])).mockResolvedValueOnce(sse([completed('{broken')])).mockResolvedValueOnce(sse([{ type: 'response.incomplete', response: { status: 'incomplete', usage: { input_tokens: 10, output_tokens: 20 }, incomplete_details: { reason: 'max_output_tokens' } } }]));
    const provider = new ChatGptTeachingProvider(config(), { getAccessToken: async () => 'mock-oauth' }, fetcher as typeof fetch);
    await expect(provider.ask(body, 'model', new AbortController().signal)).rejects.toMatchObject({ code: 'chatgpt_interrupted_stream' });
    await expect(provider.ask(body, 'model', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_model_output' });
    expect(await provider.ask(body, 'model', new AbortController().signal)).toMatchObject({ plan: null, incompleteReason: 'other', inputTokens: 10, outputTokens: 20 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('sanitizes pre-stream nonstandard admission failures while preserving status class', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ detail: 'sensitive-policy-description' }), { status: 403, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_policy' } }));
    const provider = new ChatGptTeachingProvider(config(), { getAccessToken: async () => 'mock-oauth' }, fetcher as typeof fetch);
    await expect(provider.ask(body, 'model', new AbortController().signal)).rejects.toMatchObject({ status: 403, code: 'chatgpt_permission', requestId: 'req_policy' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('never sends OAuth to audio and uses only a separately configured API key for TTS', async () => {
    const auth = { getAccessToken: vi.fn(async () => 'oauth-forbidden-for-audio') };
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer independent-api-key');
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } });
    });
    const absent = new ChatGptTeachingProvider(config(), auth, fetcher as typeof fetch);
    await expect(absent.speak('原文', 0.5, new AbortController().signal)).rejects.toMatchObject({ code: 'tts_key_required' });
    await expect(absent.transcribe(Buffer.from('mock'), 'audio/webm', new AbortController().signal)).rejects.toMatchObject({ code: 'transcription_key_required' });
    expect(fetcher).not.toHaveBeenCalled(); expect(auth.getAccessToken).not.toHaveBeenCalled();
    const separate = new ChatGptTeachingProvider({ ...config(), apiKey: 'independent-api-key', ttsModel: 'gpt-4o-mini-tts' }, auth, fetcher as typeof fetch);
    expect((await separate.speak('原文', 0.5, new AbortController().signal)).audio.length).toBe(3);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.openai.com/v1/audio/speech'); expect(auth.getAccessToken).not.toHaveBeenCalled();
  });
  it('honors cancellation before touching the Responses endpoint', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(); const auth = { getAccessToken: async () => { controller.abort(new Error('cancelled')); return 'mock-only'; } };
    await expect(new ChatGptTeachingProvider(config(), auth, fetcher as typeof fetch).ask(body, 'model', controller.signal)).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('ChatGPT local API and desktop disposal (mocked inference)', () => {
  it('enables teaching without an API key and leaves every audio capability unconfigured', async () => {
    const provider: TeachingProvider = { ask: vi.fn(async () => ({ plan: makeDemoPlan(body) })), speak: vi.fn(), transcribe: vi.fn() };
    const auth = { getAccessToken: vi.fn(async () => 'private-token') };
    const app = createApp({ config: config(), provider, chatGptAuth: auth }); const browser = await client(app);
    expect(browser.config).toMatchObject({ mode: 'live', authMode: 'chatgpt', capabilities: { text: 'untested', vision: 'untested', tts: 'unconfigured', transcription: 'unconfigured', realtimeAudio: 'unconfigured' } });
    expect(JSON.stringify(browser.config)).not.toContain('private-token');
    await post(app, browser, '/api/ask', {}).expect(200);
    const audio = await post(app, browser, '/api/tts', { text: '原文', speed: 1, generationId: 2 }).expect(503);
    expect(audio.body.message).toContain('独立语音 API Key'); expect(provider.speak).not.toHaveBeenCalled();
    await app.locals.dispose();
  });
  it('fails closed if desktop auth was not injected, even if a separate audio key exists', async () => {
    const provider: TeachingProvider = { ask: vi.fn(), speak: vi.fn(), transcribe: vi.fn() };
    const app = createApp({ config: { ...config(), apiKey: 'tts-key-only', ttsModel: 'gpt-4o-mini-tts' }, provider }); const browser = await client(app);
    const response = await post(app, browser, '/api/ask', {}).expect(503);
    expect(response.body.error).toBe('chatgpt_not_configured'); expect(provider.ask).not.toHaveBeenCalled();
    expect(response.text).not.toContain('tts-key-only'); await app.locals.dispose();
  });
  it('aborts pending inference, clears session state, and disposes idempotently', async () => {
    let active!: AbortSignal; let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const provider: TeachingProvider = { ask: vi.fn(async (_request, _model, signal) => { active = signal; started(); return new Promise<never>(() => undefined); }), speak: vi.fn(), transcribe: vi.fn() };
    const app = createApp({ config: config(), provider, chatGptAuth: { getAccessToken: async () => 'mock-only' } }); const browser = await client(app);
    const pending = post(app, browser, '/api/ask', {}).then(response => response); await start;
    await app.locals.dispose(); await app.locals.dispose(); expect(active.aborted).toBe(true); expect((await pending).status).toBe(409);
    await request(app).get('/api/usage').set({ Host: HOST, Cookie: browser.cookie }).expect(401);
  });
});
