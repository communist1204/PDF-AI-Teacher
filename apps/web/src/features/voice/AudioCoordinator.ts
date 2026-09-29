import { sameEnvelope, type Envelope, type PdfTarget, type ReadingCursor, type Sentence } from '../../../../../packages/shared/protocol';
import { browserPlaybackAdapter, type PlaybackAdapter, type PlaybackHandle } from './playback';
import { splitSentences, textVersion } from './sentences';
export { splitSentences, toSpeechText, requiresFormulaConfirmation } from './sentences';
export type { PlaybackAdapter, PlaybackHandle, PlaybackInput } from './playback';

export type AudioState = {
  status: 'silent' | 'buffering' | 'speaking' | 'paused';
  error: string | null;
  sentenceIndex: number;
  sentences: Sentence[];
  cursor: ReadingCursor | null;
  hasBookmark: boolean;
  mode: 'demo' | 'live';
  rate: number;
  volume: number;
};

export type AudioCoordinatorOptions = {
  requestSpeech: (text: string, envelope: Envelope, speed: number, signal: AbortSignal) => Promise<Blob>;
  onChange: (state: AudioState) => void;
  onError: (message: string) => void;
  playbackAdapter?: PlaybackAdapter;
};

// M2/M3 integration contracts only: neither microphone capture nor Realtime is implemented.
export type VoiceInputState = 'off' | 'listening' | 'transcribing';
export interface FutureOutputLease {
  envelope: Readonly<Envelope>;
  isCurrent(): boolean;
  release(): void;
}
export interface FutureRealtimeOutputAdapter {
  // M3 must obtain a coordinator lease before unmuting remote output.
  bindOutputLease(lease: FutureOutputLease): void;
  stopOutput(): void;
  cancelUpstream(envelope: Envelope): Promise<void>;
  close(): void;
}

/** One owner, one current sentence, no speculative pre-generation. */
export class AudioCoordinator {
  private state: AudioState = { status: 'silent', error: null, sentenceIndex: 0, sentences: [], cursor: null, hasBookmark: false, mode: 'demo', rate: 1, volume: 1 };
  private target: PdfTarget | null = null;
  private envelope: Envelope | null = null;
  private active: PlaybackHandle | null = null;
  private request: AbortController | null = null;
  private epoch = 0;
  private playbackAttempt = 0;
  private disposed = false;
  private readonly adapter: PlaybackAdapter;

  constructor(private readonly options: AudioCoordinatorOptions) {
    this.adapter = options.playbackAdapter ?? browserPlaybackAdapter;
  }

  getSnapshot(): AudioState {
    return { ...this.state, sentences: this.state.sentences.map(sentence => ({ ...sentence })), cursor: this.state.cursor ? { ...this.state.cursor } : null };
  }

  private emit() { if (!this.disposed) this.options.onChange(this.getSnapshot()); }

  private cursor(index: number): ReadingCursor | null {
    const sentence = this.state.sentences[index];
    if (!sentence || !this.target) return null;
    return { documentId: this.target.documentId, pageIndex: this.target.pageIndex, blockId: this.target.blockId, sentenceId: sentence.sentenceId, textVersion: textVersion(this.target.sourceText), sentenceIndex: index };
  }

  private cancel() {
    // Invalidate callbacks before abort/stop, which may synchronously emit events.
    this.epoch += 1;
    this.request?.abort();
    this.request = null;
    const previous = this.active;
    this.active = null;
    previous?.stop();
    previous?.dispose();
  }

  load(target: PdfTarget, envelope: Envelope, mode: 'demo' | 'live'): void {
    if (this.disposed) return;
    const unchanged = this.target?.documentId === target.documentId && this.target?.pageIndex === target.pageIndex && this.target?.blockId === target.blockId && this.target?.sourceText === target.sourceText;
    this.cancel();
    this.target = { ...target };
    this.envelope = { ...envelope };
    this.state = { ...this.state, status: 'silent', error: null, mode, sentences: splitSentences(target.sourceText), sentenceIndex: unchanged ? this.state.sentenceIndex : 0, hasBookmark: unchanged && this.state.hasBookmark };
    this.state.cursor = this.state.hasBookmark ? this.cursor(this.state.sentenceIndex) : null;
    this.emit();
  }

  /** New question/revision keeps the reading anchor while invalidating old network/audio work. */
  rebind(envelope: Envelope): void {
    if (this.disposed || (this.envelope && sameEnvelope(this.envelope, envelope))) return;
    this.cancel();
    this.envelope = { ...envelope };
    this.state.status = 'silent';
    this.emit();
  }

  async play(): Promise<void> {
    if (this.disposed || this.state.status === 'speaking' || this.state.status === 'buffering') return;
    if (this.state.status === 'paused') return this.resume();
    if (!this.state.sentences.length || !this.envelope) { this.fail('请先在 PDF 中选中可读文字。'); return; }
    if (!this.state.hasBookmark) this.state.sentenceIndex = 0;
    await this.startSentence();
  }

  private async startSentence(): Promise<void> {
    if (this.disposed || !this.envelope) return;
    this.cancel();
    const token = this.epoch;
    const envelope = { ...this.envelope };
    const sentence = this.state.sentences[this.state.sentenceIndex];
    if (!sentence) return;
    const request = new AbortController();
    this.request = request;
    const valid = () => !this.disposed && token === this.epoch && !!this.envelope && sameEnvelope(envelope, this.envelope) && !request.signal.aborted;
    this.state.status = 'buffering';
    this.state.error = null;
    this.state.hasBookmark = true;
    this.state.cursor = this.cursor(this.state.sentenceIndex);
    this.emit();
    try {
      const rate = this.state.rate;
      const blob = this.state.mode === 'live' ? await this.options.requestSpeech(sentence.speechText, envelope, rate, request.signal) : undefined;
      if (!valid()) return;
      const handle = await this.adapter.create({
        mode: this.state.mode, text: sentence.speechText, blob, rate, volume: this.state.volume, signal: request.signal,
        onStarted: () => { if (valid() && this.state.status !== 'paused') { this.state.status = 'speaking'; this.emit(); } },
        onEnded: () => { if (valid()) this.finishedSentence(); },
        onError: message => { if (valid()) this.fail(message); },
      });
      if (!valid()) { handle.stop(); handle.dispose(); return; }
      this.active = handle;
      // Settings may change while the network/voice discovery was pending.
      handle.setRate(this.state.rate);
      handle.setVolume(this.state.volume);
      const attempt = ++this.playbackAttempt;
      try { await handle.play(); }
      catch (error) {
        // pause() can reject an in-flight HTMLMediaElement.play() Promise.
        // A later resume owns a new attempt; neither case is a playback failure.
        if (attempt !== this.playbackAttempt) return;
        throw error;
      }
    } catch (error) {
      if (!valid()) return;
      this.fail(error instanceof Error ? `朗读未能完成：${error.message}` : '朗读未能完成，请重试。');
    }
  }

  private finishedSentence() {
    const next = this.state.sentenceIndex + 1;
    this.cancel();
    if (next < this.state.sentences.length) {
      this.state.sentenceIndex = next;
      void this.startSentence();
    } else {
      this.state.status = 'silent';
      this.state.hasBookmark = false;
      this.state.cursor = null;
      this.emit();
    }
  }

  private fail(message: string) {
    this.cancel();
    this.state.status = 'silent';
    this.state.error = message;
    this.emit();
    if (!this.disposed) this.options.onError(message);
  }

  pause(): void {
    if (this.disposed || (this.state.status !== 'speaking' && this.state.status !== 'buffering')) return;
    if (this.active) {
      this.playbackAttempt += 1;
      this.active.pause();
    }
    else this.cancel(); // A pending request cannot later begin playing behind a paused UI.
    this.state.status = 'paused';
    this.emit();
  }

  async resume(): Promise<void> {
    if (this.disposed || this.state.status === 'speaking' || this.state.status === 'buffering') return;
    if (this.active && this.state.status === 'paused') {
      const token = this.epoch;
      this.state.status = 'buffering';
      this.emit();
      const attempt = ++this.playbackAttempt;
      try { await this.active.play(); }
      catch (error) { if (token === this.epoch && attempt === this.playbackAttempt) this.fail(error instanceof Error ? `无法继续播放：${error.message}` : '无法继续播放，请重试。'); }
      return;
    }
    this.state.status = 'silent';
    await this.play();
  }

  stop(): void {
    if (this.disposed) return;
    this.cancel();
    this.state.status = 'silent';
    this.emit();
  }

  interrupt(): void { this.stop(); }

  reset(): void {
    if (this.disposed) return;
    this.cancel();
    this.target = null;
    this.envelope = null;
    this.state = { ...this.state, status: 'silent', error: null, sentences: [], sentenceIndex: 0, cursor: null, hasBookmark: false };
    this.emit();
  }

  private move(delta: number) {
    if (this.disposed || !this.state.sentences.length) return;
    const continuePlaying = this.state.status === 'speaking' || this.state.status === 'buffering';
    this.cancel();
    this.state.sentenceIndex = Math.max(0, Math.min(this.state.sentences.length - 1, this.state.sentenceIndex + delta));
    this.state.cursor = this.cursor(this.state.sentenceIndex);
    this.state.hasBookmark = true;
    this.state.status = 'silent';
    this.state.error = null;
    this.emit();
    if (continuePlaying) void this.startSentence();
  }

  previous(): void { this.move(-1); }
  next(): void { this.move(1); }

  setRate(rate: number): void {
    if (this.disposed || !Number.isFinite(rate)) return;
    this.state.rate = Math.max(0.5, Math.min(2, rate));
    this.active?.setRate(this.state.rate);
    this.emit();
  }

  setVolume(volume: number): void {
    if (this.disposed || !Number.isFinite(volume)) return;
    this.state.volume = Math.max(0, Math.min(1, volume));
    this.active?.setVolume(this.state.volume);
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.target = null;
    this.envelope = null;
    this.state = { ...this.state, status: 'silent', cursor: null, hasBookmark: false, sentences: [] };
    this.disposed = true;
  }
}
