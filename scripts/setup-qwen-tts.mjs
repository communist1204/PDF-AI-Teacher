import {mkdir,stat,readFile,writeFile} from 'node:fs/promises';
import {createReadStream,openSync,writeSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
const root=process.cwd();
const modelDir=resolve(root,'qwen-tts-runtime/model');const cache=resolve(root,'.model-cache/qwen3-tts');
const revision='b7ee2e8c7459c3bea99da23e3d178125a7d1713c';
const assets=[
 {name:'qwen-talker-1.7b-customvoice-Q4_K_M.gguf',size:1182631296,sha:'cc328834a631bc08bf9f43e62fa23f8a1383d9b429864ce6690cfb172077fc4a'},
 {name:'qwen-tokenizer-12hz-Q8_0.gguf',size:291150624,sha:'1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94'}
];
async function exists(path){return stat(path).then(()=>true,()=>false);}
async function hash(path){const h=createHash('sha256');for await(const part of createReadStream(path))h.update(part);return h.digest('hex');}
function run(args){return new Promise((done,reject)=>{const child=spawn('powershell.exe',args,{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('exit',code=>code===0?done():reject(Error('Download attempt incomplete')));});}
await mkdir(cache,{recursive:true});await mkdir(modelDir,{recursive:true});
for(const asset of assets){
 const target=resolve(modelDir,asset.name);
 if(await exists(target)&&(await stat(target)).size===asset.size&&await hash(target)===asset.sha){console.log(asset.name+' verified (already installed)');continue;}
 console.log('Downloading '+asset.name+' ('+Math.round(asset.size/1e6)+' MB), public fixed revision; no credentials.');
 const count=12,stride=Math.ceil(asset.size/count);
 await Promise.all(Array.from({length:count},async(_,i)=>{
  const start=i*stride,end=Math.min(asset.size-1,start+stride-1),part=resolve(cache,asset.name+'.part-'+i);
  for(let attempt=0;attempt<12;attempt++){
   const have=await exists(part)?(await stat(part)).size:0;if(have===end-start+1)return;
   if(have>end-start+1)throw Error('Invalid cached range length');
   const next=part+'.next',headers=part+'.headers';await writeFile(next,'');await writeFile(headers,'');
   await run(['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve(root,'scripts/download-qwen-range.ps1'),'-Url','https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/resolve/'+revision+'/'+asset.name,'-Start',String(start+have),'-End',String(end),'-OutputPath',next,'-HeaderPath',headers]).catch(()=>{});
   const response=await readFile(headers,'utf8');const range=[...response.matchAll(/content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+)/gi)].at(-1);const received=(await stat(next)).size;
   if(!range||Number(range[1])!==start+have||Number(range[3])!==asset.size||received>end-start+1-have)continue;
   const file=openSync(part,'a');try{for await(const chunk of createReadStream(next))writeSync(file,chunk);}finally{closeSync(file);}
   if((await stat(part)).size===end-start+1){console.log(asset.name+' part '+(i+1)+'/'+count+' ready');return;}
  }
  throw Error('Download incomplete for part '+i+'; cached verified ranges retained.');
 }));
 const file=openSync(target,'w');try{for(let i=0;i<count;i++)for await(const chunk of createReadStream(resolve(cache,asset.name+'.part-'+i)))writeSync(file,chunk);}finally{closeSync(file);}
 if((await stat(target)).size!==asset.size||await hash(target)!==asset.sha)throw Error('Model SHA256 mismatch; do not load.');
 console.log(asset.name+' SHA256 verified.');
}
await writeFile(resolve(modelDir,'manifest.json'),JSON.stringify({repository:'Serveurperso/Qwen3-TTS-GGUF',revision,assets},null,2)+'\n');
console.log('Qwen3 model files verified. Build the CPU runtime with scripts/build-qwen-tts.mjs before use.');
