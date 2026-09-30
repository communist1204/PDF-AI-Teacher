/* global performance, AbortController, clearTimeout */
import {QwenTtsProvider,validateQwenWave} from '../apps/server/src/qwenTts.ts';
import {splitSentences} from '../apps/web/src/features/voice/sentences.ts';
import {DEFAULT_QWEN_TTS_INSTRUCTIONS} from '../packages/shared/localSpeech.ts';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const device=process.argv.includes('--cuda')?'cuda':'cpu';
const output=resolve('test-results/qwen-samples-'+device);await mkdir(output,{recursive:true});
const source='2026年，我们一起阅读这本书，\n先理解概念，再看一个例子。';
const chunks=splitSentences(source);assert.equal(chunks.length,1);assert.equal(chunks[0].sourceText,source);assert.equal(chunks[0].speechText,'二零二六年，我们一起阅读这本书，先理解概念，再看一个例子。');
const results=[];
for(const voice of ['serena','vivian','uncle_fu']){
 const p=new QwenTtsProvider({runtimePath:'qwen-tts-runtime',workPath:'.model-cache/qwen-jobs',voice,instructions:DEFAULT_QWEN_TTS_INSTRUCTIONS,device});assert(p.ready());
 const start=performance.now();
 try{const {audio}=await p.speak(chunks[0].speechText,1,new AbortController().signal);assert(validateQwenWave(audio));let peak=0,sum=0;for(let i=44;i<audio.length;i+=2){const n=audio.readInt16LE(i)/32768;peak=Math.max(peak,Math.abs(n));sum+=n*n;}assert(peak>0.01);const row={voice,elapsedSeconds:+((performance.now()-start)/1000).toFixed(2),audioSeconds:(audio.length-44)/48000,peak,rms:Math.sqrt(sum/((audio.length-44)/2)),file:'test-results/qwen-samples-'+device+'/'+voice+'.wav'};await writeFile(row.file,audio);results.push(row);console.log(JSON.stringify(row));}finally{p.dispose();}
}
const p=new QwenTtsProvider({runtimePath:'qwen-tts-runtime',workPath:'.model-cache/qwen-cancel-smoke',voice:'serena',instructions:DEFAULT_QWEN_TTS_INSTRUCTIONS});
const controller=new AbortController();const pending=p.speak(chunks[0].speechText,1,controller.signal);const timer=setTimeout(()=>controller.abort(),1500);
const start=performance.now();try{await assert.rejects(pending,e=>e.code==='qwen_tts_cancelled');}finally{clearTimeout(timer);p.dispose();}
const leftovers=await readdir('.model-cache/qwen-cancel-smoke');assert.equal(leftovers.length,0);
const report={date:new Date().toISOString(),model:'Qwen3-TTS-1.7B-CustomVoice-Q4_K_M',cpuOnly:device==='cpu',device,threads:2,seed:42,source,speech:chunks[0].speechText,results,cancelSeconds:+((performance.now()-start)/1000).toFixed(2),cancelCleansTemporaryAudio:true,humanListening:'未验收；WAV与播放检查不代表听感、读音或忠实度已获真人认可',paidApiTested:false};
await writeFile(device==='cuda'?'docs/qwen-gpu-voices-smoke.json':'docs/qwen-tts-smoke.json',JSON.stringify(report,null,2)+'\n');console.log('Real Qwen '+device+' generation and cancellation verified.');
