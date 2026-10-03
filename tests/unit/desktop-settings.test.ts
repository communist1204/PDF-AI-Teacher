import {describe,it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {SettingsVault,defaultPreferences,SaveSettingsSchema,serverConfigFor} from '../../apps/desktop/settings';
const root=resolve('test-results');
const cipher={available:()=>true,encrypt:(value:string)=>Buffer.from('TEST-CIPHER:'+Buffer.from(value).toString('base64')),decrypt:(bytes:Buffer)=>{if(!bytes.toString().startsWith('TEST-CIPHER:'))throw Error('Bad encrypted file');return Buffer.from(bytes.toString().slice(12),'base64').toString();}};
async function temporary(run:(file:string)=>Promise<void>){await import('node:fs/promises').then(fs=>fs.mkdir(root,{recursive:true}));const directory=await mkdtemp(join(root,'vault-'));if(!directory.startsWith(root+'\\')&&!directory.startsWith(root+'/'))throw Error('Unsafe test path');try{await run(join(directory,'private.bin'));}finally{await rm(directory,{recursive:true,force:true});}}
describe('desktop private configuration',()=>{
 it('validates the same provider configuration before saving or starting',()=>{expect(()=>serverConfigFor({...defaultPreferences,ttsEngine:'openai',ttsModel:''},'',4319)).toThrow('语气');expect(()=>serverConfigFor({...defaultPreferences,ttsEngine:'openai',ttsModel:'tts-1'},'',4319)).toThrow('语气');expect(serverConfigFor({...defaultPreferences,ttsEngine:'openai',ttsModel:'',ttsInstructions:''},'',4319).ttsModel).toBe('');});
 it('round-trips through cipher without persisting plaintext key and merges queued writes',async()=>temporary(async file=>{const vault=new SettingsVault(file,cipher);await vault.load();const writes=[vault.update({apiKey:'test-secret-never-real'}),vault.update({preferences:{...defaultPreferences,ttsVoice:'cedar'}})];await vault.flush();await Promise.all(writes);const bytes=await readFile(file);expect(bytes.includes(Buffer.from('test-secret-never-real'))).toBe(false);const restored=new SettingsVault(file,cipher);await restored.load();expect(restored.get().apiKey).toBe('test-secret-never-real');expect(restored.get().preferences.ttsVoice).toBe('cedar');expect(restored.get().hostId).toBe(vault.get().hostId);}));
 it('refuses plaintext persistence if OS encryption is unavailable',async()=>temporary(async file=>{const vault=new SettingsVault(file,{...cipher,available:()=>false});await expect(vault.update({apiKey:'fake-value'})).rejects.toThrow('加密');await expect(readFile(file)).rejects.toMatchObject({code:'ENOENT'});expect(vault.get().apiKey).toBe('');}));
 it('does not overwrite corrupt encrypted configuration on load',async()=>temporary(async file=>{await writeFile(file,'corrupt');const vault=new SettingsVault(file,cipher);await expect(vault.load()).rejects.toThrow('未被覆盖');expect(await readFile(file,'utf8')).toBe('corrupt');}));
 it('failed writes do not mutate the in-memory key',async()=>temporary(async file=>{const vault=new SettingsVault(file,{...cipher,encrypt:()=>{throw Error('Cipher unavailable');}});await expect(vault.update({apiKey:'fake-value'})).rejects.toThrow();expect(vault.get().apiKey).toBe('');}));
 it('rejects excess keys, invalid modes, unsafe model identifiers and oversized secrets',()=>{expect(SaveSettingsSchema.safeParse({...defaultPreferences,host:'0.0.0.0'}).success).toBe(false);expect(SaveSettingsSchema.safeParse({...defaultPreferences,mode:'logged-in'}).success).toBe(false);expect(SaveSettingsSchema.safeParse({...defaultPreferences,chatModel:'https://evil.example'}).success).toBe(false);expect(SaveSettingsSchema.safeParse({...defaultPreferences,apiKey:'a'.repeat(501)}).success).toBe(false);expect(SaveSettingsSchema.safeParse({...defaultPreferences,clearApiKey:true}).success).toBe(true);});
});


describe('retired local speech settings migration',()=>{
 it('migrates legacy encrypted preferences without changing the account, key or expert model',async()=>temporary(async file=>{
  const first=new SettingsVault(file,cipher);await first.load();
  await first.update({apiKey:'fake-legacy-key',auth:{testOnly:true},preferences:{...defaultPreferences,mode:'chatgpt',chatModel:'expert-model'}});
  const original=JSON.parse(cipher.decrypt(await readFile(file)));
  delete original.preferences.ttsEngine;delete original.preferences.localTtsVoice;
  await writeFile(file,cipher.encrypt(JSON.stringify(original)));
  const migrated=new SettingsVault(file,cipher);await migrated.load();
  expect(migrated.get().preferences).toMatchObject({ttsEngine:'none',mode:'chatgpt',chatModel:'expert-model'});
  expect(migrated.get().apiKey).toBe('fake-legacy-key');expect(migrated.get().auth).toEqual({testOnly:true});
  expect(migrated.get().hostId).toBe(original.hostId);
 }));
});


describe('independent free speech configuration',()=>{
 it.each(['local','qwen','system'] as const)('ignores hidden cloud model style when %s is selected',engine=>{
  const config=serverConfigFor({...defaultPreferences,ttsEngine:engine,ttsModel:'tts-1',ttsInstructions:'旧的云声音风格'},'',4319);
  expect(config).toMatchObject({ttsEngine:'none',ttsInstructions:'',ttsInstructionsSupported:false});
  expect(serverConfigFor({...defaultPreferences,ttsEngine:engine,ttsModel:''},'',4319).ttsEngine).toBe('none');
 });
});


describe('Qwen device preference migration',()=>{
 it('disables retired Qwen choices and drops only obsolete CPU/CUDA preferences',async()=>temporary(async file=>{
  const vault=new SettingsVault(file,cipher);await vault.load();
  await vault.update({apiKey:'fake-key',preferences:{...defaultPreferences,ttsEngine:'qwen',qwenTtsDevice:'cuda',chatModel:'expert-model'}});
  const restored=new SettingsVault(file,cipher);await restored.load();expect(restored.get().preferences.ttsEngine).toBe('none');expect(restored.get().preferences).not.toHaveProperty('qwenTtsDevice');
  const legacy=JSON.parse(cipher.decrypt(await readFile(file)));delete legacy.preferences.qwenTtsDevice;await writeFile(file,cipher.encrypt(JSON.stringify(legacy)));
  const migrated=new SettingsVault(file,cipher);await migrated.load();expect(migrated.get().preferences.ttsEngine).toBe('none');expect(migrated.get().preferences).not.toHaveProperty('qwenTtsDevice');expect(migrated.get().preferences.chatModel).toBe('expert-model');expect(migrated.get().apiKey).toBe('fake-key');
 }));
 it('does not pass a retired CPU/CUDA choice into service startup',()=>{
  expect(serverConfigFor({...defaultPreferences,ttsEngine:'qwen',qwenTtsDevice:'cuda'},'',4319).qwenTtsDevice).toBeUndefined();
  expect(SaveSettingsSchema.safeParse({...defaultPreferences,qwenTtsDevice:'auto'}).success).toBe(false);
 });
});

describe('Doubao independent credential and preference migration',()=>{
 it('migrates a pre-Doubao vault with retired Qwen disabled while preserving expert models, auth and credentials',async()=>temporary(async file=>{
  const vault=new SettingsVault(file,cipher);await vault.load();
  const preferences={...defaultPreferences,ttsEngine:'qwen' as const,qwenTtsDevice:'cuda' as const,qwenTtsVoice:'vivian',qwenTtsInstructions:'原有本地语气',mode:'chatgpt' as const,chatModel:'expert-text',visionModel:'expert-vision',reasoningEffort:'xhigh',ttsVoice:'cedar',ttsInstructions:'原有 OpenAI 语气'};
  await vault.update({preferences,apiKey:'fake-openai-existing',auth:{testOnlyAccount:'expert-account',testOnlyToken:'not-real'}});
  const old=JSON.parse(cipher.decrypt(await readFile(file)));delete old.doubaoApiKey;delete old.preferences.doubaoTtsVoice;delete old.preferences.doubaoTtsInstructions;
  const original=cipher.encrypt(JSON.stringify(old));await writeFile(file,original);
  const migrated=new SettingsVault(file,cipher);await migrated.load();
  expect(migrated.get()).toMatchObject({hostId:old.hostId,apiKey:'fake-openai-existing',doubaoApiKey:'',auth:old.auth,preferences:{ttsEngine:'none',mode:'chatgpt',chatModel:'expert-text',visionModel:'expert-vision',reasoningEffort:'xhigh',ttsVoice:'cedar',ttsInstructions:'原有 OpenAI 语气'}});
  expect(migrated.get().preferences.doubaoTtsVoice).toBe(defaultPreferences.doubaoTtsVoice);expect(migrated.get().preferences.doubaoTtsInstructions).toBe(defaultPreferences.doubaoTtsInstructions);
  expect(await readFile(file)).toEqual(original);
  await migrated.update({doubaoApiKey:'fake-doubao-added'});const restored=new SettingsVault(file,cipher);await restored.load();
  expect(restored.get()).toMatchObject({apiKey:'fake-openai-existing',doubaoApiKey:'fake-doubao-added',auth:old.auth,preferences:{ttsEngine:'none',mode:'chatgpt',chatModel:'expert-text',visionModel:'expert-vision',reasoningEffort:'xhigh',ttsVoice:'cedar',ttsInstructions:'原有 OpenAI 语气'}});
 }));
 it('encrypts and clears either key independently, preserving queued preference writes',async()=>temporary(async file=>{
  const vault=new SettingsVault(file,cipher);await vault.load();const hostId=vault.get().hostId;
  const pending=[vault.update({apiKey:'fake-openai-private'}),vault.update({doubaoApiKey:'fake-doubao-private'}),vault.update({preferences:{...defaultPreferences,ttsEngine:'doubao',doubaoTtsVoice:'zh_male_taocheng_uranus_bigtts'}})];await vault.flush();await Promise.all(pending);
  const bytes=await readFile(file);expect(bytes.includes(Buffer.from('fake-openai-private'))).toBe(false);expect(bytes.includes(Buffer.from('fake-doubao-private'))).toBe(false);
  await vault.update({doubaoApiKey:''});const restored=new SettingsVault(file,cipher);await restored.load();expect(restored.get()).toMatchObject({hostId,apiKey:'fake-openai-private',doubaoApiKey:'',preferences:{ttsEngine:'doubao',doubaoTtsVoice:'zh_male_taocheng_uranus_bigtts'}});
  await restored.update({doubaoApiKey:'fake-doubao-replacement'});await restored.update({apiKey:''});const final=new SettingsVault(file,cipher);await final.load();expect(final.get()).toMatchObject({apiKey:'',doubaoApiKey:'fake-doubao-replacement'});
 }));
 it('validates independent key flags, three voices and style without accepting unknown fields',()=>{
  for(const doubaoTtsVoice of ['zh_female_xiaohe_uranus_bigtts','zh_female_vv_uranus_bigtts','zh_male_taocheng_uranus_bigtts'])expect(SaveSettingsSchema.safeParse({...defaultPreferences,ttsEngine:'doubao',doubaoTtsVoice,doubaoApiKey:'fake-doubao',clearDoubaoApiKey:true}).success).toBe(true);
  for(const extra of [{doubaoApiKey:'x'.repeat(501)},{doubaoTtsVoice:'unknown'},{doubaoTtsInstructions:'x'.repeat(1001)},{doubaoToken:'not-supported'}])expect(SaveSettingsSchema.safeParse({...defaultPreferences,...extra}).success).toBe(false);
  const value=SaveSettingsSchema.parse({...defaultPreferences,clearDoubaoApiKey:true});expect(value).not.toHaveProperty('clearApiKey');expect(value).not.toHaveProperty('apiKey');
 });
 it('keeps the demo/expert configuration and sends each explicit secret only to its own server field',()=>{
  const preferences={...defaultPreferences,mode:'demo' as const,ttsEngine:'doubao' as const,chatModel:'expert-text',visionModel:'expert-vision',qwenTtsDevice:'cuda' as const,qwenTtsVoice:'vivian',ttsModel:'tts-1',ttsInstructions:'hidden old OpenAI style',doubaoTtsVoice:'zh_female_vv_uranus_bigtts',doubaoTtsInstructions:'平和朗读原文。'};
  expect(serverConfigFor(preferences,'fake-openai',4319,'fake-doubao')).toMatchObject({demoMode:true,apiKey:'fake-openai',doubaoApiKey:'fake-doubao',ttsEngine:'doubao',doubaoTtsVoice:'zh_female_vv_uranus_bigtts',doubaoTtsInstructions:'平和朗读原文。',chatModel:'expert-text',visionModel:'expert-vision',ttsInstructions:'',ttsInstructionsSupported:false});
  expect(serverConfigFor(preferences,'fake-openai',4319).doubaoApiKey).toBe('');expect(serverConfigFor(preferences,'',4319,'fake-doubao').apiKey).toBe('');
 });
 it('refuses a Doubao secret when OS encryption is unavailable without changing either stored key',async()=>temporary(async file=>{
  const vault=new SettingsVault(file,{...cipher,available:()=>false});await expect(vault.update({doubaoApiKey:'fake-private'})).rejects.toThrow('加密');expect(vault.get()).toMatchObject({apiKey:'',doubaoApiKey:''});await expect(readFile(file)).rejects.toMatchObject({code:'ENOENT'});
 }));
});


describe('active speech settings only',()=>{
 it.each(['local','qwen','system'])('rejects selecting retired %s from the current UI',ttsEngine=>{expect(SaveSettingsSchema.safeParse({...defaultPreferences,ttsEngine}).success).toBe(false);});
 it.each(['none','doubao','openai'])('allows explicit %s without selecting a fallback',ttsEngine=>{expect(SaveSettingsSchema.parse({...defaultPreferences,ttsEngine}).ttsEngine).toBe(ttsEngine);});
 it('defaults to silence even when old keys remain available',()=>{expect(defaultPreferences.ttsEngine).toBe('none');expect(serverConfigFor({...defaultPreferences},'fake-openai',4319,'fake-doubao').ttsEngine).toBe('none');});
});
