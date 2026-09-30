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


describe('free local speech settings migration',()=>{
 it('migrates legacy encrypted preferences without changing the account, key or expert model',async()=>temporary(async file=>{
  const first=new SettingsVault(file,cipher);await first.load();
  await first.update({apiKey:'fake-legacy-key',auth:{testOnly:true},preferences:{...defaultPreferences,mode:'chatgpt',chatModel:'expert-model'}});
  const original=JSON.parse(cipher.decrypt(await readFile(file)));
  delete original.preferences.ttsEngine;delete original.preferences.localTtsVoice;
  await writeFile(file,cipher.encrypt(JSON.stringify(original)));
  const migrated=new SettingsVault(file,cipher);await migrated.load();
  expect(migrated.get().preferences).toMatchObject({ttsEngine:'local',localTtsVoice:'zf_001',mode:'chatgpt',chatModel:'expert-model'});
  expect(migrated.get().apiKey).toBe('fake-legacy-key');expect(migrated.get().auth).toEqual({testOnly:true});
  expect(migrated.get().hostId).toBe(original.hostId);
 }));
});


describe('independent free speech configuration',()=>{
 it.each(['local','system'] as const)('ignores hidden cloud model style when %s is selected',engine=>{
  const config=serverConfigFor({...defaultPreferences,ttsEngine:engine,ttsModel:'tts-1',ttsInstructions:'旧的云声音风格'},'',4319);
  expect(config).toMatchObject({ttsEngine:engine,ttsInstructions:'',ttsInstructionsSupported:false});
  expect(serverConfigFor({...defaultPreferences,ttsEngine:engine,ttsModel:''},'',4319).ttsEngine).toBe(engine);
 });
});


describe('Qwen device preference migration',()=>{
 it('leaves old preferences on CPU and preserves an explicit CUDA selection',async()=>temporary(async file=>{
  const vault=new SettingsVault(file,cipher);await vault.load();
  await vault.update({apiKey:'fake-key',preferences:{...defaultPreferences,ttsEngine:'qwen',qwenTtsDevice:'cuda',chatModel:'expert-model'}});
  const restored=new SettingsVault(file,cipher);await restored.load();expect(restored.get().preferences.qwenTtsDevice).toBe('cuda');
  const legacy=JSON.parse(cipher.decrypt(await readFile(file)));delete legacy.preferences.qwenTtsDevice;await writeFile(file,cipher.encrypt(JSON.stringify(legacy)));
  const migrated=new SettingsVault(file,cipher);await migrated.load();expect(migrated.get().preferences.qwenTtsDevice).toBe('cpu');expect(migrated.get().preferences.chatModel).toBe('expert-model');expect(migrated.get().apiKey).toBe('fake-key');
 }));
 it('passes only a validated CPU/CUDA choice into the local service configuration',()=>{
  expect(serverConfigFor({...defaultPreferences,ttsEngine:'qwen',qwenTtsDevice:'cuda'},'',4319).qwenTtsDevice).toBe('cuda');
  expect(SaveSettingsSchema.safeParse({...defaultPreferences,qwenTtsDevice:'auto'}).success).toBe(false);
 });
});
