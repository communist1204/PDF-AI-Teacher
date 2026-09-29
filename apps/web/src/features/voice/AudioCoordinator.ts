import { sameEnvelope, SourceSchema, type Envelope, type PdfTarget, type ReadingCursor, type Sentence, type TeachingStep } from '../../../../../packages/shared/protocol';
import { browserPlaybackAdapter, type PlaybackAdapter, type PlaybackHandle } from './playback';
import { splitSentences, textVersion } from './sentences';
export { splitSentences, toSpeechText, requiresFormulaConfirmation } from './sentences';
export type { PlaybackAdapter, PlaybackHandle, PlaybackInput } from './playback';

export type AudioChannel = 'source' | 'explanation';
export type AudioState = {
  status: 'silent' | 'buffering' | 'speaking' | 'paused';
  /** Ownership is separate from local playback status and microphone input. */
  outputOwner?: 'local' | 'realtime';
  channel: AudioChannel;
  teachingStepId: string | null;
  error: string | null;
  sentenceIndex: number;
  sentences: Sentence[];
  /** Independent original-text cursor, even while an explanation is playing. */
  cursor: ReadingCursor | null;
  /** Whether the current playback channel has an unfinished sentence. */
  hasBookmark: boolean;
  mode: 'demo' | 'live';
  rate: number;
  volume: number;
};

/** The transport must check isCurrent() before unmuting any late remote output. */
export interface ExternalOutputLease {
  isCurrent(): boolean;
  /** Revoke this lease and synchronously stop its output; never resumes local audio. */
  release(): void;
}

export type ReadingBookmark = { target: PdfTarget; cursor: ReadingCursor };
export type ExplanationBookmark = { target: PdfTarget; stepId: string; speechText: string; sentenceId: string; textVersion: string; sentenceIndex: number };
export type AudioCompletion = { channel: AudioChannel; stepId: string | null; envelope: Envelope };
export type AudioCoordinatorOptions = {
  requestSpeech: (text: string, envelope: Envelope, speed: number, signal: AbortSignal) => Promise<Blob>;
  onChange: (state: AudioState) => void;
  onError: (message: string) => void;
  onComplete?: (event: AudioCompletion) => void;
  playbackAdapter?: PlaybackAdapter;
};

// The input state stays orthogonal to the single output owner.
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

const cloneTarget = (target: PdfTarget): PdfTarget => ({ sourceId: target.sourceId, documentId: target.documentId, pageIndex: target.pageIndex, pageLabel: target.pageLabel, blockId: target.blockId, rect: target.rect ? [...target.rect] : null, sourceText: target.sourceText, ...(target.imageDataUrl ? { imageDataUrl: target.imageDataUrl } : {}) });
const sameTarget = (left: PdfTarget | null, right: PdfTarget): boolean => !!left && left.documentId === right.documentId && left.pageIndex === right.pageIndex && left.blockId === right.blockId && left.sourceText === right.sourceText;
function validTarget(value: PdfTarget): boolean {
  return SourceSchema.safeParse(value).success && (value.imageDataUrl === undefined || (typeof value.imageDataUrl === 'string' && value.imageDataUrl.length <= 3000000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.imageDataUrl)));
}

/** One owner, one current sentence, no speculative pre-generation. */
export class AudioCoordinator {
  private state: AudioState = { status: 'silent', channel: 'source', teachingStepId: null, error: null, sentenceIndex: 0, sentences: [], cursor: null, hasBookmark: false, mode: 'demo', rate: 1, volume: 1 };
  private target: PdfTarget | null = null;
  private sourceBookmark: ReadingBookmark | null = null;
  private explanationText = '';
  private envelope: Envelope | null = null;
  private active: PlaybackHandle | null = null;
  private externalOutput: { stop: () => void } | null = null;
  private request: AbortController | null = null;
  private epoch = 0;
  private playbackAttempt = 0;
  private disposed = false;
  private readonly adapter: PlaybackAdapter;

  constructor(private readonly options: AudioCoordinatorOptions) {
    this.adapter = options.playbackAdapter ?? browserPlaybackAdapter;
  }

  getSnapshot(): AudioState {
    return { ...this.state, outputOwner: this.externalOutput ? 'realtime' : 'local', sentences: this.state.sentences.map(sentence => ({ ...sentence })), cursor: this.sourceBookmark ? { ...this.sourceBookmark.cursor } : null };
  }

  /**
   * Transfers the only output slot to a transport without owning its microphone,
   * connection, or remote playback status. Pending local TTS is cancelled and
   * both local bookmarks remain unchanged. The caller unmutes only if current.
   *
   * stop must synchronously silence output, must not throw, and may release this
   * lease during cleanup. All local playback/stop/pause operations revoke it;
   * release is idempotent and an old lease cannot release a newer owner.
   */
  claimExternalOutput(stop: () => void): ExternalOutputLease {
    const inactive: ExternalOutputLease = { isCurrent: () => false, release: () => {} };
    if (this.disposed) { stop(); return inactive; }
    this.cancel();
    // Cleanup may synchronously dispose this coordinator or start another owner.
    if (this.disposed || this.externalOutput || this.active || this.request) { stop(); return inactive; }
    const owner = { stop };
    this.externalOutput = owner;
    this.state.status = 'silent';
    this.state.error = null;
    const lease: ExternalOutputLease = {
      isCurrent: () => !this.disposed && this.externalOutput === owner,
      release: () => {
        if (this.externalOutput !== owner) return;
        this.cancel();
        this.state.status = 'silent';
        this.emit();
      },
    };
    this.emit();
    return lease;
  }

  getBookmark(): ReadingBookmark | null {
    return this.sourceBookmark ? { target: cloneTarget(this.sourceBookmark.target), cursor: { ...this.sourceBookmark.cursor } } : null;
  }

  getExplanationBookmark(): ExplanationBookmark | null {
    const sentence = this.state.sentences[this.state.sentenceIndex];
    if (this.state.channel !== 'explanation' || !this.state.hasBookmark || !this.target || !this.state.teachingStepId || !sentence) return null;
    return { target: cloneTarget(this.target), stepId: this.state.teachingStepId, speechText: this.explanationText, sentenceId: sentence.sentenceId, textVersion: textVersion(this.explanationText), sentenceIndex: this.state.sentenceIndex };
  }

  private emit() { if (!this.disposed) this.options.onChange(this.getSnapshot()); }

  private cursor(index: number): ReadingCursor | null {
    const sentence = this.state.sentences[index];
    if (!sentence || !this.target || this.state.channel !== 'source') return null;
    return { documentId: this.target.documentId, pageIndex: this.target.pageIndex, blockId: this.target.blockId, sentenceId: sentence.sentenceId, textVersion: textVersion(this.target.sourceText), sentenceIndex: index };
  }

  private rememberSource() {
    const cursor = this.cursor(this.state.sentenceIndex);
    if (cursor && this.target) this.sourceBookmark = { target: cloneTarget(this.target), cursor };
  }

  private cancel() {
    // Invalidate callbacks before abort/stop, which may synchronously emit events.
    this.epoch += 1;
    this.request?.abort();
    this.request = null;
    const previous = this.active;
    const external = this.externalOutput;
    this.active = null;
    this.externalOutput = null;
    previous?.stop();
    previous?.dispose();
    // Detach before calling transport cleanup: it may synchronously release.
    external?.stop();
  }

  load(target: PdfTarget, envelope: Envelope, mode: 'demo' | 'live'): void {
    if (this.disposed) return;
    const bookmark = this.sourceBookmark && sameTarget(this.sourceBookmark.target, target) ? this.sourceBookmark : null;
    this.cancel();
    this.sourceBookmark = bookmark;
    this.target = cloneTarget(target);
    this.explanationText = '';
    this.envelope = { ...envelope };
    this.state = { ...this.state, status: 'silent', channel: 'source', teachingStepId: null, error: null, mode, sentences: splitSentences(target.sourceText), sentenceIndex: bookmark?.cursor.sentenceIndex ?? 0, hasBookmark: !!bookmark };
    this.emit();
  }

  /** The caller must display this TeachingStep before starting its speech. */
  loadExplanation(target: PdfTarget, step: TeachingStep, envelope: Envelope, mode: 'demo' | 'live'): void {
    if (this.disposed) return;
    const unchanged = this.state.channel === 'explanation' && sameTarget(this.target, target) && this.state.teachingStepId === step.stepId && this.explanationText === step.speechText;
    const index = unchanged && this.state.hasBookmark ? this.state.sentenceIndex : 0;
    const hasBookmark = unchanged && this.state.hasBookmark;
    this.cancel();
    if (this.sourceBookmark?.target.documentId !== target.documentId) this.sourceBookmark = null;
    this.target = cloneTarget(target);
    this.explanationText = step.speechText;
    this.envelope = { ...envelope };
    this.state = { ...this.state, status: 'silent', channel: 'explanation', teachingStepId: step.stepId, error: null, mode, sentences: splitSentences(step.speechText), sentenceIndex: index, hasBookmark };
    this.emit();
  }

  private mayRestore(target: PdfTarget): boolean {
    if (!validTarget(target)) return false;
    if (this.target && this.target.documentId !== target.documentId) return false;
    // A corrected version of the same block cannot reuse its old anchor.
    if (this.target?.documentId === target.documentId && this.target.pageIndex === target.pageIndex && this.target.blockId === target.blockId && this.target.sourceText !== target.sourceText) return false;
    return true;
  }

  /** Validates persisted data and restores at a sentence boundary; never starts audio. */
  restoreBookmark(bookmark: ReadingBookmark, envelope: Envelope, mode: 'demo' | 'live'): boolean {
    if (this.disposed || !bookmark || !this.mayRestore(bookmark.target)) return false;
    const cursor = bookmark.cursor;
    const target = bookmark.target;
    const sentence = cursor && Number.isInteger(cursor.sentenceIndex) && cursor.sentenceIndex >= 0 ? splitSentences(target.sourceText)[cursor.sentenceIndex] : null;
    if (!sentence || cursor.documentId !== target.documentId || cursor.pageIndex !== target.pageIndex || cursor.blockId !== target.blockId || cursor.textVersion !== textVersion(target.sourceText) || cursor.sentenceId !== sentence.sentenceId) return false;
    this.sourceBookmark = { target: cloneTarget(target), cursor: { ...cursor } };
    this.load(target, envelope, mode);
    return true;
  }

  restoreExplanationBookmark(bookmark: ExplanationBookmark, envelope: Envelope, mode: 'demo' | 'live'): boolean {
    if (this.disposed || !bookmark || !this.mayRestore(bookmark.target) || typeof bookmark.stepId !== 'string' || !bookmark.stepId || bookmark.stepId.length > 200 || typeof bookmark.speechText !== 'string' || !bookmark.speechText.trim() || bookmark.speechText.length > 4000 || !Number.isInteger(bookmark.sentenceIndex) || bookmark.sentenceIndex < 0) return false;
    const sentences = splitSentences(bookmark.speechText);
    if (bookmark.textVersion !== textVersion(bookmark.speechText) || sentences[bookmark.sentenceIndex]?.sentenceId !== bookmark.sentenceId) return false;
    this.cancel();
    this.target = cloneTarget(bookmark.target);
    this.explanationText = bookmark.speechText;
    this.envelope = { ...envelope };
    this.state = { ...this.state, status: 'silent', channel: 'explanation', teachingStepId: bookmark.stepId, error: null, mode, sentences, sentenceIndex: bookmark.sentenceIndex, hasBookmark: true };
    this.emit();
    return true;
  }

  async resumeSource(envelope: Envelope, mode: 'demo' | 'live'): Promise<void> {
    if (this.disposed) return;
    if (this.externalOutput) this.stop();
    const bookmark = this.getBookmark();
    if (!bookmark) return;
    if (this.state.channel === 'source' && sameTarget(this.target, bookmark.target) && this.envelope && sameEnvelope(this.envelope, envelope) && this.state.mode === mode) return this.resume();
    if (this.restoreBookmark(bookmark, envelope, mode)) await this.resume();
  }

  /** New question/revision keeps both anchors while invalidating old network/audio work. */
  rebind(envelope: Envelope): void {
    if (this.disposed || (!this.externalOutput && this.envelope && sameEnvelope(this.envelope, envelope))) return;
    this.cancel();
    this.envelope = { ...envelope };
    this.state.status = 'silent';
    this.emit();
  }

  async play(): Promise<void> {
    if (this.disposed || this.state.status === 'speaking' || this.state.status === 'buffering') return;
    if (this.state.status === 'paused') return this.resume();
    if (!this.state.sentences.length || !this.envelope) { this.fail(this.state.channel === 'source' ? '请先在 PDF 中选中可读文字。' : '这一步没有可朗读的讲解文字。'); return; }
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
    let started = false;
    this.state.status = 'buffering';
    this.state.error = null;
    this.state.hasBookmark = true;
    this.rememberSource();
    this.emit();
    try {
      const rate = this.state.rate;
      const blob = this.state.mode === 'live' ? await this.options.requestSpeech(sentence.speechText, envelope, rate, request.signal) : undefined;
      if (!valid()) return;
      const handle = await this.adapter.create({
        mode: this.state.mode, text: sentence.speechText, blob, rate, volume: this.state.volume, signal: request.signal,
        onStarted: () => { if (valid() && this.state.status !== 'paused') { started = true; this.state.status = 'speaking'; this.emit(); } },
        onEnded: () => {
          if (!valid() || !started) return;
          // An end racing with pause is not confirmed as read. Discard that
          // finished handle so resume can replay the unfinished sentence.
          if (this.state.status === 'paused') { this.cancel(); this.emit(); }
          else this.finishedSentence();
        },
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
    const completion: AudioCompletion | null = this.envelope ? { channel: this.state.channel, stepId: this.state.teachingStepId, envelope: { ...this.envelope } } : null;
    this.cancel();
    if (next < this.state.sentences.length) {
      this.state.sentenceIndex = next;
      void this.startSentence();
    } else {
      if (this.state.channel === 'source') this.sourceBookmark = null;
      this.state.status = 'silent';
      this.state.hasBookmark = false;
      const completedEpoch = this.epoch;
      this.emit();
      if (!this.disposed && completedEpoch === this.epoch && completion && this.envelope && sameEnvelope(completion.envelope, this.envelope)) this.options.onComplete?.(completion);
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
    // External pause revokes output; resume explicitly restarts the local sentence.
    if (!this.disposed && this.externalOutput) {
      this.cancel();
      this.state.status = 'paused';
      this.emit();
      return;
    }
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
    this.sourceBookmark = null;
    this.explanationText = '';
    this.envelope = null;
    this.state = { ...this.state, status: 'silent', channel: 'source', teachingStepId: null, error: null, sentences: [], sentenceIndex: 0, cursor: null, hasBookmark: false };
    this.emit();
  }

  private move(delta: number) {
    if (this.disposed) return;
    if (this.externalOutput) this.stop();
    if (!this.state.sentences.length) return;
    const continuePlaying = this.state.status === 'speaking' || this.state.status === 'buffering';
    this.cancel();
    this.state.sentenceIndex = Math.max(0, Math.min(this.state.sentences.length - 1, this.state.sentenceIndex + delta));
    this.rememberSource();
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
    this.sourceBookmark = null;
    this.envelope = null;
    this.explanationText = '';
    this.state = { ...this.state, status: 'silent', cursor: null, hasBookmark: false, sentences: [] };
    this.disposed = true;
  }
}
