import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/server/src/app';
import { readConfig, type ServerConfig } from '../../apps/server/src/config';
import { normalizeSpeechEngine } from '../../packages/shared/localSpeech';
const host='127.0.0.1:4317';
const apps:Array<ReturnType<typeof createApp>>=[];
function fixture(){return {ready:vi.fn(()=>true),speak:vi.fn(async()=>({audio:Buffer.from('must-not-play')})),dispose:vi.fn()};}
async function harness(ttsEngine:ServerConfig['ttsEngine'],direct=false){
 const local=fixture(),qwen=fixture();const cloud={ask:vi.fn(),speak:vi.fn(),transcribe:vi.fn()};const fetch=vi.fn();
 const env={TTS_ENGINE:ttsEngine,DEMO_MODE:'false',OPENAI_API_KEY:'fake-openai',DOUBAO_TTS_API_KEY:'fake-doubao',TTS_MODEL:'gpt-4o-mini-tts',CHAT_MODEL:'expert-model'};
 const config=direct?{...readConfig(env),ttsEngine}:readConfig(env);
 const app=createApp({config,localTts:local,qwenTts:qwen,provider:cloud,fetch});apps.push(app);
 const response=await request(app).get('/api/config').set('Host',host).expect(200);const settings=response.body;
 const headers={Host:host,Origin:'http://'+host,Cookie:response.headers['set-cookie'][0].split(';')[0],'x-csrf-token':settings.csrfToken};
 const envelope={sessionId:settings.sessionId,generationId:1,contextRevision:1};
 const post=(path:string,payload:object={})=>request(app).post(path).set(headers).send({...envelope,...payload});
 return {app,local,qwen,cloud,fetch,settings,headers,post};
}
afterEach(async()=>{for(const app of apps.splice(0))await app.locals.dispose();});
describe('removed engine migration and HTTP rejection',()=>{
 it.each(['local','qwen','system'] as const)('maps old %s env configuration to none without loading resources or exposing diagnostics',async engine=>{
  const h=await harness(engine);expect(h.settings.speech).toMatchObject({engine:'none',ready:false});expect(h.settings.models.tts).toBe('');expect(h.settings.capabilities.tts).toBe('unconfigured');
  expect(h.settings.speech).not.toHaveProperty('device');expect(h.local.ready).not.toHaveBeenCalled();expect(h.qwen.ready).not.toHaveBeenCalled();
  const result=await h.post('/api/tts',{text:'不应调用已退役的声音。',speed:1}).expect(503);expect(result.body.error).toBe('speech_not_configured');
  expect(h.local.speak).not.toHaveBeenCalled();expect(h.qwen.speak).not.toHaveBeenCalled();expect(h.cloud.speak).not.toHaveBeenCalled();expect(h.fetch).not.toHaveBeenCalled();
 });
 it.each(['local','qwen','system'] as const)('rejects direct legacy %s injection even with both cloud credentials available',async engine=>{
  const h=await harness(engine,true);await h.post('/api/tts',{text:'保持关闭，不切换收费服务。',speed:3}).expect(503);
  expect(h.local.speak).not.toHaveBeenCalled();expect(h.qwen.speak).not.toHaveBeenCalled();expect(h.cloud.speak).not.toHaveBeenCalled();expect(h.fetch).not.toHaveBeenCalled();
  const usage=await request(h.app).get('/api/usage').set(h.headers).expect(200);expect(usage.body.requestCount).toBe(0);expect(usage.body.records).toHaveLength(0);
 });
 it('still rejects cancelled generations before checking speech configuration',async()=>{
  const h=await harness('qwen');await h.post('/api/cancel',{generationId:3}).expect(200);
  const result=await h.post('/api/tts',{text:'迟到的原文。',speed:1,generationId:3}).expect(409);expect(result.body.error).toBe('stale_request');expect(h.qwen.speak).not.toHaveBeenCalled();
 });
 it('ignores obsolete device settings instead of probing CUDA or loading voices',()=>{
  const config=readConfig({TTS_ENGINE:'qwen',QWEN_TTS_DEVICE:'cuda',QWEN_TTS_VOICE:'vivian',LOCAL_TTS_VOICE:'zf_002'});expect(config.ttsEngine).toBe('none');expect(config).not.toHaveProperty('qwenTtsDevice');expect(config).not.toHaveProperty('qwenTtsVoice');expect(config).not.toHaveProperty('localTtsVoice');
 });
 it('accepts only explicit active providers as a runtime choice',()=>{
  for(const engine of [undefined,'','local','qwen','system','unknown'])expect(normalizeSpeechEngine(engine)).toBe('none');for(const engine of ['doubao','openai'] as const)expect(normalizeSpeechEngine(engine)).toBe(engine);expect(()=>readConfig({TTS_ENGINE:'unknown'})).toThrow('TTS_ENGINE');
 });
});
