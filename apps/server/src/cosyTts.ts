import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { COSY_TTS_MODEL, DEFAULT_COSY_TTS_VOICE, isCosyVoice, type CosySpeechStatus, type CosyVoiceId } from '../../../packages/shared/cosySpeech';
import { HttpError } from './errors';

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_CHARS = 3 * 1024 * 1024;
export type CosyTtsResult = { audio: Buffer; metrics?: { firstPcmMs: number; totalMs: number; audioSeconds: number } };
export type CosyTtsOptions = { runtimeDir?: string; workerPath?: string; startupTimeoutMs?: number; requestTimeoutMs?: number; spawn?: typeof spawn; exists?: typeof existsSync };
type Pending = { chunks: Buffer[]; bytes: number; onAudio?: (audio: Buffer) => void; resolve: (result: CosyTtsResult) => void; reject: (error: Error) => void; clean: () => void };
const cancelled = () => new HttpError(409, 'cosy_cancelled', '已取消本地 CosyVoice 朗读。');
const failed = () => new HttpError(503, 'cosy_worker_failed', 'CosyVoice 本地进程未完成合成，请检查本项目语音环境后重试；没有切换到 CPU 或云服务。');
function workerError(code: unknown): HttpError {
  if (code === 'voice_unavailable') return new HttpError(503, 'cosy_voice_unavailable', '当前 CosyVoice 音色参考文件未安装完整，请重新安装本项目音色包或选择其他音色。');
  if (typeof code === 'string' && /cuda|gpu|memory/i.test(code)) return new HttpError(503, 'cosy_gpu_unavailable', 'CosyVoice 无法使用本机显卡或显存不足，请关闭不需要的本软件朗读任务后重试；没有切换到 CPU。');
  if (code === 'cancelled') return cancelled();
  return failed();
}

/** One warm, project-owned Python worker. Stdio is private; no network or credentials. */
export class CosyTtsProvider {
  private readonly runtimeDir: string;
  private readonly workerPath: string;
  private child?: ChildProcessWithoutNullStreams;
  private state: CosySpeechStatus = 'idle';
  private disposed = false;
  private starting?: Promise<void>;
  private startupResolve?: () => void;
  private startupReject?: (error: Error) => void;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, Pending>();
  private input = '';

  constructor(private readonly options: CosyTtsOptions = {}) {
    this.runtimeDir = resolve(options.runtimeDir || 'cosy-tts-runtime');
    this.workerPath = resolve(options.workerPath || 'scripts/cosy-tts-worker.py');
  }
  ready(): boolean {
    const exists = this.options.exists ?? existsSync;
    return !this.disposed && [resolve(this.runtimeDir, 'venv/Scripts/python.exe'), resolve(this.runtimeDir, 'repo/cosyvoice'), resolve(this.runtimeDir, 'models', COSY_TTS_MODEL, 'cosyvoice3.yaml'), this.workerPath].every(path => exists(path));
  }
  status(): CosySpeechStatus { return this.disposed ? 'stopped' : !this.ready() ? 'missing' : this.state; }
  private write(frame: object): void {
    if (!this.child?.stdin.writable) throw failed();
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }
  private fail(error: Error, child = this.child): void {
    if (child && child !== this.child) return;
    clearTimeout(this.startupTimer);
    this.startupReject?.(error); this.startupResolve = undefined; this.startupReject = undefined;
    for (const request of this.pending.values()) { request.clean(); request.reject(error); }
    this.pending.clear(); this.starting = undefined; this.child = undefined; this.input = '';
    this.state = this.disposed ? 'stopped' : 'error';
    // Only the exact process spawned by this provider is terminated.
    if (child && !child.killed) child.kill();
  }
  private frame(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failed();
    const frame = value as Record<string, unknown>;
    if (frame.type === 'ready') {
      if (frame.device !== 'cuda' || frame.sampleRate !== 24000) throw workerError('gpu');
      this.state = 'ready'; clearTimeout(this.startupTimer);
      this.startupResolve?.(); this.startupResolve = undefined; this.startupReject = undefined;
      return;
    }
    if (frame.type === 'error' && !frame.id) { this.fail(workerError(frame.code)); return; }
    if (typeof frame.id !== 'string') throw failed();
    const pending = this.pending.get(frame.id);
    // A cancelled or completed request cannot write audio into a newer request.
    if (!pending) return;
    if (frame.type === 'error') {
      this.pending.delete(frame.id); pending.clean(); pending.reject(workerError(frame.code)); return;
    }
    if (frame.type === 'audio') {
      if (typeof frame.data !== 'string' || !frame.data.length || frame.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) throw failed();
      const audio = Buffer.from(frame.data, 'base64');
      if (audio.toString('base64') !== frame.data || (pending.bytes += audio.length) > MAX_AUDIO_BYTES) throw failed();
      pending.chunks.push(audio); pending.onAudio?.(audio); return;
    }
    if (frame.type === 'done') {
      this.pending.delete(frame.id); pending.clean();
      if (!pending.bytes) { pending.reject(failed()); return; }
      const raw = frame.metrics as Record<string, unknown> | undefined;
      const metrics = raw && ['firstPcmMs', 'totalMs', 'audioSeconds'].every(key => typeof raw[key] === 'number' && Number.isFinite(raw[key]) && (raw[key] as number) >= 0) ? raw as CosyTtsResult['metrics'] : undefined;
      pending.resolve({ audio: Buffer.concat(pending.chunks, pending.bytes), ...(metrics ? { metrics } : {}) }); return;
    }
    throw failed();
  }
  private start(): Promise<void> {
    if (this.disposed) return Promise.reject(failed());
    if (this.starting) return this.starting;
    if (!this.ready()) return Promise.reject(new HttpError(503, 'cosy_not_installed', 'CosyVoice 3 本地语音环境未安装完整。请先完成本项目的 CosyVoice 安装；没有请求云语音。'));
    this.state = 'loading';
    this.starting = new Promise<void>((resolveReady, reject) => {
      this.startupResolve = resolveReady; this.startupReject = reject;
      try {
        const child = (this.options.spawn ?? spawn)(resolve(this.runtimeDir, 'venv/Scripts/python.exe'), ['-u', this.workerPath, '--runtime-dir', this.runtimeDir], { cwd: this.runtimeDir, windowsHide: true, stdio: 'pipe', env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|systemroot|windir|temp|tmp|comspec|pathext|userprofile)$/i.test(name))), HF_HOME: resolve(this.runtimeDir, 'cache'), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
        this.child = child;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (data: string) => {
          if (this.child !== child) return;
          try {
            this.input += data;
            if (this.input.length > MAX_FRAME_CHARS) throw failed();
            let newline: number;
            while ((newline = this.input.indexOf('\n')) >= 0) {
              const line = this.input.slice(0, newline); this.input = this.input.slice(newline + 1);
              if (line.trim()) this.frame(JSON.parse(line));
              if (this.child !== child) return;
            }
          } catch (error) { this.fail(error instanceof HttpError ? error : failed(), child); }
        });
        // Drain diagnostics but never log them: upstream libraries may echo input text.
        child.stderr.on('data', () => {});
        child.stdin.on('error', () => this.fail(failed(), child));
        child.on('error', () => this.fail(failed(), child));
        child.on('exit', () => this.fail(failed(), child));
        this.startupTimer = setTimeout(() => this.fail(new HttpError(504, 'cosy_startup_timeout', 'CosyVoice 首次加载超时，请检查本项目模型安装与显卡状态后重试。'), child), this.options.startupTimeoutMs ?? 180000);
        this.startupTimer.unref();
      } catch { this.fail(failed()); }
    });
    const loading = this.starting;
    void loading.catch(() => { if (this.starting === loading) this.starting = undefined; });
    return loading;
  }
  async speak(text: string, _speed: number, signal: AbortSignal, onAudio?: (audio: Buffer) => void, voice: CosyVoiceId = DEFAULT_COSY_TTS_VOICE): Promise<CosyTtsResult> {
    if (!isCosyVoice(voice)) throw new HttpError(400, 'cosy_voice', '请选择列表中的 CosyVoice 音色。');
    if (!text.trim() || text.length > 1600 || text.includes('\0')) throw new HttpError(400, 'cosy_text', '请选择不超过 1600 字的有效朗读文字。');
    if (signal.aborted) throw cancelled();
    const start = this.start();
    await new Promise<void>((resolveReady, reject) => {
      const abort = () => reject(cancelled());
      signal.addEventListener('abort', abort, { once: true });
      start.then(resolveReady, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
    if (signal.aborted) throw cancelled();
    if (this.pending.size >= 4) throw new HttpError(429, 'cosy_busy', '本地语音等待队列已满，请先停止其他朗读。');
    const id = randomUUID();
    return new Promise<CosyTtsResult>((resolveResult, reject) => {
      const abort = () => {
        const request = this.pending.get(id); if (!request) return;
        this.pending.delete(id); request.clean(); reject(cancelled());
        try { this.write({ type: 'cancel', id }); } catch { /* Late worker shutdown is already cancelled. */ }
      };
      const timer = setTimeout(() => {
        const request = this.pending.get(id); if (!request) return;
        this.pending.delete(id); request.clean(); reject(new HttpError(504, 'cosy_synthesis_timeout', 'CosyVoice 本地合成超时，已停止等待，请缩短选段后重试。'));
        try { this.write({ type: 'cancel', id }); } catch { /* Worker may have closed. */ }
      }, this.options.requestTimeoutMs ?? 120000); timer.unref();
      this.pending.set(id, { chunks: [], bytes: 0, onAudio, resolve: resolveResult, reject, clean: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); } });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try { this.write({ type: 'speak', id, text, voice }); } catch { this.fail(failed()); }
    });
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.fail(cancelled()); }
}
