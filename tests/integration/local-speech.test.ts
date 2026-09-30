import {describe,expect,it,vi} from 'vitest';
import request from 'supertest';
import {createApp} from '../../apps/server/src/app';
import {readConfig} from '../../apps/server/src/config';
const host='127.0.0.1:4317';
function fixture(ready=true){return {ready:()=>ready,speak:vi.fn(async()=>({audio:Buffer.from('RIFF-fake-wav')})),dispose:vi.fn()};}
async function setup(local=fixture(),env:NodeJS.ProcessEnv={}){
 const network=vi.fn(async()=>{throw Error('Network must not be called by local TTS');});
 const app=createApp({config:readConfig({TTS_ENGINE:'local',...env}),localTts:local,fetch:network as typeof fetch});
 const response=await request(app).get('/api/config').set('Host',host).expect(200);
 const config=response.body;
 const headers={Host:host,Origin:`http://${host}`,Cookie:response.headers['set-cookie'][0].split(';')[0],'x-csrf-token':config.csrfToken};
 const envelope={sessionId:config.sessionId,generationId:1,contextRevision:1};
 return {app,local,network,config,headers,envelope,speak:(body={})=>request(app).post('/api/tts').set(headers).send({...envelope,text:'免费本地测试，不发送到云端。',speed:1,...body})};
}
describe('independent free local TTS integration (mock inference, no network)',()=>{
 it('reads real local speech in demo without a key while keeping answers explicitly demo',async()=>{
  const test=await setup();
  expect(test.config.mode).toBe('demo');
  expect(test.config.capabilities.text).toBe('unconfigured');
  expect(test.config.speech).toMatchObject({engine:'local',ready:true,voice:'zf_001'});
  const audio=await test.speak().expect(200);
  expect(audio.headers['content-type']).toContain('audio/wav');
  expect(audio.headers['x-generation-id']).toBe('1');
  expect(test.local.speak).toHaveBeenCalledOnce();
  expect(test.network).not.toHaveBeenCalled();
  const usage=await request(test.app).get('/api/usage').set(test.headers);
  expect(usage.body.records[0]).toMatchObject({local:true,model:'Kokoro-82M-v1.1-zh'});
  expect(usage.body.requestCount).toBe(0);
 });
 it('uses cached original-speed WAV when playback speed changes and does not spend paid request quota',async()=>{
  const test=await setup(fixture(),{MAX_SESSION_REQUESTS:'1'});
  await test.speak({speed:0.25}).expect(200);
  expect((await test.speak({speed:1.5}).expect(200)).headers['x-audio-cache']).toBe('hit');
  await test.speak({text:'第二句',generationId:2}).expect(200);
  expect(test.local.speak).toHaveBeenCalledTimes(2);
  expect(test.network).not.toHaveBeenCalled();
 });
 it('does not fall back to a configured paid key if the local package is missing',async()=>{
  const test=await setup(fixture(false),{DEMO_MODE:'false',OPENAI_API_KEY:'fake-only',TTS_MODEL:'gpt-4o-mini-tts'});
  expect(test.config.speech.ready).toBe(false);
  const error=await test.speak().expect(503);
  expect(error.body.error).toBe('local_tts_missing');
  expect(test.local.speak).not.toHaveBeenCalled();
  expect(test.network).not.toHaveBeenCalled();
 });
 it('discards cancelled local output and clears its resources on app disposal',async()=>{
  const local=fixture();let signal:AbortSignal|undefined;let finish!:(value:{audio:Buffer<ArrayBuffer>})=>void;
  local.speak=vi.fn((_text?:string,_speed?:number,abort?:AbortSignal)=>{signal=abort;return new Promise(resolve=>{finish=resolve;});});
  const test=await setup(local);
  const pending=test.speak().then(value=>value);
  await vi.waitFor(()=>expect(signal).toBeDefined());
  await request(test.app).post('/api/cancel').set(test.headers).send(test.envelope).expect(200);
  expect(signal!.aborted).toBe(true);
  finish({audio:Buffer.from('late output')});
  expect((await pending).status).toBe(409);
  await test.app.locals.dispose();
  expect(local.dispose).toHaveBeenCalledOnce();
  expect(test.network).not.toHaveBeenCalled();
 });
});
