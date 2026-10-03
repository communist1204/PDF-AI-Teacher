import { createStreamPlayback, type SpeechStream } from './streamPlayback';

export type PlaybackInput = {
  mode: 'demo' | 'live';
  text: string;
  blob?: Blob;
  stream?: SpeechStream;
  rate: number;
  generatedRate?: number;
  volume: number;
  signal: AbortSignal;
  onStarted: () => void;
  onBuffering?: () => void;
  onEnded: () => void;
  onError: (message: string) => void;
};

export interface PlaybackHandle {
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  dispose(): void;
  /** Updates fixed-rate media in place; some providers may require a new sentence. */
  setRate(rate: number): void;
  setVolume(volume: number): void;
}

export interface PlaybackAdapter {
  create(input: PlaybackInput): PlaybackHandle | Promise<PlaybackHandle>;
}

function abortError() { return new DOMException('朗读已取消', 'AbortError'); }

/** Only this adapter touches browser audio. Tests replace it without pretending to hear audio. */
export const browserPlaybackAdapter: PlaybackAdapter = {
  async create(input) {
    if (input.signal.aborted) throw abortError();
    if (input.mode === 'live') {
      if (input.stream) return createStreamPlayback(input, input.stream);
      if (!input.blob) throw new Error('未收到可播放的语音文件，请重试。');
      const url = URL.createObjectURL(input.blob);
      const audio = new Audio(url);
      let released = false;
      audio.volume = input.volume;
      // Fixed-rate clips retain pitch while playback speed changes in place.
      audio.preservesPitch = true;
      audio.playbackRate = input.rate / (input.generatedRate ?? input.rate);
      audio.onplaying = input.onStarted;
      audio.onended = input.onEnded;
      audio.onerror = () => input.onError('语音文件无法播放，请检查浏览器音频权限或重试。');
      const release = () => {
        if (released) return;
        released = true;
        audio.onplaying = null; audio.onended = null; audio.onerror = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        URL.revokeObjectURL(url);
      };
      return {
        async play() { if (!released) await audio.play(); },
        pause() { audio.pause(); },
        stop: release,
        dispose: release,
        // Updating playbackRate preserves currentTime and does not resume paused audio.
        setRate(rate) { if (!released) audio.playbackRate = rate / (input.generatedRate ?? input.rate); },
        setVolume(volume) { audio.volume = volume; },
      };
    }
    throw new Error('系统语音已移除，请在声音设置中配置在线朗读。');
  },
};
