import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import OpenAI from 'openai';
import { createApp } from '../../apps/server/src/app';
import { readConfig } from '../../apps/server/src/config';
import { OpenAIRealtimeProvider, REALTIME_INSTRUCTIONS, realtimeSession, type RealtimeExchange, type RealtimeProvider } from '../../apps/server/src/realtime';
import type { AppConfig } from '../../packages/shared/protocol';
import { RealtimeConnectRequestSchema } from '../../packages/shared/realtime';

const HOST = '127.0.0.1:4317';
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const liveConfig = () => readConfig({ DEMO_MODE: 'false', OPENAI_API_KEY: 'secret-mock-key-never-used', REALTIME_MODEL: 'mock-realtime', REALTIME_VOICE: 'marin', REALTIME_TRANSCRIPTION_MODEL: 'gpt-4o-mini-transcribe' });
const mockProvider = (): RealtimeProvider => ({ connect: vi.fn(async () => ({ callId: 'rtc_private-call-id', sdp: SDP, requestId: 'req_realtime_test' })), hangup: vi.fn(async () => {}) });
type Browser = { config: AppConfig; cookie: string };
async function browser(app: Express): Promise<Browser> {
  const response = await request(app).get('/api/config').set('Host', HOST).expect(200);
  return { config: response.body as AppConfig, cookie: response.headers['set-cookie'][0].split(';')[0] };
}
function post(app: Express, client: Browser, endpoint: string, body: object = {}) {
  return request(app).post(endpoint).set({ Host: HOST, Origin: `http://${HOST}`, Cookie: client.cookie, 'x-csrf-token': client.config.csrfToken }).send({ sessionId: client.config.sessionId, generationId: 1, contextRevision: 1, ...body });
}
function connect(app: Express, client: Browser, body: object = {}) { return post(app, client, '/api/realtime/connect', { sdp: SDP, ...body }); }
function usage(app: Express, client: Browser) { return request(app).get('/api/usage').set({ Host: HOST, Cookie: client.cookie }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

// All providers in this file are mocks. No real API keys, microphone, or network API calls.
describe('Realtime connection security and configuration', () => {
  it('does not connect at startup or in demo mode, even if private credentials exist', async () => {
    const provider = mockProvider();
    const app = createApp({ config: { ...liveConfig(), demoMode: true }, realtimeProvider: provider });
    const client = await browser(app);
    expect(client.config.capabilities.realtimeAudio).toBe('unsupported');
    expect(JSON.stringify(client.config)).not.toContain('secret-mock');
    expect(client.config.realtime).toEqual({ provider: 'openai-realtime', voice: 'marin', maxSessionSeconds: 600, idleSeconds: 30, inputTranscriptionModel: 'gpt-4o-mini-transcribe' });
    const response = await connect(app, client).expect(409);
    expect(response.body.error).toBe('demo_realtime');
    expect(provider.connect).not.toHaveBeenCalled();
  });
  it.each(['realtimeModel', 'realtimeTranscriptionModel', 'apiKey'] as const)('requires %s independently', async missing => {
    const provider = mockProvider(); const app = createApp({ config: { ...liveConfig(), [missing]: '' }, realtimeProvider: provider });
    const client = await browser(app);
    expect(client.config.capabilities.realtimeAudio).toBe('unconfigured');
    expect((await connect(app, client).expect(503)).body.error).toBe('not_configured');
    expect(provider.connect).not.toHaveBeenCalled();
  });
  it.each([
    { baseUrl: 'https://compatible.example/v1' },
    { baseUrl: 'https://api.openai.com/v2' },
    { realtimeTranscriptionModel: 'gpt-transcribe' },
    { realtimeVoice: 'unverified-voice' },
  ])('does not infer WebRTC from unrelated configuration %j', async override => {
    const provider = mockProvider(); const app = createApp({ config: { ...liveConfig(), ...override }, realtimeProvider: provider });
    const client = await browser(app);
    expect(client.config.capabilities.realtimeTools).toBe('unsupported');
    expect((await connect(app, client).expect(503)).body.error).toBe('realtime_unsupported');
    expect(provider.connect).not.toHaveBeenCalled();
  });
  it('requires same origin, valid host, cookie, CSRF, session ownership for every endpoint', async () => {
    const provider = mockProvider(); const app = createApp({ config: liveConfig(), realtimeProvider: provider }); const client = await browser(app);
    for (const endpoint of ['connect', 'heartbeat', 'disconnect']) {
      await post(app, client, `/api/realtime/${endpoint}`, {}).set('Origin', 'https://evil.example').expect(403);
      await post(app, client, `/api/realtime/${endpoint}`, {}).set('Host', 'evil.example').expect(403);
      await post(app, client, `/api/realtime/${endpoint}`, {}).set('x-csrf-token', 'incorrect').expect(403);
      await post(app, client, `/api/realtime/${endpoint}`, { sessionId: 'different-session' }).expect(403);
      await post(app, client, `/api/realtime/${endpoint}`, {}).unset('Cookie').expect(401);
    }
    expect(provider.connect).not.toHaveBeenCalled();
  });
  it('strictly bounds SDP bytes and refuses browser-supplied models, URLs or tools', async () => {
    const provider = mockProvider(); const app = createApp({ config: liveConfig(), realtimeProvider: provider }); const client = await browser(app);
    for (const extra of [{ model: 'free-model' }, { session: { tools: [{ type: 'mcp', server_url: 'https://evil.example' }] } }, { url: 'https://evil.example' }, { sdp: 'not-sdp' }, { sdp: 'v=0' + '中'.repeat(23000) }, { sdp: 'v=0' + 'a'.repeat(65536) }]) await connect(app, client, extra).expect(400);
    await connect(app, client, { sdp: 'v=0' + 'a'.repeat(85000) }).expect(413);
    expect(provider.connect).not.toHaveBeenCalled();
    expect(RealtimeConnectRequestSchema.safeParse({ sessionId: 's', generationId: 1, contextRevision: 1, sdp: 'v=0\r\n' }).success).toBe(true);
  });
  it('protects connection IDs from other local sessions and does not expose provider identifiers or keys', async () => {
    const provider = mockProvider(); const app = createApp({ config: liveConfig(), realtimeProvider: provider });
    const a = await browser(app); const b = await browser(app);
    const response = await connect(app, a).expect(200); const { connectionId } = response.body;
    expect(connectionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.text).not.toMatch(/private-call-id|secret-mock|api\.openai|req_realtime/);
    expect((await post(app, b, '/api/realtime/heartbeat', { connectionId }).expect(200)).body.active).toBe(false);
    expect((await post(app, b, '/api/realtime/disconnect', { connectionId }).expect(200)).body.upstreamCancellation).toBe('not_found');
    expect(provider.hangup).not.toHaveBeenCalled();
    await post(app, a, '/api/realtime/disconnect', { connectionId }).expect(200);
  });
  it('leaves all real audio/tool/interruption capabilities untested after a successful SDP exchange', async () => {
    const provider = mockProvider(); const app = createApp({ config: liveConfig(), realtimeProvider: provider }); const client = await browser(app);
    const response = await connect(app, client).expect(200);
    const current = await request(app).get('/api/config').set({ Host: HOST, Cookie: client.cookie }).expect(200);
    for (const capability of ['realtimeAudio', 'realtimeTools', 'interruption']) expect(current.body.capabilities[capability]).toBe('untested');
    const records = (await usage(app, client)).body.records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ category: 'realtime', estimatedCost: null, inputTokens: null, outputTokens: null, audioSeconds: null });
    await post(app, client, '/api/realtime/disconnect', { connectionId: response.body.connectionId });
  });
  it('enforces one connection and shared per-minute and session request limits without charging duplicates', async () => {
    const provider = mockProvider(); const app = createApp({ config: { ...liveConfig(), requestsPerMinute: 1 }, realtimeProvider: provider }); const client = await browser(app);
    const first = await connect(app, client).expect(200);
    expect((await connect(app, client, { generationId: 2 }).expect(409)).body.error).toBe('realtime_in_progress');
    expect((await usage(app, client)).body.requestCount).toBe(1);
    await post(app, client, '/api/realtime/disconnect', { connectionId: first.body.connectionId });
    expect((await connect(app, client, { generationId: 2 }).expect(429)).body.error).toBe('local_rate_limit');
    expect(provider.connect).toHaveBeenCalledTimes(1);
    const limited = createApp({ config: { ...liveConfig(), maxRequests: 1 }, realtimeProvider: provider }); const user = await browser(limited);
    const call = await connect(limited, user).expect(200);
    await post(limited, user, '/api/realtime/disconnect', { connectionId: call.body.connectionId });
    expect((await connect(limited, user, { generationId: 2 }).expect(429)).body.error).toBe('session_limit');
  });
  it('maps upstream errors without disclosing provider bodies, credentials or SDP', async () => {
    const provider = mockProvider(); vi.mocked(provider.connect).mockRejectedValue({ status: 401, request_id: 'req_safe', message: 'secret-mock-key-never-used PRIVATE_SDP', body: 'private' });
    const app = createApp({ config: liveConfig(), realtimeProvider: provider }); const client = await browser(app);
    const response = await connect(app, client).expect(502);
    expect(response.body).toMatchObject({ error: 'provider_authentication', requestId: 'req_safe' });
    expect(response.text).not.toMatch(/secret-mock|PRIVATE_SDP|private/);
    expect(provider.connect).toHaveBeenCalledTimes(1);
  });
});

describe('Realtime leases and asynchronous cancellation', () => {
  it('lets old generations renew and close the owned connection after cancelling an answer', async () => {
    const provider = mockProvider(); const app = createApp({ config: liveConfig(), realtimeProvider: provider }); const client = await browser(app);
    const call = await connect(app, client).expect(200); const { connectionId } = call.body;
    await post(app, client, '/api/cancel', { generationId: 9, contextRevision: 9 }).expect(200);
    expect((await post(app, client, '/api/realtime/heartbeat', { connectionId }).expect(200)).body.active).toBe(true);
    expect((await post(app, client, '/api/realtime/disconnect', { connectionId }).expect(200)).body.upstreamCancellation).toBe('confirmed');
    expect((await post(app, client, '/api/realtime/disconnect', { connectionId }).expect(200)).body.upstreamCancellation).toBe('not_found');
    expect(provider.hangup).toHaveBeenCalledTimes(1);
  });
  it('expires a silent browser after 30 seconds with a bounded hangup', async () => {
    let time = 100000; const provider = mockProvider(); const app = createApp({ config: liveConfig(), realtimeProvider: provider, now: () => time }); const client = await browser(app);
    const call = await connect(app, client).expect(200); time += 30001;
    expect((await post(app, client, '/api/realtime/heartbeat', { connectionId: call.body.connectionId }).expect(200)).body.active).toBe(false);
    expect(provider.hangup).toHaveBeenCalledTimes(1);
    const records = (await usage(app, client)).body.records;
    expect(records[0]).toMatchObject({ connectionSeconds: 30.001, audioSeconds: null, upstreamCancellation: 'confirmed' });
  });
  it('enforces the absolute 10-minute lifetime even with regular heartbeats', async () => {
    let time = 0; const provider = mockProvider(); const app = createApp({ config: liveConfig(), realtimeProvider: provider, now: () => time }); const client = await browser(app);
    const call = await connect(app, client).expect(200);
    expect(call.body.expiresAt).toBe(600000);
    for (let i = 1; i <= 30; i++) {
      time = i * 20000;
      const heartbeat = await post(app, client, '/api/realtime/heartbeat', { connectionId: call.body.connectionId }).expect(200);
      expect(heartbeat.body.active).toBe(i < 30);
    }
    expect(provider.hangup).toHaveBeenCalledTimes(1);
  });
  it('uses an actual timer to close abandoned connections without a further HTTP request', async () => {
    const provider = mockProvider(); const app = createApp({ config: liveConfig(), realtimeProvider: provider, now: () => Date.now() }); const client = await browser(app);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const callPromise = connect(app, client).then(result => result);
      // Supertest sockets use real event-loop scheduling, only timeout/date are virtual.
      const call = await callPromise;
      expect(call.status).toBe(200);
      await vi.advanceTimersByTimeAsync(30001);
      expect(provider.hangup).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('rejects duplicate pending exchanges and hangs up a late successful exchange after cancellation', async () => {
    const late = deferred<RealtimeExchange>(); const started = deferred<AbortSignal>(); const provider = mockProvider();
    vi.mocked(provider.connect).mockImplementation((_sdp, signal) => { started.resolve(signal); return late.promise; });
    const app = createApp({ config: liveConfig(), realtimeProvider: provider }); const client = await browser(app);
    const pending = connect(app, client).then(response => response);
    const signal = await started.promise;
    await connect(app, client, { generationId: 2 }).expect(409);
    expect(signal.aborted).toBe(false);
    await post(app, client, '/api/cancel', {}).expect(200);
    expect(signal.aborted).toBe(true);
    expect((await pending).status).toBe(409);
    late.resolve({ callId: 'rtc_late', sdp: SDP });
    await vi.waitFor(() => expect(provider.hangup).toHaveBeenCalledWith('rtc_late', expect.any(AbortSignal)));
    expect(provider.hangup).toHaveBeenCalledTimes(1);
  });
  it('times out a stalled exchange, aborts upstream, and cleans up a later call without reconnecting', async () => {
    const late = deferred<RealtimeExchange>(); const started = deferred<AbortSignal>(); const provider = mockProvider();
    vi.mocked(provider.connect).mockImplementation((_sdp, signal) => { started.resolve(signal); return late.promise; });
    const app = createApp({ config: { ...liveConfig(), requestTimeoutMs: 20 }, realtimeProvider: provider }); const client = await browser(app);
    const pending = connect(app, client).then(response => response);
    const signal = await started.promise;
    const response = await pending;
    expect(response.status).toBe(504); expect(response.body.error).toBe('provider_timeout'); expect(signal.aborted).toBe(true);
    late.resolve({ callId: 'rtc_timeout_late', sdp: SDP });
    await vi.waitFor(() => expect(provider.hangup).toHaveBeenCalledWith('rtc_timeout_late', expect.any(AbortSignal)));
    expect(provider.connect).toHaveBeenCalledTimes(1);
  });
  it('refuses an exchange already cancelled before its HTTP request arrives', async () => {
    const provider = mockProvider(); const app = createApp({ config: liveConfig(), realtimeProvider: provider }); const client = await browser(app);
    await post(app, client, '/api/cancel', {}).expect(200);
    expect((await connect(app, client).expect(409)).body.error).toBe('stale_request');
    expect(provider.connect).not.toHaveBeenCalled();
  });
  it('reports unconfirmed cleanup honestly and never automatically reconnects or retries a failed hangup', async () => {
    const provider = mockProvider(); vi.mocked(provider.hangup).mockRejectedValue(new Error('private upstream error'));
    const app = createApp({ config: liveConfig(), realtimeProvider: provider }); const client = await browser(app);
    const call = await connect(app, client).expect(200);
    const response = await post(app, client, '/api/realtime/disconnect', { connectionId: call.body.connectionId }).expect(200);
    expect(response.body.upstreamCancellation).toBe('unconfirmed');
    expect(response.text).not.toContain('private');
    expect(provider.hangup).toHaveBeenCalledTimes(1); expect(provider.connect).toHaveBeenCalledTimes(1);
  });
});

describe('official Realtime SDK adapter with intercepted fetch', () => {
  it('sends multipart SDP plus trusted session options and closes only the parsed official call ID', async () => {
    const captured: Request[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'data:,') return new Response(''); // SDK FormData support probe, no API request.
      const incoming = new Request(input, init); captured.push(incoming);
      return incoming.url.endsWith('/hangup') ? new Response(null, { status: 200 }) : new Response(SDP, { headers: { 'Content-Type': 'application/sdp', Location: '/v1/realtime/calls/rtc_sdk', 'x-request-id': 'req_sdk' } });
    });
    const provider = new OpenAIRealtimeProvider(liveConfig(), new OpenAI({ apiKey: 'fake-sdk-test-key', maxRetries: 0, fetch: fakeFetch }));
    const result = await provider.connect(SDP, new AbortController().signal);
    expect(result).toEqual({ callId: 'rtc_sdk', sdp: SDP, requestId: 'req_sdk' });
    expect(captured[0].url).toBe('https://api.openai.com/v1/realtime/calls');
    expect(captured[0].headers.get('content-type')).toContain('multipart/form-data');
    const body = await captured[0].text();
    expect(body).toContain('name="sdp"'); expect(body).toContain('name="session"');
    expect(body).toContain('"create_response":false'); expect(body).toContain('"interrupt_response":true');
    expect(body).toContain('"transcription":{"model":"gpt-4o-mini-transcribe","language":"zh"}');
    expect(body).toContain('"tools":[]'); expect(body).toContain('"tracing":null');
    expect(REALTIME_INSTRUCTIONS).toContain('不可信数据');
    expect(realtimeSession(liveConfig()).audio?.input?.turn_detection).toMatchObject({ type: 'server_vad', create_response: false, interrupt_response: true });
    await provider.hangup(result.callId, new AbortController().signal);
    expect(captured[1].url).toBe('https://api.openai.com/v1/realtime/calls/rtc_sdk/hangup');
  });
  it('does not follow malicious Location headers or accept unbounded/malformed SDP responses', async () => {
    const badLocation = new OpenAIRealtimeProvider(liveConfig(), new OpenAI({ apiKey: 'fake-sdk', maxRetries: 0, fetch: async () => new Response(SDP, { headers: { Location: 'https://evil.example/v1/realtime/calls/rtc_leak' } }) }));
    await expect(badLocation.connect(SDP, new AbortController().signal)).rejects.toMatchObject({ code: 'realtime_metadata' });
    for (const answer of ['not SDP', 'v=0' + 'a'.repeat(70000)]) {
      const fetch = vi.fn(async (input: RequestInfo | URL) => String(input) === 'data:,' ? new Response('') : String(input).endsWith('/hangup') ? new Response(null) : new Response(answer, { headers: { Location: '/v1/realtime/calls/rtc_bad' } }));
      const provider = new OpenAIRealtimeProvider(liveConfig(), new OpenAI({ apiKey: 'fake-sdk', maxRetries: 0, fetch }));
      await expect(provider.connect(SDP, new AbortController().signal)).rejects.toMatchObject({ code: 'realtime_answer' });
      expect(fetch.mock.calls.filter(call => String(call[0]) !== 'data:,')).toHaveLength(2);
    }
  });
});
