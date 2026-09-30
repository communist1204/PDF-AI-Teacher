import {mkdir,stat,readFile,writeFile,cp,rename} from 'node:fs/promises';
import {createReadStream,openSync,writeSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {resolve,sep} from 'node:path';
const root=process.cwd();
const cache=resolve(root,'.model-cache');
const runtime=resolve(root,'local-tts-runtime');
const modelDir=resolve(runtime,'model');
const size=364816464;
const sha256='a3f4c73d043860e3fd2e5b06f36795eb81de0fc8e8de6df703245edddd87dbad';
const url='https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2';
const archive=resolve(cache,'kokoro-multi-lang-v1_1.tar.bz2');
async function hash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
async function exists(file){return stat(file).then(()=>true,()=>false);}
function run(program,args){return new Promise((done,reject)=>{const child=spawn(program,args,{windowsHide:true,stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',chunk=>{error=(error+chunk).slice(-1500);});child.on('error',reject);child.on('exit',code=>code===0?done():reject(Error('Public model download/extraction failed: '+code+' '+error)));});}
await mkdir(cache,{recursive:true});await mkdir(runtime,{recursive:true});
const marker=resolve(modelDir,'DOWNLOAD-SHA256.txt');
if(!(await exists(marker)) || (await readFile(marker,'utf8')).trim()!==sha256 || !(await exists(resolve(modelDir,'model.onnx')))){
 if(!(await exists(archive)) || (await stat(archive)).size!==size || await hash(archive)!==sha256){
  const count=10;const stride=Math.ceil(size/count);
  console.log('Downloading official free Chinese voice pack, 365 MB; no API credentials or text upload.');
  await Promise.all(Array.from({length:count},async(_,i)=>{
   const start=i*stride,end=Math.min(size-1,start+stride-1),part=resolve(cache,'kokoro-part-'+i);
   for(let attempt=0;attempt<8;attempt++){
    const have=await exists(part)?(await stat(part)).size:0;
    if(have===end-start+1)break;
    if(have>end-start+1)throw Error('Unexpected download part size');
    const next=part+'.next', headers=part+'.headers';
    await writeFile(next,'');await writeFile(headers,'');
    await run('curl.exe',['--fail','--silent','--show-error','--location','--connect-timeout','15','--max-time','90','--range',(start+have)+'-'+end,'--dump-header',headers,'--output',next,url]).catch(()=>{});
    const response=await readFile(headers,'utf8');
    const ranges=[...response.matchAll(/content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+)/gi)];
    const range=ranges.at(-1);const received=(await stat(next)).size;
    if(!range || Number(range[1])!==start+have || Number(range[3])!==size || received>end-start+1-have)continue;
    const append=openSync(part,'a');try{for await(const chunk of createReadStream(next))writeSync(append,chunk);}finally{closeSync(append);}
   }
   if((await stat(part)).size!==end-start+1)throw Error('Range length mismatch for part '+i);
   console.log('Voice download part '+(i+1)+'/'+count+' ready');
  }));
  const output=openSync(archive,'w');
  try{for(let i=0;i<count;i++)for await(const chunk of createReadStream(resolve(cache,'kokoro-part-'+i)))writeSync(output,chunk);}finally{closeSync(output);}
  if(await hash(archive)!==sha256)throw Error('Voice package SHA256 mismatch; not extracted.');
 }
 const entries=execFileSync('tar.exe',['-tf',archive],{encoding:'utf8',maxBuffer:8*1024*1024}).trim().split(/\r?\n/);
 for(const entry of entries){const target=resolve(runtime,entry);if(!target.startsWith(runtime+sep)||entry.includes('..')||!entry.startsWith('kokoro-multi-lang-v1_1/'))throw Error('Unsafe archive entry');}
 if(await exists(modelDir))throw Error('Existing model directory is incomplete; preserved for review.');
 await run('tar.exe',['-xf',archive,'-C',runtime]);
 await rename(resolve(runtime,'kokoro-multi-lang-v1_1'),modelDir);
 await writeFile(marker,sha256+'\n');
}
await mkdir(resolve(runtime,'node_modules'),{recursive:true});
for(const name of ['sherpa-onnx-node','sherpa-onnx-win-x64'])await cp(resolve(root,'node_modules',name),resolve(runtime,'node_modules',name),{recursive:true});
if(await exists(resolve(root,'scripts/local-tts-worker.cjs')))await cp(resolve(root,'scripts/local-tts-worker.cjs'),resolve(runtime,'local-tts-worker.cjs'));
if(await exists(resolve(root,'assets/third-party-tts')))await cp(resolve(root,'assets/third-party-tts'),resolve(runtime,'licenses'),{recursive:true});
console.log('Free local speech runtime prepared at '+runtime);
