import type { PlaybackHandle, PlaybackInput } from './playback';

export type SpeechStream = { body: ReadableStream<Uint8Array>; mimeType: 'audio/mpeg' };
export function supportsStreamingPlayback(): boolean {
  return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');
}

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const APPEND_BYTES = 256 * 1024;
const BUFFER_AHEAD_SECONDS = 60;
const abortError = () => new DOMException('朗读已取消', 'AbortError');

/** A single media element owns playback; the fetch reader feeds it before EOF. */
export function createStreamPlayback(input: PlaybackInput, stream: SpeechStream): PlaybackHandle {
  if (!supportsStreamingPlayback()) throw new Error('当前浏览器不支持流式声音，请使用新版 Edge 或桌面软件。');
  if (input.signal.aborted) throw abortError();
  const media = new MediaSource();
  const url = URL.createObjectURL(media);
  const audio = new Audio(url);
  const reader = stream.body.getReader();
  const lifetime = new AbortController();
  let released = false;
  let complete = false;
  let source: SourceBuffer | undefined;
  audio.volume = input.volume;
  audio.preservesPitch = true;
  audio.playbackRate = input.rate / (input.generatedRate ?? 1);
  audio.onplaying = input.onStarted;
  audio.onwaiting = () => { if (!released && !audio.paused) input.onBuffering?.(); };

  const release = () => {
    if (released) return;
    released = true;
    lifetime.abort();
    input.signal.removeEventListener('abort', release);
    void reader.cancel().catch(() => {});
    audio.onplaying = null; audio.onwaiting = null; audio.onended = null; audio.onerror = null;
    audio.pause();
    if (source?.updating && media.readyState === 'open') { try { source.abort(); } catch { /* Already detached. */ } }
    audio.removeAttribute('src'); audio.load();
    URL.revokeObjectURL(url);
  };
  const fail = (message: string) => {
    if (released || input.signal.aborted) return;
    release();
    input.onError(message);
  };
  audio.onerror = () => fail('流式声音无法播放，请重试这句。');
  audio.onended = () => {
    if (released) return;
    if (!complete) fail('声音在生成完成前中断，阅读位置已保留，请重试这句。');
    else input.onEnded();
  };
  input.signal.addEventListener('abort', release, { once: true });

  const wait = (target: EventTarget, event: string, operation?: () => void): Promise<void> => new Promise((resolve, reject) => {
    if (lifetime.signal.aborted) { reject(abortError()); return; }
    const clean = () => { target.removeEventListener(event, success); target.removeEventListener('error', error); lifetime.signal.removeEventListener('abort', abort); };
    const success = () => { clean(); resolve(); };
    const error = () => { clean(); reject(new Error('流式声音数据无效')); };
    const abort = () => { clean(); reject(abortError()); };
    target.addEventListener(event, success, { once: true });
    target.addEventListener('error', error, { once: true });
    lifetime.signal.addEventListener('abort', abort, { once: true });
    try { operation?.(); } catch (cause) { clean(); reject(cause); }
  });
  const pump = async () => {
    if (media.readyState !== 'open') await wait(media, 'sourceopen');
    if (released) return;
    source = media.addSourceBuffer(stream.mimeType);
    let bytes = 0;
    while (!released) {
      // Bound queued media even if paused. Fetch backpressure then reaches the
      // local producer; no second player or unbounded JS chunk queue is created.
      while (source.buffered.length && source.buffered.end(source.buffered.length - 1) - audio.currentTime > BUFFER_AHEAD_SECONDS) await wait(audio, 'timeupdate');
      if (audio.currentTime > 15 && source.buffered.length && source.buffered.start(0) < audio.currentTime - 15) {
        const buffer = source;
        await wait(buffer, 'updateend', () => buffer.remove(0, audio.currentTime - 10));
      }
      const chunk = await reader.read();
      if (released) return;
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_AUDIO_BYTES) throw new Error('本句音频超过大小限制，请缩短选区后重试');
      for (let offset = 0; offset < chunk.value.byteLength; offset += APPEND_BYTES) {
        while (source.buffered.length && source.buffered.end(source.buffered.length - 1) - audio.currentTime > BUFFER_AHEAD_SECONDS) await wait(audio, 'timeupdate');
        if (released) return;
        const buffer = source;
        await wait(buffer, 'updateend', () => buffer.appendBuffer(chunk.value.slice(offset, offset + APPEND_BYTES)));
      }
    }
    if (released) return;
    if (!bytes) throw new Error('本地模型没有返回声音');
    // Every append is awaited, so endOfStream never races an updating buffer.
    if (media.readyState !== 'open') throw new Error('声音连接提前关闭');
    complete = true;
    media.endOfStream();
  };
  void pump().catch(error => fail(error instanceof Error ? `流式朗读中断：${error.message}。请重试这句。` : '流式朗读中断，请重试这句。'));
  return {
    async play() { if (!released) await audio.play(); },
    pause() { audio.pause(); },
    stop: release,
    dispose: release,
    setRate(rate) { if (!released) audio.playbackRate = rate / (input.generatedRate ?? 1); },
    setVolume(volume) { audio.volume = volume; },
  };
}
