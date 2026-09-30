import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../apps/server/src/app';
import { readConfig, type ServerConfig } from '../../apps/server/src/config';
import { makeDemoPlan } from '../../apps/server/src/demo';
import type { TeachingProvider } from '../../apps/server/src/provider';
import type { AppConfig, AskRequest, UsageRecord } from '../../packages/shared/protocol';

const HOST = '127.0.0.1:4317';
const ORIGIN = `http://${HOST}`;
type Browser = { config: AppConfig; cookie: string };
async function browser(app: Express): Promise<Browser> {
  const response = await request(app).get('/api/config').set('Host', HOST).expect(200);
  return { config: response.body, cookie: response.headers['set-cookie'][0].split(';')[0] };
}
function post(app: Express, client: Browser, endpoint: string, body: object) {
  return request(app).post(endpoint).set({ Host: HOST, Origin: ORIGIN, Cookie: client.cookie, 'x-csrf-token': client.config.csrfToken }).send({ sessionId: client.config.sessionId, generationId: 1, contextRevision: 1, ...body });
}
function usage(app: Express, client: Browser) { return request(app).get('/api/usage').set({ Host: HOST, Cookie: client.cookie }); }
function askBody(): Omit<AskRequest, 'sessionId' | 'generationId' | 'contextRevision'> {
  return { question: '解释这一段', context: { documentId: 'book', sources: [{ sourceId: 'selected', documentId: 'book', pageIndex: 0, pageLabel: null, blockId: 'p1', rect: null, sourceText: '原文数据。' }], selectedBoardText: null, imageDataUrl: null }, history: [] };
}
function speechResponse(characters?: number) {
  return new Response(JSON.stringify({code:0,data:Buffer.from([1,0,2,0]).toString('base64')})+'\n'+JSON.stringify({code:20000000,...(characters === undefined ? {} : {usage:{text_words:characters}})})+'\n', {status:200,headers:{'Content-Type':'application/json'}});
}
const apps: Express[] = [];
function harness(patch: Partial<ServerConfig> = {}) {
  const config = {...readConfig({TTS_ENGINE:'doubao',DOUBAO_TTS_API_KEY:'mock-doubao-private',DOUBAO_TTS_INSTRUCTIONS:'private-custom-style',CHAT_MODEL:'expert-text',VISION_MODEL:'expert-vision'}),...patch};
  const fetchMock = vi.fn<typeof fetch>(async () => speechResponse(17));
  const cloud: TeachingProvider = {ask:vi.fn(async body => ({plan:makeDemoPlan(body)})),speak:vi.fn(async () => {throw Error('unexpected OpenAI speech');}),transcribe:vi.fn(async () => {throw Error('unexpected transcription');})};
  const local = {ready:vi.fn(() => true),speak:vi.fn(async () => {throw Error('unexpected local fallback');}),dispose:vi.fn()};
  const qwen = {ready:vi.fn(() => true),speak:vi.fn(async () => {throw Error('unexpected Qwen fallback');}),dispose:vi.fn()};
  const app = createApp({config,provider:cloud,localTts:local,qwenTts:qwen,fetch:fetchMock}); apps.push(app);
  return {app,config,fetchMock,cloud,local,qwen};
}
function noFallback(h: ReturnType<typeof harness>) {expect(h.cloud.speak).not.toHaveBeenCalled();expect(h.local.speak).not.toHaveBeenCalled();expect(h.qwen.speak).not.toHaveBeenCalled();}
afterEach(async () => {for (const app of apps.splice(0)) await app.locals.dispose();});

// Actual local HTTP route and Doubao parser; all outbound traffic uses the injected fetch stub.
describe('independent Doubao speech HTTP contract (no online calls)', () => {
  it('keeps demo questions separate from configured online speech and hides both providers keys', async () => {
    const h = harness({apiKey:'mock-openai-private'}); const client = await browser(h.app);
    expect(client.config).toMatchObject({mode:'demo',models:{chat:'expert-text',vision:'expert-vision',tts:'Doubao-Seed-TTS-2.0'},speech:{engine:'doubao',ready:true},capabilities:{text:'unconfigured',tts:'untested'}});
    const exposed = JSON.stringify(client.config); expect(exposed).not.toMatch(/mock-doubao-private|mock-openai-private|private-custom-style/);
    const answer = await post(h.app,client,'/api/ask',askBody()).expect(200); expect(answer.body.mode).toBe('demo'); expect(h.cloud.ask).not.toHaveBeenCalled(); expect(h.fetchMock).not.toHaveBeenCalled();
    const response = await post(h.app,client,'/api/tts',{text:'只朗读这段原文。',speed:3}).expect(200);
    expect(response.headers['content-type']).toContain('audio/wav'); expect(response.headers['x-session-id']).toBe(client.config.sessionId); expect(response.headers['x-generation-id']).toBe('1');
    const [url,init] = h.fetchMock.mock.calls[0]; expect(url).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    const headers = new Headers(init?.headers); expect(headers.get('X-Api-Key')).toBe('mock-doubao-private'); expect(headers.get('X-Api-Resource-Id')).toBe('seed-tts-2.0');
    const body = JSON.parse(String(init?.body)); expect(body.req_params).toMatchObject({text:'只朗读这段原文。',audio_params:{speech_rate:0}});
    expect(JSON.parse(body.req_params.additions).section_id).toBe(`${client.config.sessionId}-1-1`);
    const record = (await usage(h.app,client).expect(200)).body.records.find((value:UsageRecord) => value.category==='tts');
    expect(record).toMatchObject({model:'Doubao-Seed-TTS-2.0',characters:17,cancelled:false,estimatedCost:null}); expect(record.local).not.toBe(true); noFallback(h);
  });

  it('allows configured Doubao speech even when professional question models are not connected', async () => {
    const h = harness({demoMode:false,apiKey:''}); const client = await browser(h.app); expect(client.config.mode).toBe('unconfigured');
    await post(h.app,client,'/api/tts',{text:'独立朗读。',speed:1}).expect(200);
    const answer = await post(h.app,client,'/api/ask',askBody()).expect(503); expect(answer.body.error).toBe('not_configured'); expect(h.cloud.ask).not.toHaveBeenCalled(); noFallback(h);
  });

  it('does not treat an OpenAI key as a Doubao key and never falls back when Doubao is unconfigured', async () => {
    const h = harness({doubaoApiKey:'',apiKey:'mock-openai-only'}); const client = await browser(h.app);
    expect(client.config.speech).toMatchObject({engine:'doubao',ready:false}); expect(client.config.capabilities.tts).toBe('unconfigured');
    const response = await post(h.app,client,'/api/tts',{text:'缺少专用密钥。',speed:1}).expect(503);
    expect(response.body.error).toBe('doubao_not_configured'); expect(response.body.message).toContain('没有改用其他服务'); expect(h.fetchMock).not.toHaveBeenCalled(); noFallback(h);
    expect((await usage(h.app,client).expect(200)).body).toMatchObject({requestCount:0,records:[]});
  });

  it.each([23,0,undefined])('reports server character usage %s instead of counting submitted text', async characters => {
    const h = harness(); h.fetchMock.mockResolvedValueOnce(speechResponse(characters)); const client = await browser(h.app);
    await post(h.app,client,'/api/tts',{text:'客户端长度不作为收费字数。',speed:1}).expect(200);
    expect((await usage(h.app,client).expect(200)).body.records[0]).toMatchObject({characters:characters??null,estimatedCost:null,inputTokens:null,outputTokens:null});
  });

  it('reuses native-speed audio across rate changes but keeps cache and quota session-scoped', async () => {
    const h = harness(); const first = await browser(h.app); const second = await browser(h.app);
    for (const [index,speed] of [1,0.25,3].entries()) await post(h.app,first,'/api/tts',{text:'同一段原文。',speed}).expect(200).expect('x-audio-cache',index?'hit':'miss');
    expect(h.fetchMock).toHaveBeenCalledOnce(); expect((await usage(h.app,first).expect(200)).body).toMatchObject({requestCount:1});
    expect((await usage(h.app,first).expect(200)).body.records).toHaveLength(1);
    await post(h.app,second,'/api/tts',{text:'同一段原文。',speed:3}).expect(200).expect('x-audio-cache','miss');
    await post(h.app,first,'/api/cache/clear',{}).expect(200); await post(h.app,first,'/api/tts',{text:'同一段原文。',speed:1}).expect(200).expect('x-audio-cache','miss');
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([{maxRequests:1,requestsPerMinute:10,error:'session_limit'},{maxRequests:10,requestsPerMinute:1,error:'local_rate_limit'}])('applies $error to cloud generations while a cached clip remains usable', async ({error,...limits}) => {
    const h = harness(limits); const client = await browser(h.app);
    await post(h.app,client,'/api/tts',{text:'第一句。',speed:1}).expect(200);
    await post(h.app,client,'/api/tts',{text:'第一句。',speed:3}).expect(200).expect('x-audio-cache','hit');
    const rejected = await post(h.app,client,'/api/tts',{text:'不同句子。',speed:1}).expect(429); expect(rejected.body.error).toBe(error);
    expect(h.fetchMock).toHaveBeenCalledOnce(); expect((await usage(h.app,client).expect(200)).body).toMatchObject({requestCount:1}); noFallback(h);
  });

  it('does not invent billed character usage when the upstream request fails or retry automatically', async () => {
    const h = harness(); h.fetchMock.mockResolvedValueOnce(new Response('private provider diagnostic',{status:429})); const client = await browser(h.app);
    const result = await post(h.app,client,'/api/tts',{text:'失败请求中的原文。',speed:1}).expect(503);
    expect(result.body.error).toBe('doubao_tts_limit'); expect(JSON.stringify(result.body)).not.toContain('private provider diagnostic');
    expect(h.fetchMock).toHaveBeenCalledOnce(); noFallback(h);
    expect((await usage(h.app,client).expect(200)).body.records[0]).toMatchObject({characters:null,cancelled:false,estimatedCost:null});
  });

  it('aborts cancelled transport, discards late bytes and keeps unknown characters null', async () => {
    const h = harness(); const client = await browser(h.app);
    let started!: () => void; const began = new Promise<void>(resolve => {started=resolve;});
    let finish!: (response: Response) => void; let signal!: AbortSignal;
    h.fetchMock.mockImplementationOnce((_url,init) => {signal=init!.signal!;started();return new Promise(resolve => {finish=resolve;});});
    const pending = post(h.app,client,'/api/tts',{text:'取消的同一句。',speed:1}).then(response => response);
    await began; await post(h.app,client,'/api/cancel',{}).expect(200); expect(signal.aborted).toBe(true);
    expect((await pending).body.error).toBe('cancelled'); finish(speechResponse(99)); await Promise.resolve(); await Promise.resolve();
    const report = (await usage(h.app,client).expect(200)).body; expect(report.records[0]).toMatchObject({characters:null,cancelled:true}); expect(report.cache.entries).toBe(0);
    await post(h.app,client,'/api/tts',{text:'取消的同一句。',speed:1,generationId:2}).expect(200).expect('x-audio-cache','miss');
    expect(h.fetchMock).toHaveBeenCalledTimes(2); noFallback(h);
  });

  it('dispose aborts only owned work, clears sessions, and is safe to repeat', async () => {
    const h = harness(); const client = await browser(h.app);
    let started!: () => void; const began = new Promise<void>(resolve => {started=resolve;}); let signal!: AbortSignal;
    h.fetchMock.mockImplementationOnce((_url,init) => {signal=init!.signal!;started();return new Promise(() => {});});
    const pending = post(h.app,client,'/api/tts',{text:'退出时停止。',speed:1}).then(response => response);
    await began; await h.app.locals.dispose(); await h.app.locals.dispose();
    expect(signal.aborted).toBe(true); expect((await pending).body.error).toBe('cancelled');
    await usage(h.app,client).expect(401); expect(h.local.dispose).toHaveBeenCalledOnce(); expect(h.qwen.dispose).toHaveBeenCalledOnce(); noFallback(h);
  });
});
