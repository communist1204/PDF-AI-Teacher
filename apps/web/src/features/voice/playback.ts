export type PlaybackInput = {
  mode: 'demo' | 'live';
  text: string;
  blob?: Blob;
  rate: number;
  generatedRate?: number;
  volume: number;
  signal: AbortSignal;
  onStarted: () => void;
  onEnded: () => void;
  onError: (message: string) => void;
};

export interface PlaybackHandle {
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  dispose(): void;
  /** Updates fixed-rate media in place; system/cloud changes may require a new sentence. */
  setRate(rate: number): void;
  setVolume(volume: number): void;
}

export interface PlaybackAdapter {
  create(input: PlaybackInput): PlaybackHandle | Promise<PlaybackHandle>;
}

function abortError() { return new DOMException('朗读已取消', 'AbortError'); }

async function localVoice(synth: SpeechSynthesis, signal: AbortSignal, text: string): Promise<SpeechSynthesisVoice> {
  const pick = () => {
    const voices = synth.getVoices().filter(voice => voice.localService);
    const chinese = /[\u3400-\u9fff]/u.test(text);
    return chinese ? voices.find(voice => /^zh(?:-|_)/i.test(voice.lang)) : voices.find(voice => /^en(?:-|_)/i.test(voice.lang)) ?? voices[0];
  };
  if (signal.aborted) throw abortError();
  const existing = pick();
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      synth.removeEventListener('voiceschanged', changed);
      signal.removeEventListener('abort', cancelled);
    };
    const changed = () => { const voice = pick(); if (voice) { cleanup(); resolve(voice); } };
    const cancelled = () => { cleanup(); reject(abortError()); };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('未找到可用的本机语音。请在 Windows 安装对应语言的语音包后重新打开浏览器，或配置真实 TTS。演示模式不会调用远程语音。'));
    }, 1800);
    synth.addEventListener('voiceschanged', changed);
    signal.addEventListener('abort', cancelled, { once: true });
    changed();
  });
}

/** Only this adapter touches browser audio. Tests replace it without pretending to hear audio. */
export const browserPlaybackAdapter: PlaybackAdapter = {
  async create(input) {
    if (input.signal.aborted) throw abortError();
    if (input.mode === 'live') {
      if (!input.blob) throw new Error('未收到可播放的语音文件，请重试。');
      const url = URL.createObjectURL(input.blob);
      const audio = new Audio(url);
      let released = false;
      audio.volume = input.volume;
      // Cloud clips use input.rate; local clips retain 1x synthesis for pitch-preserving playback.
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
    if (typeof window === 'undefined' || !window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
      throw new Error('此浏览器不支持本机语音演示。请使用 Edge / Chrome，或配置真实 TTS。');
    }
    const synth = window.speechSynthesis;
    const voice = await localVoice(synth, input.signal, input.text);
    if (input.signal.aborted) throw abortError();
    const utterance = new SpeechSynthesisUtterance(input.text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = input.rate;
    utterance.volume = input.volume;
    let started = false;
    let stopped = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const clearWatchdog = () => { if (watchdog) clearTimeout(watchdog); watchdog = undefined; };
    utterance.onstart = () => { clearWatchdog(); if (!stopped) input.onStarted(); };
    utterance.onresume = () => { if (!stopped) input.onStarted(); };
    utterance.onend = () => { clearWatchdog(); if (!stopped) input.onEnded(); };
    utterance.onerror = event => {
      clearWatchdog();
      if (!stopped && event.error !== 'canceled' && event.error !== 'interrupted') input.onError(`本机合成语音失败（${event.error}），请重试或检查系统语音包。`);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearWatchdog();
      utterance.onstart = null; utterance.onresume = null; utterance.onend = null; utterance.onerror = null;
      if (started) synth.cancel();
    };
    return {
      async play() {
        if (stopped) return;
        if (started) { synth.resume(); return; }
        started = true;
        // Previous utterances are cancelled by the coordinator before this point.
        synth.resume();
        watchdog = setTimeout(() => { if (!stopped) input.onError('本机语音未能开始。请检查浏览器播放权限及系统语音包后重试。'); }, 8000);
        synth.speak(utterance);
      },
      pause() { clearWatchdog(); synth.pause(); },
      stop,
      dispose: stop,
      // Rate is set before play; changing an active sentence is handled by the coordinator.
      // Some OS engines apply volume changes only from the next sentence.
      setRate(rate) { utterance.rate = rate; },
      setVolume(volume) { utterance.volume = volume; },
    };
  },
};
