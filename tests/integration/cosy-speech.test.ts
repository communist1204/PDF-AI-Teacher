import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { Express } from 'express';
import { createApp } from '../../apps/server/src/app';
import { readConfig } from '../../apps/server/src/config';
import { HttpError } from '../../apps/server/src/errors';
import type { CosyTtsProvider, CosyTtsResult } from '../../apps/server/src/cosyTts';
import { defaultPreferences, SaveSettingsSchema, serverConfigFor } from '../../apps/desktop/settings';
import { normalizeSpeechEngine, usesPlaybackRate } from '../../packages/shared/localSpeech';
import { COSY_TTS_VOICE_IDS } from '../../packages/shared/cosySpeech';

const HOST = '127.0.0.1:4317', ORIGIN = `http://${HOST}`;
const apps: Express[] = [], servers: Server[] = [];
function harness(ready = true, env: NodeJS.ProcessEnv = {}) {
  const cosy = { ready: vi.fn(() => ready), status: vi.fn(() => ready ? 'idle' as const : 'missing' as const), speak: vi.fn<CosyTtsProvider['speak']>(async (_text, _speed, _signal, onAudio) => { const audio = Buffer.from('MP3-test-data'); onAudio?.(audio); return { audio }; }), dispose: vi.fn() };
  const fallback = { ready: vi.fn(() => true), speak: vi.fn(async () => ({ audio: Buffer.from('DO NOT USE') })), dispose: vi.fn() };
  const app = createApp({ config: readConfig({ TTS_ENGINE: 'cosy', ...env }), cosyTts: cosy, doubaoTts: fallback }); apps.push(app);
  return { app, cosy, fallback };
}
async function browser(app: Express) {
  const response = await request(app).get('/api/config').set('Host', HOST);
  return { config: response.body, headers: { Host: HOST, Origin: ORIGIN, Cookie: response.headers['set-cookie'][0].split(';')[0], 'x-csrf-token': response.body.csrfToken, 'x-task-lane': 'speech' } };
}
type Client = Awaited<ReturnType<typeof browser>>;
function post(app: Express, client: Client, endpoint = '/api/tts', body = {}) { return request(app).post(endpoint).set(client.headers).send({ sessionId: client.config.sessionId, generationId: 1, contextRevision: 1, ...(endpoint === '/api/tts' ? { text: '第一句测试。', speed: 1 } : {}), ...body }); }
async function usage(app: Express, client: Client) { return (await request(app).get('/api/usage').set({ Host: HOST, Cookie: client.headers.Cookie })).body; }
afterEach(async () => { for (const app of apps.splice(0)) await app.locals.dispose(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

describe('CosyVoice local HTTP contract (mock audio, no real model)', () => {
  it('accepts an explicit local choice without keys and preserves retired-engine migration', () => {
    expect(SaveSettingsSchema.parse({ ...defaultPreferences, ttsEngine: 'cosy' }).ttsEngine).toBe('cosy');
    expect(serverConfigFor({ ...defaultPreferences, ttsEngine: 'cosy' }, '', 4319)).toMatchObject({ demoMode: true, apiKey: '', ttsEngine: 'cosy' });
    expect(usesPlaybackRate('cosy')).toBe(true);
    for (const retired of ['qwen', 'local', 'system']) expect(normalizeSpeechEngine(retired)).toBe('none');
  });
  it('reports actual local status, works in demo without keys, and caches native-speed audio only on success', async () => {
    const h = harness(); const client = await browser(h.app);
    expect(client.config).toMatchObject({ mode: 'demo', speech: { engine: 'cosy', ready: true, status: 'idle', device: 'cuda', streaming: true, voice: 'cosy_default' }, models: { tts: 'Fun-CosyVoice3-0.5B-2512' }, capabilities: { tts: 'untested', text: 'unconfigured' } });
    await post(h.app, client).expect(200).expect('Content-Type', /audio\/mpeg/).expect('x-audio-cache', 'miss');
    await post(h.app, client, '/api/tts', { speed: 3 }).set('x-audio-stream', '1').expect(200).expect('x-audio-cache', 'hit');
    expect(h.cosy.speak).toHaveBeenCalledOnce(); expect(h.fallback.speak).not.toHaveBeenCalled();
    expect((await usage(h.app, client)).records[0]).toMatchObject({ local: true, model: 'Fun-CosyVoice3-0.5B-2512', cancelled: false });
  });
  it('keeps six voice cache entries separate and leaves the saved voice unchanged by previews', async () => {
    const h = harness(true, { COSY_TTS_VOICE: 'cosy_male_2' }); const client = await browser(h.app);
    expect(client.config.speech.voice).toBe('cosy_male_2');
    for (const voice of COSY_TTS_VOICE_IDS) {
      await post(h.app, client, '/api/tts', { cosyVoice: voice }).expect(200).expect('x-audio-cache', 'miss');
      expect(h.cosy.speak.mock.lastCall?.[4]).toBe(voice);
      await post(h.app, client, '/api/tts', { cosyVoice: voice, speed: 2 }).set('x-audio-stream', '1').expect(200).expect('x-audio-cache', 'hit');
    }
    expect(h.cosy.speak).toHaveBeenCalledTimes(6); expect((await usage(h.app, client)).cache.entries).toBe(6);
    await post(h.app, client).expect(200).expect('x-audio-cache', 'hit');
    expect((await request(h.app).get('/api/config').set({ Host: HOST, Cookie: client.headers.Cookie })).body.speech.voice).toBe('cosy_male_2');
    expect(h.fallback.speak).not.toHaveBeenCalled();
  });
  it('rejects unknown/path voices before changing either task lane or consuming the request budget', async () => {
    const h = harness(); const client = await browser(h.app);
    for (const cosyVoice of ['unknown', '../voice.wav', 'https://evil.example/voice.wav', 1, null]) {
      expect((await post(h.app, client, '/api/tts', { cosyVoice, generationId: 99, contextRevision: 99 }).expect(400)).body.error).toBe('invalid_request');
    }
    const current = (await request(h.app).get('/api/config').set({ Host: HOST, Cookie: client.headers.Cookie })).body;
    expect(current.generationId).toBe(client.config.generationId); expect(current.speechSession).toEqual(client.config.speechSession);
    expect((await usage(h.app, client)).requestCount).toBe(0); expect(h.cosy.speak).not.toHaveBeenCalled();
  });
  it.each(['none', 'doubao', 'openai'])('never turns a local voice preview into a %s request', async engine => {
    const h = harness(true, { TTS_ENGINE: engine, DOUBAO_TTS_API_KEY: 'fake-doubao', OPENAI_API_KEY: 'fake-openai', TTS_MODEL: 'gpt-4o-mini-tts', DEMO_MODE: 'false' });
    const client = await browser(h.app);
    expect((await post(h.app, client, '/api/tts', { cosyVoice: 'cosy_male_1' }).expect(400)).body.error).toBe('cosy_voice_engine');
    expect(h.cosy.speak).not.toHaveBeenCalled(); expect(h.fallback.speak).not.toHaveBeenCalled(); expect((await usage(h.app, client)).requestCount).toBe(0);
  });
  it('does not start uninstalled speech or bypass Origin and CSRF protection', async () => {
    const h = harness(false); const client = await browser(h.app);
    expect(client.config.speech).toMatchObject({ ready: false, status: 'missing' });
    expect((await post(h.app, client).expect(503)).body.error).toBe('cosy_not_installed');
    await post(h.app, client).set('Origin', 'http://evil.example').expect(403);
    await post(h.app, client).set('x-csrf-token', 'wrong').expect(403);
    expect(h.cosy.speak).not.toHaveBeenCalled(); expect((await usage(h.app, client)).requestCount).toBe(0);
  });
  it('returns early audio over actual HTTP before synthesis completes, then stores only the completed clip', async () => {
    const h = harness(); const client = await browser(h.app);
    let complete!: (value: CosyTtsResult) => void, emit!: (audio: Buffer) => void;
    h.cosy.speak.mockImplementationOnce(async (_text, _speed, _signal, onAudio) => { emit = onAudio!; onAudio!(Buffer.from('first')); return new Promise(resolve => { complete = resolve; }); });
    const server = createServer(h.app); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing address');
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${address.port}/api/tts`, { method: 'POST', headers: { ...client.headers, 'content-type': 'application/json', 'x-audio-stream': '1' } }, resolve);
      req.on('error', reject); req.end(JSON.stringify({ sessionId: client.config.sessionId, generationId: 1, contextRevision: 1, text: '流式测试。', speed: 1 }));
    });
    expect(response.statusCode).toBe(200); expect(response.headers['x-audio-streaming']).toBe('1'); expect(response.headers['x-session-id']).toBe(client.config.sessionId);
    const reader = response[Symbol.asyncIterator](); expect((await reader.next()).value.toString()).toBe('first');
    expect((await usage(h.app, client)).cache.entries).toBe(0);
    emit(Buffer.from('second')); complete({ audio: Buffer.from('firstsecond'), metrics: { firstPcmMs: 20, totalMs: 200, audioSeconds: 1 } });
    const trailing: Uint8Array[] = []; for (;;) { const next = await reader.next(); if (next.done) break; trailing.push(next.value); }
    expect(Buffer.concat(trailing).toString()).toBe('second'); expect((await usage(h.app, client)).cache.entries).toBe(1);
  });
  it('closes a partial stream on cancellation instead of returning success or caching its tail', async () => {
    const h = harness(); const client = await browser(h.app); let finish!: (value: CosyTtsResult) => void; let signal!: AbortSignal;
    h.cosy.speak.mockImplementationOnce(async (_text, _speed, inputSignal, onAudio) => { signal = inputSignal; onAudio!(Buffer.from('partial')); return new Promise(resolve => { finish = resolve; }); });
    const server = createServer(h.app); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing address');
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${address.port}/api/tts`, { method: 'POST', headers: { ...client.headers, 'content-type': 'application/json', 'x-audio-stream': '1' } }, resolve);
      req.on('error', reject); req.end(JSON.stringify({ sessionId: client.config.sessionId, generationId: 1, contextRevision: 1, text: '中途取消。', speed: 1 }));
    });
    const reader = response[Symbol.asyncIterator](); expect((await reader.next()).value.toString()).toBe('partial');
    const rest = reader.next(); const closed = expect(rest).rejects.toThrow();
    await post(h.app, client, '/api/cancel').expect(200); await closed;
    expect(signal.aborted).toBe(true); finish({ audio: Buffer.from('partial-unheard-tail') });
    expect((await usage(h.app, client)).cache.entries).toBe(0); expect((await usage(h.app, client)).records[0].cancelled).toBe(true);
  });
  it('maps pre-audio errors, cancels upstream, and never caches late results', async () => {
    const h = harness(); const client = await browser(h.app);
    h.cosy.speak.mockRejectedValueOnce(new HttpError(503, 'cosy_gpu_unavailable', '本地显卡不可用。'));
    expect((await post(h.app, client).set('x-audio-stream', '1').expect(503)).body.error).toBe('cosy_gpu_unavailable');
    let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; }); let finish!: (result: CosyTtsResult) => void; let signal!: AbortSignal;
    h.cosy.speak.mockImplementationOnce((_text, _speed, inputSignal) => { signal = inputSignal; started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = post(h.app, client, '/api/tts', { generationId: 2 }).then(response => response); await began;
    await post(h.app, client, '/api/cancel', { generationId: 2 }).expect(200); expect(signal.aborted).toBe(true); expect((await pending).body.error).toBe('cancelled');
    finish({ audio: Buffer.from('late') }); await Promise.resolve(); await Promise.resolve(); expect((await usage(h.app, client)).cache.entries).toBe(0); expect(h.fallback.speak).not.toHaveBeenCalled();
  });
});
