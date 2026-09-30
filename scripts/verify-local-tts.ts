import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {LocalTtsProvider} from '../apps/server/src/localTts';
const runtimePath=resolve('local-tts-runtime');
const voices=['zf_001','zf_002','zf_003','zm_010','zm_011','zm_012'];
const text='先别急，我们一步一步来看。这里的 beta 等于零点九，表示保留九成的历史信息；剩下的一成，来自这一次的观测。你可以先想一想：为什么初始化为零，会让前几步的结果偏小呢？';
const results=[];
await mkdir('docs/audio',{recursive:true});
for(const voice of voices){
 const engine=new LocalTtsProvider({runtimePath,workerPath:resolve(runtimePath,'local-tts-worker.cjs'),modelDir:resolve(runtimePath,'model'),voice,threads:2});
 try{
  if(!engine.ready())throw Error('Local voice resources missing');
  const start=performance.now();const {audio}=await engine.speak(text,1,new AbortController().signal);const elapsedMs=performance.now()-start;
  const sampleRate=audio.readUInt32LE(24);const seconds=(audio.length-44)/(sampleRate*2);
  let sum=0,peak=0;for(let i=44;i<audio.length;i+=2){const v=audio.readInt16LE(i)/32768;sum+=v*v;peak=Math.max(peak,Math.abs(v));}
  const rms=Math.sqrt(sum/((audio.length-44)/2));if(seconds<5||rms<0.001)throw Error('Empty or implausible speech');
  await writeFile('docs/audio/kokoro-'+voice+'.wav',audio);
  const warmStart=performance.now();await engine.speak('我们先看清条件，再一步一步推导。',1,new AbortController().signal);const warmMs=performance.now()-warmStart;
  results.push({voice,elapsedMs:Math.round(elapsedMs),warmShortSentenceMs:Math.round(warmMs),seconds:Math.round(seconds*100)/100,sampleRate,rms,peak});
  console.log(JSON.stringify(results.at(-1)));
  if(voice===voices[0]){
   const controller=new AbortController();const pending=engine.speak(text.repeat(8),1,controller.signal);const startCancel=performance.now();controller.abort();
   const result=await pending.then(()=>false,error=>error.code==='local_tts_cancelled');if(!result)throw Error('Cancellation did not reject');
   console.log('Real CPU worker cancellation acknowledged in '+Math.round(performance.now()-startCancel)+' ms');
   await engine.speak('停止之后，这是一句新的本地朗读。',1,new AbortController().signal);
  }
 }finally{engine.dispose();}
}
const report={date:new Date().toISOString(),engine:'Kokoro-82M-v1.1-zh / sherpa-onnx 1.13.8',provider:'cpu',threads:2,modelArchiveSHA256:(await readFile(resolve(runtimePath,'model/DOWNLOAD-SHA256.txt'),'utf8')).trim(),text,results,realModelInference:true,paidAPICalls:0,humanListening:'未验收；需用户试听自然度、停顿、读音，未声称超过OpenAI'};
await writeFile('docs/local-tts-smoke.json',JSON.stringify(report,null,2)+'\n');
