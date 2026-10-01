import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../apps/server/src/app';
import { readConfig, type ServerConfig } from '../../apps/server/src/config';
import { makeDemoPlan } from '../../apps/server/src/demo';
import type { TeachingProvider } from '../../apps/server/src/provider';
import type { RealtimeProvider } from '../../apps/server/src/realtime';
import type { AppConfig, AskRequest } from '../../packages/shared/protocol';

const HOST = '127.0.0.1:4317';
const ORIGIN = 'http://' + HOST;
const apps: Express[] = [];
type Browser = { config: AppConfig; cookie: string };
function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...readConfig({}), demoMode: false, apiKey: 'mock-key-not-used', chatModel: 'mock-teacher', visionModel: 'mock-vision', ttsModel: 'mock-speech', ...overrides };
}
function provider(): TeachingProvider {
  return { ask: vi.fn(async (body: AskRequest) => ({ plan: makeDemoPlan(body) })), speak: vi.fn(async () => ({ audio: Buffer.from('mock-audio') })), transcribe: vi.fn(async () => ({ text: 'mock' })) };
}
function appFor(options: Parameters<typeof createApp>[0] = {}) { const app = createApp({ config: config(), ...options }); apps.push(app); return app; }
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.locals.dispose())); });
async function browser(app: Express): Promise<Browser> {
  const response = await request(app).get('/api/config').set('Host', HOST).expect(200);
  return { config: response.body, cookie: response.headers['set-cookie'][0].split(';')[0] };
}
function post(app: Express, client: Browser, path: string, payload: object = {}, speech = false) {
  const result = request(app).post(path).set({ Host: HOST, Origin: ORIGIN, Cookie: client.cookie, 'x-csrf-token': client.config.csrfToken });
  if (speech) result.set('x-task-lane', 'speech');
  return result.send({ sessionId: client.config.sessionId, generationId: 1, contextRevision: 1, ...payload });
}
function askBody(): Omit<AskRequest, 'sessionId' | 'generationId' | 'contextRevision'> {
  return { question: '解释截图中的公式', context: { documentId: 'book-a', sources: [{ sourceId: 'formula-a', documentId: 'book-a', pageIndex: 2, pageLabel: '1', blockId: 'formula', rect: [0.1, 0.2, 0.3, 0.4], sourceText: 'M0=0，beta=0.9，g1=g2=g3=10。' }], selectedBoardText: null, imageDataUrl: null }, history: [] };
}
function usage(app: Express, client: Browser) { return request(app).get('/api/usage').set({ Host: HOST, Cookie: client.cookie }); }
function currentConfig(app: Express, client: Browser) { return request(app).get('/api/config').set({ Host: HOST, Cookie: client.cookie }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
function pendingAsk(fake: TeachingProvider) {
  const started = deferred<void>(); const result = deferred<Awaited<ReturnType<TeachingProvider['ask']>>>();
  let signal!: AbortSignal; let body!: AskRequest;
  vi.mocked(fake.ask).mockImplementationOnce((payload, _model, incoming) => { body = payload; signal = incoming; started.resolve(); return result.promise; });
  return { started: started.promise, get signal() { return signal; }, get body() { return body; }, finish: () => result.resolve({ plan: makeDemoPlan(body) }) };
}
function pendingSpeech(fake: TeachingProvider) {
  const started = deferred<void>(); const result = deferred<Awaited<ReturnType<TeachingProvider['speak']>>>(); let signal!: AbortSignal;
  vi.mocked(fake.speak).mockImplementationOnce((_text, _speed, incoming) => { signal = incoming; started.resolve(); return result.promise; });
  return { started: started.promise, get signal() { return signal; }, finish: () => result.resolve({ audio: Buffer.from('mock-delayed-audio') }) };
}

// Real local HTTP requests, injected providers only: no external AI calls or credentials.
describe('independent speech and immutable teaching HTTP lifecycles', () => {
  it('returns speech while a screenshot question is pending and keeps the answer original envelope and source snapshot', async () => {
    const fake = provider(); const waiting = pendingAsk(fake); const app = appFor({ provider: fake }); const client = await browser(app);
    const original = askBody(); original.context.imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFbkAAAAASUVORK5CYII=';
    const pending = post(app, client, '/api/ask', { ...original, generationId: 7, contextRevision: 4 }).then(result => result);
    await waiting.started;
    const spoken = await post(app, client, '/api/tts', { text: '往下选择的另一段原文。', speed: 1, generationId: 22, contextRevision: 19 }, true).expect(200);
    expect(spoken.headers['x-generation-id']).toBe('22'); expect(spoken.headers['x-context-revision']).toBe('19');
    expect(waiting.signal.aborted).toBe(false); expect(waiting.body.context).toEqual(original.context);
    waiting.finish(); const answer = await pending;
    expect(answer.status).toBe(200); expect(answer.body).toMatchObject({ generationId: 7, contextRevision: 4, plan: { contextRevision: 4 } });
    expect(answer.body.plan.steps[0].sourceIds).toEqual(['formula-a']);
    expect((await usage(app, client)).body.requestCount).toBe(2);
  });

  it('speech selection changes cancel only old audio, preserve the pending question, and reject late speech results', async () => {
    const fake = provider(); const question = pendingAsk(fake); const oldSpeech = pendingSpeech(fake); const app = appFor({ provider: fake }); const client = await browser(app);
    const ask = post(app, client, '/api/ask', askBody()).then(result => result); await question.started;
    const first = post(app, client, '/api/tts', { text: '旧选区', speed: 1 }, true).then(result => result); await oldSpeech.started;
    await post(app, client, '/api/tts', { text: '新选区', speed: 1, generationId: 2, contextRevision: 2 }, true).expect(200);
    expect(oldSpeech.signal.aborted).toBe(true); expect(question.signal.aborted).toBe(false); expect((await first).body.error).toBe('cancelled');
    oldSpeech.finish();
    expect((await post(app, client, '/api/cancel', { generationId: 2, contextRevision: 2 }, true).expect(200)).body.cancelled).toBe(0);
    expect((await post(app, client, '/api/tts', { text: '迟到选区', speed: 1, generationId: 2, contextRevision: 2 }, true).expect(409)).body.error).toBe('stale_request');
    await post(app, client, '/api/tts', { text: '再下一段', speed: 1, generationId: 3, contextRevision: 3 }, true).expect(200);
    expect(question.signal.aborted).toBe(false); question.finish(); expect((await ask).status).toBe(200);
    expect(fake.speak).toHaveBeenCalledTimes(3);
  });

  it('cancels an active speech request without stopping the pending teaching request', async () => {
    const fake = provider(); const question = pendingAsk(fake); const speech = pendingSpeech(fake); const app = appFor({ provider: fake }); const client = await browser(app);
    const answer = post(app, client, '/api/ask', askBody()).then(result => result); await question.started;
    const audio = post(app, client, '/api/tts', { text: '正文', speed: 1 }, true).then(result => result); await speech.started;
    expect((await post(app, client, '/api/cancel', {}, true).expect(200)).body.cancelled).toBe(1);
    expect(speech.signal.aborted).toBe(true); expect(question.signal.aborted).toBe(false); expect((await audio).body.error).toBe('cancelled');
    speech.finish(); question.finish(); expect((await answer).status).toBe(200);
    const records = (await usage(app, client)).body.records;
    expect(records.find((item: { category: string }) => item.category === 'text').cancelled).toBe(false);
    expect(records.find((item: { category: string }) => item.category === 'tts').cancelled).toBe(true);
  });

  it('rejects an older speech revision independently of the current teaching snapshot', async () => {
    const fake = provider(); const question = pendingAsk(fake); const app = appFor({ provider: fake }); const client = await browser(app);
    const answer = post(app, client, '/api/ask', askBody()).then(result => result); await question.started;
    await post(app, client, '/api/tts', { text: '正文', speed: 1, generationId: 4, contextRevision: 4 }, true).expect(200);
    expect((await post(app, client, '/api/tts', { text: '旧版本正文', speed: 1, generationId: 5, contextRevision: 3 }, true).expect(409)).body.error).toBe('stale_request');
    expect(question.signal.aborted).toBe(false); expect(fake.speak).toHaveBeenCalledOnce(); question.finish(); expect((await answer).status).toBe(200);
  });

  it('main cancellation never stops independent speech and remembers separate early cancellation boundaries', async () => {
    const fake = provider(); const speech = pendingSpeech(fake); const app = appFor({ provider: fake }); const client = await browser(app);
    const audio = post(app, client, '/api/tts', { text: '继续朗读', speed: 1 }, true).then(result => result); await speech.started;
    await post(app, client, '/api/cancel', { generationId: 50, contextRevision: 50 }).expect(200);
    expect(speech.signal.aborted).toBe(false);
    expect((await post(app, client, '/api/ask', { ...askBody(), generationId: 50, contextRevision: 50 }).expect(409)).body.error).toBe('stale_request');
    speech.finish(); expect((await audio).status).toBe(200);
    await post(app, client, '/api/cancel', { generationId: 7, contextRevision: 7 }, true).expect(200);
    await post(app, client, '/api/cancel', { generationId: 3, contextRevision: 3 }, true).expect(200);
    expect((await post(app, client, '/api/tts', { text: '迟到朗读', speed: 1, generationId: 7, contextRevision: 7 }, true).expect(409)).body.error).toBe('stale_request');
    await post(app, client, '/api/ask', { ...askBody(), generationId: 51, contextRevision: 2 }).expect(200);
    await post(app, client, '/api/tts', { text: '当前朗读', speed: 1, generationId: 8, contextRevision: 2 }, true).expect(200);
  });

  it('a newer question cancels only the earlier question while audio remains pending', async () => {
    const fake = provider(); const firstQuestion = pendingAsk(fake); const speech = pendingSpeech(fake); const app = appFor({ provider: fake }); const client = await browser(app);
    const first = post(app, client, '/api/ask', askBody()).then(result => result); await firstQuestion.started;
    const audio = post(app, client, '/api/tts', { text: '阅读正文', speed: 1 }, true).then(result => result); await speech.started;
    await post(app, client, '/api/ask', { ...askBody(), generationId: 2, contextRevision: 2 }).expect(200);
    expect(firstQuestion.signal.aborted).toBe(true); expect(speech.signal.aborted).toBe(false); expect((await first).body.error).toBe('cancelled');
    firstQuestion.finish(); speech.finish(); expect((await audio).status).toBe(200);
  });

  it('rejects duplicates within each lane before usage or quota while allowing one job in each lane', async () => {
    const fake = provider(); const question = pendingAsk(fake); const speech = pendingSpeech(fake); const app = appFor({ provider: fake }); const client = await browser(app);
    const pending = post(app, client, '/api/ask', askBody()).then(result => result); await question.started;
    const audio = post(app, client, '/api/tts', { text: '正文', speed: 1 }, true).then(result => result); await speech.started;
    expect((await post(app, client, '/api/ask', askBody()).expect(409)).body.error).toBe('request_in_progress');
    expect((await post(app, client, '/api/tts', { text: '正文', speed: 1 }, true).expect(409)).body.error).toBe('request_in_progress');
    expect(question.signal.aborted).toBe(false); expect(speech.signal.aborted).toBe(false);
    expect(fake.ask).toHaveBeenCalledOnce(); expect(fake.speak).toHaveBeenCalledOnce();
    const records = (await usage(app, client)).body; expect(records.requestCount).toBe(2); expect(records.records).toHaveLength(2);
    speech.finish(); question.finish(); expect((await pending).status).toBe(200); expect((await audio).status).toBe(200);
  });

  it('keeps the previous single-generation behavior for legacy TTS without the lane header', async () => {
    const fake = provider(); const question = pendingAsk(fake); const app = appFor({ provider: fake }); const client = await browser(app);
    const pending = post(app, client, '/api/ask', askBody()).then(result => result); await question.started;
    expect((await post(app, client, '/api/tts', { text: '旧客户端朗读', speed: 1 }).expect(409)).body.error).toBe('request_in_progress');
    expect((await usage(app, client)).body.requestCount).toBe(1);
    await post(app, client, '/api/tts', { text: '明确替换旧任务', speed: 1, generationId: 2, contextRevision: 2 }).expect(200);
    expect(question.signal.aborted).toBe(true); expect((await pending).body.error).toBe('cancelled'); question.finish();
  });

  it('restores independent counters through config without exposing private data or changing the session', async () => {
    const fake = provider(); const app = appFor({ provider: fake }); const client = await browser(app);
    expect((await currentConfig(app, client)).body.speechSession).toEqual({ generationId: 0, contextRevision: 0 });
    await post(app, client, '/api/ask', { ...askBody(), generationId: 4, contextRevision: 3 }).expect(200);
    await post(app, client, '/api/tts', { text: '正文', speed: 1, generationId: 12, contextRevision: 9 }, true).expect(200);
    await post(app, client, '/api/cancel', { generationId: 15, contextRevision: 9 }, true).expect(200);
    const restored = await currentConfig(app, client);
    expect(restored.body).toMatchObject({ sessionId: client.config.sessionId, csrfToken: client.config.csrfToken, generationId: 4, contextRevision: 3, speechSession: { generationId: 15, contextRevision: 9 } });
    expect(restored.text).not.toContain('mock-key-not-used');
  });

  it.each(['maxRequests', 'requestsPerMinute'] as const)('enforces aggregate %s across both lanes', async limit => {
    const fake = provider(); const question = pendingAsk(fake); const app = appFor({ config: config({ [limit]: 1 }), provider: fake }); const client = await browser(app);
    const pending = post(app, client, '/api/ask', askBody()).then(result => result); await question.started;
    const audio = await post(app, client, '/api/tts', { text: '正文', speed: 1 }, true).expect(429);
    expect(audio.body.error).toBe(limit === 'maxRequests' ? 'session_limit' : 'local_rate_limit');
    expect(question.signal.aborted).toBe(false); expect(fake.speak).not.toHaveBeenCalled(); expect((await usage(app, client)).body.requestCount).toBe(1);
    question.finish(); expect((await pending).status).toBe(200);
  });

  it.each(['expire', 'dispose'] as const)('cancels both lanes on session %s', async operation => {
    let time = 0; const fake = provider(); const question = pendingAsk(fake); const speech = pendingSpeech(fake); const app = appFor({ provider: fake, now: () => time }); const client = await browser(app);
    const answer = post(app, client, '/api/ask', askBody()).then(result => result); await question.started;
    const audio = post(app, client, '/api/tts', { text: '正文', speed: 1 }, true).then(result => result); await speech.started;
    if (operation === 'expire') { time = 6 * 60 * 60 * 1000 + 1; await usage(app, client).expect(401); }
    else await app.locals.dispose();
    expect(question.signal.aborted).toBe(true); expect(speech.signal.aborted).toBe(true);
    expect((await answer).body.error).toBe('cancelled'); expect((await audio).body.error).toBe('cancelled'); question.finish(); speech.finish();
  });

  it('keeps the existing realtime connection alive when speech is cancelled', async () => {
    const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
    const realtime: RealtimeProvider = { connect: vi.fn(async () => ({ callId: 'rtc_mock', sdp })), hangup: vi.fn(async () => {}) };
    const app = appFor({ config: config({ realtimeModel: 'mock-realtime', realtimeVoice: 'marin', realtimeTranscriptionModel: 'gpt-4o-mini-transcribe' }), realtimeProvider: realtime }); const client = await browser(app);
    const connected = await post(app, client, '/api/realtime/connect', { sdp }).expect(200);
    await post(app, client, '/api/cancel', { generationId: 100, contextRevision: 100 }, true).expect(200);
    const active = await post(app, client, '/api/realtime/heartbeat', { connectionId: connected.body.connectionId }).expect(200);
    expect(active.body.active).toBe(true); expect(realtime.hangup).not.toHaveBeenCalled();
  });
});

describe('speech lane retains local security boundaries', () => {
  it.each(['/api/tts', '/api/cancel'])('requires cookie, Origin, Host, matching session and CSRF for %s', async path => {
    const fake = provider(); const app = appFor({ provider: fake }); const client = await browser(app);
    const body = path === '/api/tts' ? { text: '正文', speed: 1 } : {};
    await post(app, client, path, body, true).unset('Cookie').expect(401);
    await post(app, client, path, body, true).unset('Origin').expect(403);
    await post(app, client, path, body, true).set('Origin', 'https://other.example').expect(403);
    await post(app, client, path, body, true).set('Host', 'other.example').expect(403);
    await post(app, client, path, body, true).unset('x-csrf-token').expect(403);
    await post(app, client, path, body, true).set('x-csrf-token', 'wrong').expect(403);
    await post(app, client, path, { ...body, sessionId: 'wrong' }, true).expect(403);
    expect(fake.speak).not.toHaveBeenCalled(); expect((await usage(app, client)).body.requestCount).toBe(0);
  });

  it.each(['/api/ask', '/api/reading-assist', '/api/transcribe', '/api/realtime/connect', '/api/cache/clear'])('refuses to reassign %s to the speech lane', async path => {
    const fake = provider(); const app = appFor({ provider: fake }); const client = await browser(app);
    expect((await post(app, client, path, askBody(), true).expect(400)).body.error).toBe('invalid_task_lane');
    expect(fake.ask).not.toHaveBeenCalled(); expect(fake.speak).not.toHaveBeenCalled(); expect(fake.transcribe).not.toHaveBeenCalled();
  });

  it('rejects unknown lane names and isolates cancellation between browser sessions', async () => {
    const fake = provider(); const speech = pendingSpeech(fake); const app = appFor({ provider: fake }); const first = await browser(app); const second = await browser(app);
    await post(app, first, '/api/tts', { text: '正文', speed: 1 }).set('x-task-lane', 'background-unlimited').expect(400);
    const audio = post(app, first, '/api/tts', { text: '正文', speed: 1 }, true).then(result => result); await speech.started;
    await post(app, second, '/api/cancel', { generationId: 100 }, true).expect(200);
    expect(speech.signal.aborted).toBe(false); expect((await usage(app, second)).body.requestCount).toBe(0);
    speech.finish(); expect((await audio).status).toBe(200);
  });
});
