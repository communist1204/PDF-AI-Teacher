import { DEFAULT_QWEN_TTS_INSTRUCTIONS, DEFAULT_QWEN_TTS_VOICE } from '../../packages/shared/localSpeech';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {readConfig} from '../server/src/config';
import type { DesktopPreferences } from '../../packages/shared/desktop';

export const PreferenceSchema = z.object({
  mode: z.enum(['demo','chatgpt','api']),
  ttsEngine:z.enum(['local','qwen','openai','system']).default('local'),
  qwenTtsVoice:z.enum(['serena','vivian','uncle_fu']).default('serena'),
  qwenTtsInstructions:z.string().trim().max(1000).default(DEFAULT_QWEN_TTS_INSTRUCTIONS),
  localTtsVoice:z.enum(['zf_001','zf_002','zf_003','zm_010','zm_011','zm_012']).default('zf_001'),
  chatModel:z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._:-]+$/),
  visionModel:z.string().trim().max(120).regex(/^[a-zA-Z0-9._:-]*$/),
  reasoningEffort:z.enum(['','none','minimal','low','medium','high','xhigh','max']),
  ttsModel:z.string().trim().max(120).regex(/^[a-zA-Z0-9._:-]*$/),
  ttsVoice:z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  ttsInstructions:z.string().trim().max(3000),
}).strict();
export const SaveSettingsSchema = PreferenceSchema.extend({apiKey:z.string().trim().max(500).optional(),clearApiKey:z.boolean().optional()}).strict();
export const defaultPreferences:DesktopPreferences = {ttsEngine:'local',qwenTtsVoice:DEFAULT_QWEN_TTS_VOICE,qwenTtsInstructions:DEFAULT_QWEN_TTS_INSTRUCTIONS,localTtsVoice:'zf_001',mode:'demo',chatModel:'gpt-6-astra',visionModel:'gpt-6-astra',reasoningEffort:'xhigh',ttsModel:'gpt-4o-mini-tts',ttsVoice:'marin',ttsInstructions:'像面对面陪读的中文老师，温和自然，按句意停顿，避免播音腔。'};
export interface PrivateSettings {version:1;hostId:string;port:number;preferences:DesktopPreferences;apiKey:string;auth:unknown|null}
export interface Cipher {available():boolean;encrypt(value:string):Buffer;decrypt(value:Buffer):string}
export class SettingsVault {
  private value:PrivateSettings={version:1,hostId:'urn:uuid:'+randomUUID(),port:4319,preferences:{...defaultPreferences},apiKey:'',auth:null};
  private queue=Promise.resolve();
  constructor(private readonly path:string,private readonly cipher:Cipher){}
  get(){return structuredClone(this.value);}
  available(){return this.cipher.available();}
  async flush(){let pending;do{pending=this.queue;await pending;}while(pending!==this.queue);}
  async load(){
    let bytes:Buffer;try{bytes=await readFile(this.path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw Error('无法读取本软件的本机配置。',{cause:error});}
    if(!this.available())throw Error('Windows 凭证加密服务不可用，无法打开已保存配置。');
    try{const raw=JSON.parse(this.cipher.decrypt(bytes));
      const parsed=z.object({version:z.literal(1),hostId:z.string().regex(/^urn:uuid:[a-f0-9-]{36}$/),port:z.number().int().min(1024).max(65535),preferences:PreferenceSchema,apiKey:z.string().max(500),auth:z.unknown().nullable()}).strict().parse(raw);
      this.value=parsed as PrivateSettings;
    }catch{throw Error('本软件的配置无法解密或已损坏。请使用原 Windows 账户打开；原文件未被覆盖。');}
  }
  update(patch:Partial<Omit<PrivateSettings,'version'|'hostId'>>){
    const operation=this.queue.then(async()=>{
      if(!this.available())throw Error('Windows 凭证加密不可用，未保存任何明文凭证。');
      const next={...this.value,...patch};const encrypted=this.cipher.encrypt(JSON.stringify(next));
      await mkdir(dirname(this.path),{recursive:true});
      const temporary=this.path+'.tmp';await writeFile(temporary,encrypted,{mode:0o600});await rename(temporary,this.path);
      this.value=next;
    });this.queue=operation.catch(()=>{});return operation;
  }
}

export function serverConfigFor(preferences:DesktopPreferences,apiKey:string,port:number){
 return readConfig({TTS_ENGINE:preferences.ttsEngine??'local',LOCAL_TTS_VOICE:preferences.localTtsVoice??'zf_001',QWEN_TTS_VOICE:preferences.qwenTtsVoice,QWEN_TTS_INSTRUCTIONS:preferences.qwenTtsInstructions,APP_PORT:String(port),DEMO_MODE:String(preferences.mode==='demo'),OPENAI_API_KEY:apiKey,CHAT_MODEL:preferences.chatModel,VISION_MODEL:preferences.visionModel,CHAT_REASONING_EFFORT:preferences.reasoningEffort,VISION_REASONING_EFFORT:preferences.reasoningEffort,TTS_MODEL:preferences.ttsModel,TTS_VOICE:preferences.ttsVoice,TTS_INSTRUCTIONS:preferences.ttsInstructions,TEACHING_MAX_OUTPUT_TOKENS:'32000',TEACHING_TIMEOUT_MS:'300000'});
}
