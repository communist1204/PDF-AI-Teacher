import type { ReaderBridge } from '../../../packages/shared/reader';

export type AudioPhase = 'idle' | 'preparing' | 'playing' | 'paused' | 'done' | 'error';
export interface AudioState { phase: AudioPhase; index: number; total: number; message: string }
export interface AudioDevice {
  src: string; playbackRate: number; currentTime: number;
  onended: ((event: Event) => unknown) | null; onerror: OnErrorEventHandler;
  play(): Promise<void>; pause(): void; load(): void;
}
type Prepared = { url: string } | { error: string };
export interface AudioDependencies {
  audio: AudioDevice;
  createUrl(bytes: Uint8Array, mimeType?: 'audio/wav' | 'audio/mpeg'): string;
  revokeUrl(url: string): void;
  id(): string;
}
export class ReaderAudio {
  private epoch = 0;
  private generation = '';
  private chunks: string[] = [];
  private prepared = new Map<number, Promise<Prepared>>();
  private urls = new Set<string>();
  private active = 0;
  private waiters = new Set<() => void>();
  private wake() { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  private position = 0;
  private ready = false;
  private cachedBytes = 0;
  private index = 0;
  private requestedPause = false;
  private loaded = false;
  private rate = 1;
  private playAttempt = 0;
  private state: AudioState = { phase: 'idle', index: 0, total: 0, message: '' };
  private listeners = new Set<(state: AudioState) => void>();
  constructor(private bridge: Pick<ReaderBridge, 'beginSpeech' | 'speak' | 'cancel'>, private dependencies: AudioDependencies = {
    audio: new Audio(),
    createUrl: (bytes, mimeType = 'audio/wav') => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType })),
    revokeUrl: url => URL.revokeObjectURL(url), id: () => crypto.randomUUID(),
  }) {}
  subscribe(listener: (state: AudioState) => void) { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener); }; }
  private emit(phase: AudioPhase, message = '') {
    this.state = { phase, index: this.index, total: this.chunks.length, message };
    this.listeners.forEach(listener => listener(this.state));
  }
  setRate(rate: number) {
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 3) throw Error('语速应在 0.25 到 3 倍之间。');
    this.rate = rate; this.dependencies.audio.playbackRate = rate;
  }
  async stop() {
    this.epoch++; this.position++; this.playAttempt++; this.ready = false; this.requestedPause = false; this.loaded = false;
    this.dependencies.audio.pause(); this.dependencies.audio.onended = null; this.dependencies.audio.onerror = null;
    this.dependencies.audio.src = ''; this.dependencies.audio.load();
    this.urls.forEach(url => this.dependencies.revokeUrl(url)); this.urls.clear(); this.prepared.clear();
    this.wake(); this.chunks = []; this.index = 0; this.active = 0; this.cachedBytes = 0; this.emit('idle');
    await this.bridge.cancel();
  }
  async start(chunks: string[]) {
    const epoch = this.epoch + 1;
    await this.stop();
    if (!chunks.length || epoch !== this.epoch) return;
    this.generation = this.dependencies.id(); this.chunks = [...chunks]; this.emit('preparing');
    try {
      await this.bridge.beginSpeech(this.generation);
      if (epoch !== this.epoch) return;
      this.ready = true;
      await this.playIndex(this.index, epoch);
    } catch (error) { if (epoch === this.epoch) this.fail(error instanceof Error ? error.message : '声音准备失败。'); }
  }
  private fill(epoch: number) {
    if (epoch !== this.epoch || !this.ready) return;
    // Prioritize the selected segment; retain completed audio for local replay.
    for (let chunkId = this.index; chunkId < Math.min(this.chunks.length, this.index + 3) && this.active < 2; chunkId++) {
      if (this.prepared.has(chunkId)) continue;
      const generationId = this.generation;
      this.active++;
      const request = this.bridge.speak({ generationId, chunkId, text: this.chunks[chunkId] }).then(result => {
        if (epoch !== this.epoch || result.generationId !== generationId || result.chunkId !== chunkId) return { error: '朗读结果已过期。' };
        if (this.cachedBytes + result.audio.byteLength > 128 * 1024 * 1024) return { error: '这次朗读的音频过长，请分成较小范围。' };
        const url = this.dependencies.createUrl(result.audio, result.mimeType);
        this.cachedBytes += result.audio.byteLength; this.urls.add(url); return { url };
      }, error => ({ error: error instanceof Error ? error.message : '声音准备失败，请稍后重试。' })).finally(() => {
        if (epoch === this.epoch) { this.active--; this.fill(epoch); this.wake(); }
      });
      this.prepared.set(chunkId, request);
    }
  }
  previous() { return this.navigate(this.index - 1); }
  replay() { return this.navigate(this.index); }
  next() { return this.navigate(this.index + 1); }
  private async navigate(index: number) {
    if (!this.chunks.length || ['idle', 'error'].includes(this.state.phase) || index < 0 || index >= this.chunks.length) return;
    // Navigation is an explicit play action, including from pause or completion.
    this.requestedPause = false;
    await this.playIndex(index, this.epoch);
  }
  private async playIndex(index: number, epoch: number) {
    if (epoch !== this.epoch) return;
    const position = ++this.position; this.wake();
    this.playAttempt++; this.loaded = false;
    const audio = this.dependencies.audio;
    audio.onended = null; audio.onerror = null; audio.pause();
    this.index = index;
    this.emit(this.requestedPause ? 'paused' : 'preparing');
    // A navigation during beginSpeech is picked up by start once it is ready.
    if (!this.ready) return;
    this.fill(epoch);
    // Earlier, irrelevant requests may still occupy the bounded two slots.
    while (!this.prepared.has(index)) {
      await new Promise<void>(resolve => this.waiters.add(resolve));
      if (epoch !== this.epoch || position !== this.position) return;
      this.fill(epoch);
    }
    const prepared = await this.prepared.get(index);
    if (epoch !== this.epoch || position !== this.position) return;
    if (!prepared || 'error' in prepared) { this.fail(prepared?.error ?? '声音尚未准备好。'); return; }
    audio.src = prepared.url; audio.currentTime = 0; audio.playbackRate = this.rate; this.loaded = true;
    audio.onended = () => {
      if (epoch !== this.epoch || position !== this.position) return;
      if (index + 1 === this.chunks.length) { this.loaded = false; this.emit('done'); }
      else void this.playIndex(index + 1, epoch);
    };
    audio.onerror = () => { if (epoch === this.epoch && position === this.position) this.fail('音频无法播放，请检查输出设备后重试。'); };
    if (!this.requestedPause) await this.play(epoch);
  }
  private async play(epoch: number) {
    const attempt = ++this.playAttempt;
    try {
      await this.dependencies.audio.play();
      if (epoch !== this.epoch || attempt !== this.playAttempt) return;
      if (this.requestedPause) { this.dependencies.audio.pause(); this.emit('paused'); }
      else this.emit('playing');
    } catch { if (epoch === this.epoch && attempt === this.playAttempt) this.fail('播放未能开始，请检查输出设备后重新朗读。'); }
  }
  togglePause() {
    if (!['preparing', 'playing', 'paused'].includes(this.state.phase)) return;
    this.requestedPause = !this.requestedPause;
    if (this.requestedPause) { this.playAttempt++; this.dependencies.audio.pause(); this.emit('paused'); }
    else if (this.loaded) void this.play(this.epoch);
    else this.emit('preparing');
  }
  private fail(message: string) {
    this.epoch++; this.position++; this.playAttempt++; this.ready = false; this.dependencies.audio.pause(); this.loaded = false;
    this.dependencies.audio.onended = null; this.dependencies.audio.onerror = null;
    this.urls.forEach(url => this.dependencies.revokeUrl(url)); this.urls.clear(); this.prepared.clear();
    this.wake(); this.cachedBytes = 0; this.emit('error', message); void this.bridge.cancel().catch(() => {});
  }
  dispose() { void this.stop().catch(() => {}); this.listeners.clear(); }
}
