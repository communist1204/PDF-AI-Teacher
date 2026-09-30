// Native worker errors must never expose paths, environment or source text.
import { fork, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors';

export const LOCAL_TTS_VOICES = Object.freeze({ zf_001: 3, zf_002: 4, zf_003: 5, zm_010: 59, zm_011: 60, zm_012: 61 });
export interface LocalTtsOptions {
  workerPath: string;
  runtimePath: string;
  modelDir: string;
  voice: string;
  threads?: number;
  executablePath?: string;
}
type Pending = {
  id: string; text: string; sent: boolean; signal: AbortSignal;
  resolve: (value: { audio: Buffer; requestId?: string }) => void;
  reject: (error: HttpError) => void;
  abort: () => void; timer: ReturnType<typeof setTimeout>;
};
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const cancelled = () => new HttpError(409, 'local_tts_cancelled', '本地朗读已取消，旧声音不会继续播放。');
const failed = () => new HttpError(503, 'local_tts_failed', '本地语音引擎未能完成合成。请重试短句；若仍失败，请检查本地语音资源是否完整。');

function isFile(path: string) { try { const value = statSync(path); return value.isFile() && value.size > 0; } catch { return false; } }
function isDirectory(path: string) { try { return statSync(path).isDirectory(); } catch { return false; } }
function childEnvironment(runtimePath: string): NodeJS.ProcessEnv {
  // Local inference needs no API credentials or inherited Node/Electron debugging flags.
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set(['systemroot', 'windir', 'temp', 'tmp', 'pathext', 'lang', 'lc_all']);
  for (const [name, value] of Object.entries(process.env)) if (allowed.has(name.toLowerCase()) && value !== undefined) env[name] = value;
  const inheritedPath = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'path')?.[1];
  env.PATH = [join(runtimePath, 'node_modules', 'sherpa-onnx-win-x64'), inheritedPath].filter(Boolean).join(delimiter);
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}
function isPcmWave(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && value.length >= 46 && value.length <= MAX_AUDIO_BYTES
    && value.toString('ascii', 0, 4) === 'RIFF' && value.toString('ascii', 8, 12) === 'WAVE'
    && value.toString('ascii', 12, 16) === 'fmt ' && value.readUInt32LE(16) === 16
    && value.readUInt16LE(20) === 1 && value.readUInt16LE(22) === 1
    && value.readUInt32LE(24) >= 8000 && value.readUInt32LE(24) <= 96000
    && value.readUInt16LE(34) === 16 && value.toString('ascii', 36, 40) === 'data'
    && value.readUInt32LE(40) === value.length - 44 && (value.length - 44) % 2 === 0
    && value.readUInt32LE(4) === value.length - 8;
}

/** A single persistent CPU worker; only the process created by this instance is ever stopped. */
export class LocalTtsProvider {
  private readonly options: Required<LocalTtsOptions>;
  private child?: ChildProcess;
  private workerReady = false;
  private pending?: Pending;
  private disposed = false;

  constructor(options: LocalTtsOptions) {
    if (!Object.hasOwn(LOCAL_TTS_VOICES, options.voice)) throw new HttpError(400, 'local_tts_voice', '请选择本地语音列表中的音色。');
    const threads = options.threads ?? 2;
    if (!Number.isInteger(threads) || threads < 1 || threads > 8) throw new HttpError(400, 'local_tts_threads', '本地语音 CPU 线程数应为 1 到 8 的整数。');
    this.options = { ...options, workerPath: resolve(options.workerPath), runtimePath: resolve(options.runtimePath), modelDir: resolve(options.modelDir), threads, executablePath: options.executablePath ?? process.execPath };
  }

  /** Resource presence only: this does not claim model load or human listening has passed. */
  ready(): boolean {
    const { workerPath, runtimePath, modelDir } = this.options;
    const native = join(runtimePath, 'node_modules', 'sherpa-onnx-win-x64');
    return !this.disposed && isFile(workerPath)
      && ['package.json', 'sherpa-onnx.js', 'addon.js'].every(file => isFile(join(runtimePath, 'node_modules', 'sherpa-onnx-node', file)))
      && ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'onnxruntime.dll'].every(file => isFile(join(native, file)))
      && ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-zh.txt'].every(file => isFile(join(modelDir, file)))
      && isDirectory(join(modelDir, 'espeak-ng-data'));
  }

  speak(text: string, speed: number, signal: AbortSignal): Promise<{ audio: Buffer; requestId?: string }> {
    if (this.disposed) return Promise.reject(new HttpError(503, 'local_tts_closed', '本地语音引擎已关闭，请重新打开软件。'));
    if (typeof text !== 'string' || !text.trim() || text.length > 6000) return Promise.reject(new HttpError(400, 'local_tts_text', '请选择 1 到 6000 字的有效文字进行本地朗读。'));
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 2) return Promise.reject(new HttpError(400, 'local_tts_speed', '朗读速度应在 0.25 到 2 倍之间。'));
    if (signal.aborted) return Promise.reject(cancelled());
    if (this.pending) return Promise.reject(new HttpError(409, 'local_tts_busy', '上一段本地语音仍在生成，请先停止或等待完成。'));
    if (!this.ready()) return Promise.reject(new HttpError(503, 'local_tts_missing', '本地语音资源尚未准备完整，请在设置中检查本地声音安装状态。'));
    return new Promise((resolveResult, reject) => {
      const id = randomUUID();
      const abort = () => this.fail(cancelled());
      const timer = setTimeout(() => this.fail(new HttpError(504, 'local_tts_timeout', '本地语音生成超时，已停止这次任务。请缩短文字后重试。')), 120000);
      timer.unref();
      this.pending = { id, text, sent: false, signal, resolve: resolveResult, reject, abort, timer };
      signal.addEventListener('abort', abort, { once: true });
      if (!this.child) this.startWorker();
      else this.sendPending();
    });
  }

  private startWorker() {
    const { workerPath, runtimePath, modelDir, voice, threads, executablePath } = this.options;
    let child: ChildProcess;
    try {
      child = fork(workerPath, [runtimePath, modelDir, voice, String(threads)], {
        execPath: executablePath, execArgv: [], windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
        env: childEnvironment(runtimePath),
      });
    } catch { this.fail(failed()); return; }
    this.child = child; this.workerReady = false;
    child.on('error', () => { if (this.child === child) this.fail(failed()); });
    child.on('exit', () => { if (this.child === child) this.fail(failed()); });
    child.on('message', (message: unknown) => {
      if (this.child !== child || !message || typeof message !== 'object') return;
      const data = message as Record<string, unknown>;
      if (data.type === 'ready') { this.workerReady = true; this.sendPending(); return; }
      if (data.type === 'error' && (data.id === undefined || data.id === this.pending?.id)) { this.fail(failed()); return; }
      const pending = this.pending;
      if (data.type !== 'audio' || !pending || data.id !== pending.id || !pending.sent) return;
      if (!isPcmWave(data.audio)) { this.fail(failed()); return; }
      this.clearPending();
      pending.resolve({ audio: data.audio });
    });
  }

  private sendPending() {
    const child = this.child; const pending = this.pending;
    if (!child || !this.workerReady || !pending || pending.sent) return;
    pending.sent = true;
    // Generate at 1x. HTMLMediaElement.playbackRate alone applies the requested speed.
    try { child.send({ type: 'speak', id: pending.id, text: pending.text }, error => { if (error && this.child === child && this.pending === pending) this.fail(failed()); }); }
    catch { this.fail(failed()); }
  }
  private clearPending() {
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.signal.removeEventListener('abort', pending.abort); }
    return pending;
  }
  private stopWorker() {
    const child = this.child; this.child = undefined; this.workerReady = false;
    if (child) { try { child.kill(); } catch { /* Only this owned worker is affected. */ } }
  }
  private fail(error: HttpError) { const pending = this.clearPending(); this.stopWorker(); pending?.reject(error); }
  dispose() { this.disposed = true; this.fail(new HttpError(503, 'local_tts_closed', '本地语音引擎已关闭，当前声音任务已停止。')); }
}
