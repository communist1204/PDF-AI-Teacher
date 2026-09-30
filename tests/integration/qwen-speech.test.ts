import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../apps/server/src/app';
import { readConfig, type ServerConfig } from '../../apps/server/src/config';
import { HttpError } from '../../apps/server/src/errors';
import type { TeachingProvider } from '../../apps/server/src/provider';
import type { AppConfig } from '../../packages/shared/protocol';
const HOST = '127.0.0.1:4317';
const ORIGIN = `http://${HOST}`;
type Browser = { config: AppConfig; cookie: string };
async function browser(app: Express): Promise<Browser> {
  const response = await request(app).get('/api/config').set('Host', HOST).expect(200);
  return { config: response.body as AppConfig, cookie: response.headers['set-cookie'][0].split(';')[0] };
}
function post(app: Express, client: Browser, endpoint: string, body: object) {
  return request(app).post(endpoint).set({ Host: HOST, Origin: ORIGIN, Cookie: client.cookie, 'x-csrf-token': client.config.csrfToken }).send({ sessionId: client.config.sessionId, generationId: 1, contextRevision: 1, ...body });
}
function usage(app: Express, client: Browser) { return request(app).get('/api/usage').set({ Host: HOST, Cookie: client.cookie }); }
function audio() { return Buffer.from('RIFF mock wave bytes for HTTP routing test'); }
const apps: Express[] = [];
function harness(patch: Partial<ServerConfig> = {}) {
  const config = { ...readConfig({ TTS_ENGINE: 'qwen', QWEN_TTS_INSTRUCTIONS: 'private-voice-direction' }), ...patch };
  const speak = vi.fn(async (_text: string, _speed: number, _signal: AbortSignal) => ({ audio: audio() }));
  const qwen = { ready: vi.fn(() => true), speak, dispose: vi.fn() };
  const kokoro = { ready: vi.fn(() => true), speak: vi.fn(async () => ({ audio: audio() })), dispose: vi.fn() };
  const cloud: TeachingProvider = { ask: vi.fn(async () => { throw Error('unexpected cloud ask'); }), speak: vi.fn(async () => { throw Error('unexpected paid voice'); }), transcribe: vi.fn(async () => { throw Error('unexpected transcription'); }) };
  const fetchMock = vi.fn(async () => { throw Error('unexpected external network'); });
  const app = createApp({ config, qwenTts: qwen, localTts: kokoro, provider: cloud, fetch: fetchMock }); apps.push(app);
  return { app, config, qwen, kokoro, cloud, fetchMock };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.locals.dispose(); });

describe('Qwen local HTTP route (mock engine; no paid API)', () => {
  it('runs real local route in explicit demo without credentials or either alternate provider', async () => {
    const h = harness(); const client = await browser(h.app);
    expect(client.config.mode).toBe('demo'); expect(client.config.speech).toMatchObject({ engine: 'qwen', ready: true, voice: 'serena', instructionsSupported: true });
    expect(client.config.models.tts).toBe('Qwen3-TTS-1.7B-CustomVoice-Q4_K_M'); expect(JSON.stringify(client.config)).not.toContain('private-voice-direction');
    const response = await post(h.app, client, '/api/tts', { text: '二零二六年，保持原文。', speed: 0.25 }).expect(200);
    expect(response.headers['content-type']).toContain('audio/wav'); expect(response.headers['x-audio-cache']).toBe('miss'); expect(response.headers['x-generation-id']).toBe('1');
    expect(h.qwen.speak).toHaveBeenCalledWith('二零二六年，保持原文。', 0.25, expect.any(AbortSignal));
    const records = (await usage(h.app, client).expect(200)).body.records; expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ model: 'Qwen3-TTS-1.7B-CustomVoice-Q4_K_M', local: true, cancelled: false, characters: 11 });
    expect(h.cloud.speak).not.toHaveBeenCalled(); expect(h.kokoro.speak).not.toHaveBeenCalled(); expect(h.fetchMock).not.toHaveBeenCalled();
    expect((await browser(h.app)).config.capabilities.tts).toBe('supported');
  });
  it('caches natural-speed audio across playback rates but isolates separate browser sessions', async () => {
    const h = harness(); const first = await browser(h.app); const second = await browser(h.app);
    await post(h.app, first, '/api/tts', { text: '同一句。', speed: 1 }).expect(200).expect('x-audio-cache', 'miss');
    await post(h.app, first, '/api/tts', { text: '同一句。', speed: 0.25 }).expect(200).expect('x-audio-cache', 'hit');
    await post(h.app, first, '/api/tts', { text: '同一句。', speed: 3 }).expect(200).expect('x-audio-cache', 'hit');
    await post(h.app, second, '/api/tts', { text: '同一句。', speed: 1 }).expect(200).expect('x-audio-cache', 'miss');
    expect(h.qwen.speak).toHaveBeenCalledTimes(2); expect((await usage(h.app, first).expect(200)).body.records).toHaveLength(1);
    await post(h.app, first, '/api/cache/clear', {}).expect(200); await post(h.app, first, '/api/tts', { text: '同一句。', speed: 1 }).expect(200).expect('x-audio-cache', 'miss');
    expect(h.qwen.speak).toHaveBeenCalledTimes(3);
  });
  it('does not consume paid request quotas for free CPU generation', async () => {
    const h = harness({ maxRequests: 1, requestsPerMinute: 1 }); const client = await browser(h.app);
    for (const text of ['第一句。', '第二句。', '第三句。']) await post(h.app, client, '/api/tts', { text, speed: 1 }).expect(200);
    const result = (await usage(h.app, client).expect(200)).body; expect(result.requestCount).toBe(0); expect(result.records).toHaveLength(3); expect(result.records.every((record: { local: boolean }) => record.local)).toBe(true);
  });
  it('does not silently fall back to cloud or Kokoro when Qwen resources are missing', async () => {
    const h = harness(); const app = createApp({ config: h.config, qwenTts: { ...h.qwen, ready: () => false }, localTts: h.kokoro, provider: h.cloud, fetch: h.fetchMock }); apps.push(app);
    const client = await browser(app); expect(client.config.speech).toMatchObject({ engine: 'qwen', ready: false });
    expect((await post(app, client, '/api/tts', { text: '未安装时的原文。', speed: 1 }).expect(503)).body.error).toBe('local_tts_missing');
    expect(h.qwen.speak).not.toHaveBeenCalled(); expect(h.kokoro.speak).not.toHaveBeenCalled(); expect(h.cloud.speak).not.toHaveBeenCalled(); expect(h.fetchMock).not.toHaveBeenCalled();
  });
  it('cancels the active engine, discards late bytes and does not cache cancelled output', async () => {
    const h = harness(); const client = await browser(h.app);
    let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
    let finish!: (result: { audio: ReturnType<typeof audio> }) => void; let signal!: AbortSignal;
    h.qwen.speak.mockImplementationOnce((_text, _speed, activeSignal) => { signal = activeSignal; started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = post(h.app, client, '/api/tts', { text: '迟到的音频。', speed: 1 }).then(response => response);
    await start; await post(h.app, client, '/api/cancel', {}).expect(200); expect(signal.aborted).toBe(true);
    expect((await pending).body.error).toBe('cancelled'); finish({ audio: audio() }); await Promise.resolve(); await Promise.resolve();
    expect((await usage(h.app, client).expect(200)).body.records[0]).toMatchObject({ local: true, cancelled: true });
    await post(h.app, client, '/api/tts', { text: '迟到的音频。', speed: 1, generationId: 2 }).expect(200).expect('x-audio-cache', 'miss');
    expect(h.qwen.speak).toHaveBeenCalledTimes(2); expect(h.cloud.speak).not.toHaveBeenCalled();
  });
  it('rejects delayed cancelled generations before starting the engine', async () => {
    const h = harness(); const client = await browser(h.app); await post(h.app, client, '/api/cancel', { generationId: 3 }).expect(200);
    expect((await post(h.app, client, '/api/tts', { text: '旧任务。', speed: 1, generationId: 3 }).expect(409)).body.error).toBe('stale_request');
    expect(h.qwen.speak).not.toHaveBeenCalled(); expect((await usage(h.app, client).expect(200)).body.records).toHaveLength(0);
  });
  it('waits for the Qwen generation budget instead of reusing the short cloud timeout', async () => {
    const h = harness({ requestTimeoutMs: 5 }); const client = await browser(h.app);
    h.qwen.speak.mockImplementationOnce(() => new Promise(resolve => { setTimeout(() => resolve({ audio: audio() }), 30); }));
    await post(h.app, client, '/api/tts', { text: 'CPU生成。', speed: 1 }).expect(200); expect(h.qwen.speak).toHaveBeenCalledOnce();
  });
  it('surfaces truncation as a retryable error without returning/caching partial audio or switching providers', async () => {
    const h = harness(); const client = await browser(h.app);
    h.qwen.speak.mockRejectedValueOnce(new HttpError(422, 'qwen_tts_truncated', '生成达到上限，请缩短原文。'));
    const result = await post(h.app, client, '/api/tts', { text: '长段落。', speed: 1 }).expect(422); expect(result.body.error).toBe('qwen_tts_truncated');
    expect(result.headers['content-type']).toContain('application/json');
    await post(h.app, client, '/api/tts', { text: '长段落。', speed: 1 }).expect(200).expect('x-audio-cache', 'miss');
    expect(h.qwen.speak).toHaveBeenCalledTimes(2); expect(h.kokoro.speak).not.toHaveBeenCalled(); expect(h.cloud.speak).not.toHaveBeenCalled();
  });
});




describe('Qwen device configuration (no real hardware)',()=>{
 it('preserves old CPU default and reports an explicit CUDA choice',async()=>{
  expect(readConfig({TTS_ENGINE:'qwen'}).qwenTtsDevice).toBe('cpu');
  expect(readConfig({TTS_ENGINE:'qwen',QWEN_TTS_DEVICE:'cuda'}).qwenTtsDevice).toBe('cuda');
  expect(()=>readConfig({QWEN_TTS_DEVICE:'automatic'})).toThrow('QWEN_TTS_DEVICE');
  const h=harness({qwenTtsDevice:'cuda'});expect((await browser(h.app)).config.speech?.device).toBe('cuda');
  const client=await browser(h.app);await post(h.app,client,'/api/tts',{text:'GPU只负责本机朗读。',speed:1}).expect(200);
  expect(h.qwen.speak).toHaveBeenCalledOnce();expect(h.cloud.speak).not.toHaveBeenCalled();
 });
});
