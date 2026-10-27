import { describe, expect, it, vi } from 'vitest';
import { ReaderAudio, type AudioDevice, type AudioState } from '../../apps/web/src/ReaderAudio';
import type { SpeechRequest, SpeechResult } from '../../packages/shared/reader';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup() {
  const pending: { request: SpeechRequest; resolve(value: SpeechResult): void; reject(error: Error): void }[] = [];
  const bridge = {
    cancel: vi.fn(async () => {}), beginSpeech: vi.fn(async (_id: string) => {}),
    speak: vi.fn((request: SpeechRequest) => new Promise<SpeechResult>((resolve, reject) => pending.push({ request, resolve, reject }))),
  };
  const audio: AudioDevice = { src: '', playbackRate: 1, currentTime: 0, onended: null, onerror: null, play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn() };
  const revokeUrl = vi.fn(), createUrl = vi.fn(() => `blob:${createUrl.mock.calls.length}`);
  let identity = 0;
  const player = new ReaderAudio(bridge, { audio, revokeUrl, createUrl, id: () => `reading-${++identity}` });
  let state: AudioState = { phase: 'idle', total: 0, index: 0, message: '' };
  player.subscribe(value => { state = value; });
  const resolve = (n: number) => pending[n].resolve({ ...pending[n].request, audio: new Uint8Array([1, 2]) });
  return { bridge, audio, pending, player, resolve, state: () => state, createUrl, revokeUrl };
}

describe('reader playback (simulated audio, no live TTS)', () => {
  it('prefetches at most two concurrent requests and only two chunks ahead', async () => {
    const s = setup(); const started = s.player.start(['一。', '二。', '三。', '四。', '五。']); await settle();
    expect(s.bridge.speak).toHaveBeenCalledTimes(2);
    s.resolve(0); await settle(); expect(s.bridge.speak).toHaveBeenCalledTimes(3); expect(s.state().phase).toBe('playing');
    s.resolve(1); s.resolve(2); await settle(); expect(s.bridge.speak).toHaveBeenCalledTimes(3);
    s.audio.onended?.(new Event('ended')); await settle(); expect(s.bridge.speak).toHaveBeenCalledTimes(4); expect(s.state().index).toBe(1);
    await started;
  });
  it('changes current playback speed in place without resetting time or synthesizing again', async () => {
    const s = setup(); const started = s.player.start(['一。']); await settle(); s.resolve(0); await started;
    s.audio.currentTime = 4.5; const calls = s.bridge.speak.mock.calls.length;
    s.player.setRate(2.5); expect(s.audio.playbackRate).toBe(2.5); expect(s.audio.currentTime).toBe(4.5); expect(s.bridge.speak).toHaveBeenCalledTimes(calls);
  });
  it('honors pause requested while waiting for the first voice', async () => {
    const s = setup(); const started = s.player.start(['一。']); await settle(); s.player.togglePause();
    s.resolve(0); await started; expect(s.audio.play).not.toHaveBeenCalled(); expect(s.state().phase).toBe('paused');
    s.player.togglePause(); await settle(); expect(s.audio.play).toHaveBeenCalledOnce(); expect(s.state().phase).toBe('playing');
  });
  it('continues at the same audio time after pause and resume', async () => {
    const s = setup(); const started = s.player.start(['一。']); await settle(); s.resolve(0); await started;
    s.audio.currentTime = 3.2; s.player.togglePause(); s.player.togglePause(); await settle();
    expect(s.audio.currentTime).toBe(3.2); expect(s.bridge.speak).toHaveBeenCalledOnce();
  });
  it('treats a play promise aborted by pause as a pause, even after immediate resume', async () => {
    const s = setup(); let rejectPlay!: (error: Error) => void;
    vi.mocked(s.audio.play).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject; }));
    const started = s.player.start(['一。']); await settle(); s.resolve(0); await settle();
    s.player.togglePause(); s.player.togglePause(); await settle();
    rejectPlay(new DOMException('Paused', 'AbortError')); await started;
    expect(s.state().phase).toBe('playing'); expect(s.bridge.cancel).toHaveBeenCalledOnce();
  });
  it('discards late results after stop without creating a URL or restarting playback', async () => {
    const s = setup(); const started = s.player.start(['旧内容。']); await settle(); await s.player.stop(); s.resolve(0); await started;
    expect(s.audio.play).not.toHaveBeenCalled(); expect(s.createUrl).not.toHaveBeenCalled(); expect(s.state().phase).toBe('idle');
  });
  it('does not resurrect a start waiting for cancellation after a second stop', async () => {
    const s = setup(); let finish!: () => void;
    s.bridge.cancel.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const started = s.player.start(['旧内容。']); await s.player.stop(); finish(); await started;
    expect(s.bridge.beginSpeech).not.toHaveBeenCalled();
  });
  it('rejects mismatched generation responses', async () => {
    const s = setup(); const started = s.player.start(['一。']); await settle();
    s.pending[0].resolve({ generationId: 'another', chunkId: 0, audio: new Uint8Array([1]) }); await started;
    expect(s.state().phase).toBe('error'); expect(s.audio.play).not.toHaveBeenCalled();
  });
  it('moves to prefetched speech and ends without another output owner', async () => {
    const s = setup(); const started = s.player.start(['一。', '二。']); await settle(); s.resolve(1); s.resolve(0); await started;
    const first = s.audio.src; s.audio.onended?.(new Event('ended')); await settle(); expect(s.audio.src).not.toBe(first); expect(s.revokeUrl).toHaveBeenCalledWith(first);
    s.audio.onended?.(new Event('ended')); await settle(); expect(s.state().phase).toBe('done'); expect(s.revokeUrl).toHaveBeenCalledTimes(2);
  });
  it('reports an upstream error and cancels without an automatic retry', async () => {
    const s = setup(); const started = s.player.start(['一。']); await settle(); s.pending[0].reject(Error('额度不足')); await started;
    expect(s.state()).toMatchObject({ phase: 'error', message: '额度不足' }); expect(s.bridge.speak).toHaveBeenCalledOnce();
  });
});

