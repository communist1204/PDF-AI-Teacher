import { MAX_RECORDING_BYTES, MAX_RECORDING_MS, type AudioMime } from '../../../../../packages/shared/protocol';

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'stopping';
export type RecordedQuestion = { blob: Blob; mimeType: AudioMime; durationMs: number };
export type LevelMeter = { peak: () => number; close: () => void };
export interface RecorderPlatform {
  getUserMedia: () => Promise<MediaStream>;
  isTypeSupported: (type: string) => boolean;
  createRecorder: (stream: MediaStream, mimeType: string) => MediaRecorder;
  createMeter: (stream: MediaStream) => LevelMeter;
  now: () => number;
}
export function microphoneError(error: unknown): string {
  const name = typeof error === 'object' && error ? (error as { name?: string }).name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝。请在地址栏的网站权限中允许麦克风后重试，也可以直接输入文字。';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到麦克风。请连接设备并检查 Windows 声音输入设置，或直接输入文字。';
  if (name === 'NotReadableError' || name === 'TrackStartError') return '麦克风无法使用。请检查设备是否被其他程序独占，然后重试。';
  return error instanceof Error && error.message ? error.message : '录音失败，请检查麦克风后重试；仍可直接输入文字。';
}
function createMeter(stream: MediaStream): LevelMeter {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser); // No destination connection: microphone is never played aloud.
  const samples = new Float32Array(analyser.fftSize);
  let peak = 0;
  const sample = () => { analyser.getFloatTimeDomainData(samples); peak = Math.max(peak, Math.sqrt(samples.reduce((n, v) => n + v * v, 0) / samples.length)); };
  const timer = setInterval(sample, 100);
  void context.resume().catch(() => undefined);
  return { peak: () => { sample(); return peak; }, close: () => { clearInterval(timer); source.disconnect(); analyser.disconnect(); void context.close().catch(() => undefined); } };
}
export function browserRecorderPlatform(): RecorderPlatform {
  return {
    getUserMedia: () => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return Promise.reject(new Error('当前浏览器无法录音。请使用本机地址的新版 Edge 或 Chrome，或直接输入文字。'));
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    },
    isTypeSupported: type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type),
    createRecorder: (stream, mimeType) => new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 }),
    createMeter,
    now: () => Date.now(),
  };
}

/** Input only. Output ownership and teaching generation remain with the application. */
export class QuestionRecorder {
  private epoch = 0;
  private state: RecorderState = 'idle';
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private meter: LevelMeter | null = null;
  private chunks: Blob[] = [];
  private bytes = 0;
  private started = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  constructor(private callbacks: { onState: (state: RecorderState, seconds: number) => void; onComplete: (recording: RecordedQuestion) => void; onError: (message: string) => void }, private platform = browserRecorderPlatform()) {}
  get currentState() { return this.state; }
  private emit(state: RecorderState, seconds = 0) { this.state = state; this.callbacks.onState(state, seconds); }
  private release() {
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.meter?.close(); this.meter = null;
    this.timers.forEach(clearTimeout); this.timers = [];
    if (this.ticker !== null) clearInterval(this.ticker); this.ticker = null;
  }
  cancel() {
    this.epoch += 1;
    const recorder = this.recorder; this.recorder = null;
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* device already ended */ } }
    this.release(); this.chunks = []; this.bytes = 0; this.emit('idle');
  }
  private fail(message: string) { this.cancel(); this.callbacks.onError(message); }
  async start() {
    if (this.state !== 'idle') return;
    const epoch = ++this.epoch;
    this.emit('requesting');
    const permissionTimer = setTimeout(() => { if (epoch === this.epoch) this.fail('等待麦克风权限超时，请允许权限后重新点击录音。'); }, 20000);
    this.timers.push(permissionTimer);
    try {
      const stream = await this.platform.getUserMedia();
      clearTimeout(permissionTimer);
      if (epoch !== this.epoch) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => this.platform.isTypeSupported(type));
      if (!mime) throw new Error('浏览器不支持此应用的录音格式，请改用 Edge 或 Chrome，或直接输入文字。');
      const recorder = this.platform.createRecorder(stream, mime);
      this.recorder = recorder;
      this.meter = this.platform.createMeter(stream);
      this.chunks = []; this.bytes = 0;
      recorder.ondataavailable = event => {
        if (epoch !== this.epoch || !event.data.size) return;
        this.bytes += event.data.size;
        if (this.bytes > MAX_RECORDING_BYTES) { this.fail('录音超过 4 MB，已停止且未上传。请缩短问题后重录。'); return; }
        this.chunks.push(event.data);
      };
      recorder.onerror = () => { if (epoch === this.epoch) this.fail('录音设备发生错误，已关闭麦克风。请重新录音或直接输入文字。'); };
      recorder.onstop = () => {
        if (epoch !== this.epoch) return;
        const durationMs = Math.min(MAX_RECORDING_MS, Math.max(0, Math.round(this.platform.now() - this.started)));
        const level = this.meter?.peak() ?? 0;
        const blob = new Blob(this.chunks, { type: mime.split(';')[0] });
        this.recorder = null; this.release(); this.chunks = []; this.bytes = 0; this.emit('idle');
        if (durationMs < 300 || blob.size < 32) { this.callbacks.onError('录音太短或没有内容，请说完一个问题后再结束录音。'); return; }
        if (level < 0.003) { this.callbacks.onError('录音音量过低或没有声音，未上传。请靠近麦克风并检查输入音量后重录。'); return; }
        this.callbacks.onComplete({ blob, mimeType: mime.split(';')[0] as AudioMime, durationMs });
      };
      for (const track of stream.getTracks()) track.addEventListener('ended', () => { if (epoch === this.epoch && this.state === 'recording') this.fail('麦克风已断开，录音已取消。请重新连接设备后重试。'); }, { once: true });
      this.started = this.platform.now(); recorder.start(250); this.emit('recording');
      this.ticker = setInterval(() => { if (epoch === this.epoch && this.state === 'recording') this.emit('recording', Math.floor((this.platform.now() - this.started) / 1000)); }, 250);
      this.timers.push(setTimeout(() => this.finish(), MAX_RECORDING_MS));
    } catch (error) { if (epoch === this.epoch) this.fail(microphoneError(error)); }
  }
  finish() {
    if (this.state !== 'recording' || !this.recorder) return;
    this.emit('stopping');
    // stop() queues dataavailable/onstop; tracks are released immediately, not after upload.
    try { this.recorder.stop(); this.stream?.getTracks().forEach(track => track.stop()); }
    catch (error) { this.fail(microphoneError(error)); }
  }
}

export async function recordingBase64(blob: Blob): Promise<string> {
  if (blob.size > MAX_RECORDING_BYTES) throw new Error('录音超过 4 MB，请缩短问题。');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
