import { isCosyVoice, type CosyVoiceId } from '../../../../../packages/shared/cosySpeech';
import type { Envelope } from '../../../../../packages/shared/protocol';
import type { ExternalOutputLease } from './AudioCoordinator';
import { browserPlaybackAdapter, type PlaybackAdapter, type PlaybackHandle } from './playback';
import type { SpeechStream } from './streamPlayback';

export const COSY_AUDITION_TEXT = '二零二六年，我们一起学习神经网络。注意力机制会根据当前的问题，为不同的信息分配权重。重要的内容得到更多关注，但这并不意味着其他信息完全没有作用。阅读理论时，先弄清楚每个概念的含义，再把前后的推导连起来。遇到暂时不懂的地方，可以停一停，换一个简单的例子，慢慢理解。';
export type CosyAuditionState = { status: 'idle' | 'loading' | 'playing' | 'finished' | 'error'; voice?: CosyVoiceId; message?: string };
type Options = {
  /** Must check the applied engine before changing any session or output state. */
  available: () => boolean;
  /** Invalidates only the speech lane; leaves the question task and reading bookmark intact. */
  begin: () => Envelope;
  claimOutput: (stop: () => void) => ExternalOutputLease;
  request: (text: string, envelope: Envelope, speed: number, signal: AbortSignal, voice: CosyVoiceId) => Promise<Blob | SpeechStream>;
  onChange: (state: CosyAuditionState) => void;
  volume?: () => number;
  playbackAdapter?: PlaybackAdapter;
};

/** A short explicit audition borrows the existing audio owner; never loads a reading target. */
export class CosyVoiceAudition {
  private epoch = 0;
  private active: { request: AbortController; lease: ExternalOutputLease; handle?: PlaybackHandle } | null = null;
  private disposed = false;
  constructor(private readonly options: Options) {}

  stop(): void {
    ++this.epoch;
    const active = this.active;
    this.active = null;
    active?.request.abort();
    active?.handle?.stop();
    active?.handle?.dispose();
    active?.lease.release();
    if (!this.disposed) this.options.onChange({ status: 'idle' });
  }

  async play(voice: CosyVoiceId): Promise<void> {
    if (this.disposed) return;
    if (!this.options.available() || !isCosyVoice(voice)) {
      this.options.onChange({ status: 'error', message: '请先应用 CosyVoice 3 朗读方式并安装本机模型，再试听音色。' });
      return;
    }
    this.stop();
    const token = this.epoch;
    const request = new AbortController();
    let lease: ExternalOutputLease | undefined;
    const valid = () => !this.disposed && this.epoch === token && !request.signal.aborted && !!lease?.isCurrent();
    try {
      const envelope = this.options.begin();
      lease = this.options.claimOutput(() => this.stop());
      if (!valid()) { request.abort(); return; }
      this.active = { request, lease };
      this.options.onChange({ status: 'loading', voice });
      const result = await this.options.request(COSY_AUDITION_TEXT, envelope, 1, request.signal, voice);
      if (!valid()) { if (!(result instanceof Blob)) void result.body.cancel().catch(() => {}); return; }
      const handle = await (this.options.playbackAdapter ?? browserPlaybackAdapter).create({
        mode: 'live', text: COSY_AUDITION_TEXT,
        ...(result instanceof Blob ? { blob: result } : { stream: result }),
        rate: 1, generatedRate: 1, volume: this.options.volume?.() ?? 0.8, signal: request.signal,
        onStarted: () => { if (valid()) this.options.onChange({ status: 'playing', voice }); },
        onBuffering: () => { if (valid()) this.options.onChange({ status: 'loading', voice }); },
        onEnded: () => { if (valid()) { this.stop(); this.options.onChange({ status: 'finished', voice }); } },
        onError: message => { if (valid()) { this.stop(); this.options.onChange({ status: 'error', voice, message }); } },
      });
      if (!valid() || !this.active) { handle.stop(); handle.dispose(); return; }
      this.active.handle = handle;
      await handle.play();
    } catch (error) {
      if (request.signal.aborted || token !== this.epoch || this.disposed) return;
      this.stop();
      this.options.onChange({ status: 'error', voice, message: error instanceof Error ? error.message : '试听未能完成，请重试。' });
    }
  }

  dispose(): void { this.disposed = true; this.stop(); }
}
