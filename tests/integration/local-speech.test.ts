import {describe,expect,it,vi} from 'vitest';
import request from 'supertest';
import {readFile} from 'node:fs/promises';
import {createApp} from '../../apps/server/src/app';
import {readConfig} from '../../apps/server/src/config';
const host='127.0.0.1:4317';
describe('retired local and system speech (no inference or network)',()=>{
 it('defaults to closed speech while preserving the keyless demo reader and Q&A',async()=>{
  const network=vi.fn(async()=>{throw Error('Unexpected network');});
  const app=createApp({config:readConfig({}),fetch:network});
  const response=await request(app).get('/api/config').set('Host',host).expect(200);
  expect(response.body).toMatchObject({mode:'demo',capabilities:{text:'unconfigured',tts:'unconfigured'},speech:{engine:'none',ready:false,voice:'',instructionsSupported:false}});
  const headers={Host:host,Origin:'http://'+host,Cookie:response.headers['set-cookie'][0].split(';')[0],'x-csrf-token':response.body.csrfToken};
  const envelope={sessionId:response.body.sessionId,generationId:1,contextRevision:1};
  const audio=await request(app).post('/api/tts').set(headers).send({...envelope,text:'所选原文。',speed:1}).expect(503);
  expect(audio.body.error).toBe('speech_not_configured');
  const answer=await request(app).post('/api/ask').set(headers).send({...envelope,question:'解释原文',history:[],context:{documentId:'book',sources:[{sourceId:'source',documentId:'book',pageIndex:0,pageLabel:null,blockId:'block',rect:null,sourceText:'所选原文。'}],selectedBoardText:null,imageDataUrl:null}}).expect(200);
  expect(answer.body.mode).toBe('demo');expect(network).not.toHaveBeenCalled();await app.locals.dispose();
 });
 it('removes runtime initialization and hardware probing from both startup paths',async()=>{
  for(const path of ['apps/desktop/main.ts','apps/server/src/index.ts'])expect(await readFile(path,'utf8')).not.toMatch(/new\s+(?:LocalTtsProvider|QwenTtsProvider)|qwenCudaRuntimeReady|local-tts-runtime|qwen-tts-runtime/);
 });
 it('does not package native runtimes or install sherpa',async()=>{
  const pkg=JSON.parse(await readFile('package.json','utf8'));expect(pkg.dependencies).not.toHaveProperty('sherpa-onnx-node');expect(Object.keys(pkg.scripts).some(key=>key.startsWith('tts:'))).toBe(false);
  const lock=JSON.parse(await readFile('package-lock.json','utf8'));expect(Object.keys(lock.packages).some(key=>key.includes('sherpa-onnx'))).toBe(false);
  for(const path of ['scripts/build-desktop.mjs','scripts/package-desktop.mjs'])expect(await readFile(path,'utf8')).not.toMatch(/local-tts-runtime|qwen-tts-runtime|local-tts-worker/);
 });
 it('does not infer cloud selection from an existing OpenAI key or model',()=>{
  const config=readConfig({DEMO_MODE:'false',OPENAI_API_KEY:'fake-key',TTS_MODEL:'gpt-4o-mini-tts'});expect(config.ttsEngine).toBe('none');expect(config.ttsInstructionsSupported).toBe(false);
 });
});
