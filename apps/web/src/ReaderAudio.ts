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
  private next = 0;
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
    this.epoch++; this.requestedPause = false; this.loaded = false;
    this.dependencies.audio.pause(); this.dependencies.audio.onended = null; this.dependencies.audio.onerror = null;
    this.dependencies.audio.src = ''; this.dependencies.audio.load();
    this.urls.forEach(url => this.dependencies.revokeUrl(url)); this.urls.clear(); this.prepared.clear();
    this.chunks = []; this.index = 0; this.active = 0; this.next = 0; this.emit('idle');
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
      this.fill(epoch);
      await this.playIndex(0, epoch);
    } catch (error) { if (epoch === this.epoch) this.fail(error instanceof Error ? error.message : '声音准备失败。'); }
  }
  private fill(epoch: number) {
    if (epoch !== this.epoch) return;
    // Current plus two look-ahead chunks; at most two requests in flight.
    while (this.active < 2 && this.next < this.chunks.length && this.next <= this.index + 2) {
      const chunkId = this.next++, generationId = this.generation;
      this.active++;
      const request = this.bridge.speak({ generationId, chunkId, text: this.chunks[chunkId] }).then(result => {
        if (epoch !== this.epoch || result.generationId !== generationId || result.chunkId !== chunkId) return { error: '朗读结果已过期。' };
        const url = this.dependencies.createUrl(result.audio, result.mimeType); this.urls.add(url); return { url };
      }, error => ({ error: error instanceof Error ? error.message : '声音准备失败，请稍后重试。' })).finally(() => {
        if (epoch === this.epoch) { this.active--; this.fill(epoch); }
      });
      this.prepared.set(chunkId, request);
    }
  }
  private async playIndex(index: number, epoch: number) {
    if (epoch !== this.epoch) return;
    this.index = index; this.loaded = false;
    if (index >= this.chunks.length) { this.emit('done'); return; }
    this.fill(epoch); this.emit(this.requestedPause ? 'paused' : 'preparing');
    const prepared = await this.prepared.get(index);
    if (epoch !== this.epoch) return;
    if (!prepared || 'error' in prepared) { this.fail(prepared?.error ?? '声音尚未准备好。'); return; }
    const audio = this.dependencies.audio;
    audio.src = prepared.url; audio.playbackRate = this.rate; this.loaded = true;
    audio.onended = () => {
      if (epoch !== this.epoch) return;
      this.dependencies.revokeUrl(prepared.url); this.urls.delete(prepared.url); this.prepared.delete(index);
      void this.playIndex(index + 1, epoch);
    };
    audio.onerror = () => { if (epoch === this.epoch) this.fail('音频无法播放，请检查输出设备后重试。'); };
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
    this.epoch++; this.dependencies.audio.pause(); this.loaded = false;
    this.dependencies.audio.onended = null; this.dependencies.audio.onerror = null;
    this.urls.forEach(url => this.dependencies.revokeUrl(url)); this.urls.clear(); this.prepared.clear();
    this.emit('error', message); void this.bridge.cancel().catch(() => {});
  }
  dispose() { void this.stop().catch(() => {}); this.listeners.clear(); }
}
