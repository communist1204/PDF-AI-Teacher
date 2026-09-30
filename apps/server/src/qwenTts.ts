import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { HttpError } from './errors';

export const QWEN_TALKER = 'qwen-talker-1.7b-customvoice-Q4_K_M.gguf';
export const QWEN_CODEC = 'qwen-tokenizer-12hz-Q8_0.gguf';
const LIMIT_MARKER = 'PDF_AI_TTS_FRAME_LIMIT_REACHED';
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const cancelled = () => new HttpError(409, 'qwen_tts_cancelled', 'Qwen3 本地朗读已停止，未产生 API 费用。');
const failed = (device?: 'cpu' | 'cuda') => new HttpError(503, 'qwen_tts_failed', device==='cuda'?'Qwen3 GPU 语音生成失败。可在声音设置改用 CPU 或轻量本地声音；没有自动切换设备或调用付费服务。':'Qwen3 本地语音未能完成生成，请重试短句；没有切换到其他语音服务。');
export interface QwenTtsOptions { runtimePath: string; workPath: string; voice: string; instructions: string; threads?: 2 | 4; device?: 'cpu' | 'cuda'; }
function fileExists(path: string, size = 1) { try { const s = statSync(path); return s.isFile() && s.size >= size; } catch { return false; } }
export function qwenCudaRuntimeReady(runtimePath: string): boolean {
 return ['qwen-tts.exe','cublas64_12.dll','cublasLt64_12.dll','manifest.json'].every(name=>fileExists(join(runtimePath,'bin-cuda',name)));
}
function environment(threads: 2 | 4, device: 'cpu' | 'cuda'): NodeJS.ProcessEnv {
 const result: NodeJS.ProcessEnv = {};
 for (const [key, value] of Object.entries(process.env)) if (['systemroot','windir','temp','tmp'].includes(key.toLowerCase())) result[key] = value;
 // Per-process selection only; never change system CUDA/PATH or inherit API secrets.
 result.GGML_BACKEND = device === 'cuda' ? 'CUDA0' : 'CPU'; result.PDF_AI_TTS_THREADS = String(threads);
 return result;
}
export function validateQwenWave(audio: Buffer): boolean {
 return audio.length >= 46 && audio.length <= MAX_AUDIO_BYTES && audio.toString('ascii',0,4)==='RIFF' && audio.toString('ascii',8,12)==='WAVE'
  && audio.toString('ascii',12,16)==='fmt ' && audio.readUInt32LE(16)===16 && audio.readUInt16LE(20)===1 && audio.readUInt16LE(22)===1
  && audio.readUInt32LE(24)===24000 && audio.readUInt32LE(28)===48000 && audio.readUInt16LE(32)===2 && audio.readUInt16LE(34)===16
  && audio.toString('ascii',36,40)==='data' && audio.readUInt32LE(40)===audio.length-44 && audio.readUInt32LE(4)===audio.length-8 && (audio.length-44)%2===0;
}
/** Explicit CPU or CUDA child. Text enters stdin, never a shell/command line; temporary audio is deleted. */
export class QwenTtsProvider {
 private readonly options: QwenTtsOptions;
 private current?: { cancel: () => void };
 private disposed = false;
 constructor(options: QwenTtsOptions) {
  if (!['serena','vivian','uncle_fu'].includes(options.voice)) throw new HttpError(400,'qwen_tts_voice','请选择列表中的 Qwen3 中文音色。');
  if (options.instructions.length > 1000 || options.instructions.includes('\0')) throw new HttpError(400,'qwen_tts_style','Qwen3 朗读语气请限制在 1000 字以内。');
  if (options.threads !== undefined && options.threads !== 2 && options.threads !== 4) throw new HttpError(400,'qwen_tts_threads','Qwen3 CPU 线程数只允许 2 或 4。');
  if(options.device && !['cpu','cuda'].includes(options.device))throw new HttpError(400,'qwen_tts_device','请选择 CPU 或 NVIDIA GPU。');
  this.options = {...options,runtimePath:resolve(options.runtimePath),workPath:resolve(options.workPath)};
 }
 private executableDirectory(){return join(this.options.runtimePath,this.options.device==='cuda'?'bin-cuda':'bin');}
 ready() {
  const p=this.options.runtimePath;
  return !this.disposed && fileExists(join(this.executableDirectory(),'qwen-tts.exe')) && (this.options.device!=='cuda'||qwenCudaRuntimeReady(p))
   && fileExists(join(p,'model',QWEN_TALKER),1182631296) && fileExists(join(p,'model',QWEN_CODEC),291150624)
   && fileExists(join(p,'model','manifest.json'));
 }
 async speak(text: string, speed: number, signal: AbortSignal): Promise<{audio:Buffer}> {
  if (this.disposed) throw new HttpError(503,'qwen_tts_closed','Qwen3 本地语音已关闭，请重新打开软件。');
  if (!text.trim() || text.length>6000 || text.includes('\0')) throw new HttpError(400,'qwen_tts_text','请选择不超过 6000 字的有效朗读文字。');
  if (!Number.isFinite(speed)||speed<0.25||speed>2) throw new HttpError(400,'qwen_tts_speed','朗读速度应为 0.25 到 2 倍。');
  if (signal.aborted) throw cancelled();
  if (this.current) throw new HttpError(409,'qwen_tts_busy','Qwen3 正在生成上一句，请等待或先停止。');
  if (!this.ready()) throw new HttpError(503,'qwen_tts_missing','Qwen3 语音资源尚未安装完整，请检查声音设置；没有调用付费 API。');
  let interrupted=false;
  const job={cancel:()=>{interrupted=true;}};this.current=job;
  let directory: string|undefined;
  try {
   await mkdir(this.options.workPath,{recursive:true});directory=await mkdtemp(join(this.options.workPath,'speech-'));
   if (signal.aborted||interrupted) throw cancelled();
   const output=join(directory,'speech.wav');
   await new Promise<void>((done,reject)=>{
    let child: ChildProcessWithoutNullStreams;
    let settled=false,diagnostic='',hitLimit=false;
    let stopTimer:ReturnType<typeof setTimeout>|undefined, terminationError:Error|undefined;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(stopTimer);signal.removeEventListener('abort',abort);if(error)reject(error);else done();};
    const stop=(error:Error)=>{if(settled||terminationError)return;terminationError=error;if(!child)return finish(error);child.kill();stopTimer=setTimeout(()=>finish(error),5000);stopTimer.unref();};
    const abort=()=>{interrupted=true;stop(cancelled());};
    job.cancel=abort;
    const timer=setTimeout(()=>{stop(new HttpError(504,'qwen_tts_timeout','Qwen3 在本机生成时间过长，已停止。请缩短选段，或切换轻量本地声音。'));},300000);timer.unref();
    try {
     child=spawn(join(this.executableDirectory(),'qwen-tts.exe'),[
      '--model',join(this.options.runtimePath,'model',QWEN_TALKER),'--codec',join(this.options.runtimePath,'model',QWEN_CODEC),
      '--speaker',this.options.voice,'--lang','Chinese','--instruct',this.options.instructions,
      '--max-new','1800','--seed','42','-o',output,
     ],{cwd:this.executableDirectory(),env:environment(this.options.threads ?? 2,this.options.device ?? 'cpu'),windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
     child.stdout.resume();child.stderr.on('data',(data:Buffer)=>{diagnostic+=data.toString('utf8');hitLimit ||= diagnostic.includes(LIMIT_MARKER);diagnostic=diagnostic.slice(-LIMIT_MARKER.length);});
     child.once('error',()=>finish(failed(this.options.device)));child.stdin.on('error',()=>stop(failed(this.options.device)));
     child.once('close',code=>{
      if(terminationError)return finish(terminationError);
      if(signal.aborted||interrupted)return finish(cancelled());
      if(hitLimit)return finish(new HttpError(422,'qwen_tts_truncated','这段语音达到生成上限，未把截断音频当成读完。请缩短选段后重试。'));
      finish(code===0?undefined:failed(this.options.device));
     });
     signal.addEventListener('abort',abort,{once:true});if(signal.aborted||interrupted){abort();return;}
     child.stdin.end(text,'utf8');
    } catch { finish(failed(this.options.device)); }
   });
   if (signal.aborted||interrupted||this.disposed) throw cancelled();
   const size=(await stat(output)).size;if(size>MAX_AUDIO_BYTES||size<46)throw failed(this.options.device);
   const audio=await readFile(output);if(!validateQwenWave(audio))throw failed(this.options.device);
   if(signal.aborted||interrupted||this.disposed)throw cancelled();
   return {audio};
  } catch (error) { if (error instanceof HttpError) throw error; throw failed(this.options.device); }
  finally {
   if(this.current===job)this.current=undefined;
   // This path comes only from our own mkdtemp under the fixed work directory.
   if(directory&&resolve(directory).startsWith(this.options.workPath+sep)) await rm(directory,{recursive:true,force:true}).catch(()=>{});
  }
 }
 dispose(){this.disposed=true;this.current?.cancel();}
}
