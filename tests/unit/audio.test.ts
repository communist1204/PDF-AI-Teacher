import { describe, expect, it, vi } from 'vitest';
import { AudioCoordinator, requiresFormulaConfirmation, splitSentences, toSpeechText, type PlaybackAdapter, type PlaybackHandle, type PlaybackInput } from '../../apps/web/src/features/voice/AudioCoordinator';
import type { Envelope, PdfTarget } from '../../packages/shared/protocol';

const envelope: Envelope = { sessionId: 'test-session', generationId: 1, contextRevision: 1 };
const target: PdfTarget = { sourceId: 'source-one', documentId: 'book-one', pageIndex: 2, pageLabel: '1', blockId: 'block-one', rect: null, sourceText: '第一句。第二句。第三句。' };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(requestSpeech = vi.fn(async () => new Blob(['mock-audio']))) {
  let audible = 0;
  let maxAudible = 0;
  const handles: Array<PlaybackHandle & { input: PlaybackInput; position: number; plays: number; stopped: boolean }> = [];
  const adapter: PlaybackAdapter = {
    create(input) {
      let playing = false;
      const stopPlaying = () => { if (playing) audible -= 1; playing = false; };
      const handle = {
        input, position: 0, plays: 0, stopped: false,
        async play() {
          if (handle.stopped) return;
          if (!playing) audible += 1;
          playing = true;
          maxAudible = Math.max(maxAudible, audible);
          handle.plays += 1;
          input.onStarted();
        },
        pause() { stopPlaying(); },
        stop() { stopPlaying(); handle.stopped = true; },
        dispose() { stopPlaying(); handle.stopped = true; },
        setRate: vi.fn(), setVolume: vi.fn(),
      };
      handles.push(handle);
      return handle;
    },
  };
  const onError = vi.fn();
  const onChange = vi.fn();
  const audio = new AudioCoordinator({ requestSpeech, onChange, onError, playbackAdapter: adapter });
  audio.load(target, envelope, 'live');
  return { audio, handles, requestSpeech, onError, onChange, audible: () => audible, maxAudible: () => maxAudible };
}

describe('sentence source fidelity', () => {
  it('preserves original symbols and decimals, converts only declared pronunciations', () => {
    const text = '参数 β_1^t，值 0.9。∂L/∂w 是偏导。';
    const sentences = splitSentences(text);
    expect(sentences).toHaveLength(2);
    expect(sentences.map(value => value.sourceText).join('')).toBe(text);
    expect(sentences[0].speechText).toBe('参数 beta 一的 t 次方，值 0.9。');
    expect(sentences[1].speechText).toBe('损失 L 对参数 w 的偏导 是偏导。');
    expect(toSpeechText(String.raw`\frac{\partial L}{\partial w}`)).toBe('损失 L 对参数 w 的偏导');
    expect(requiresFormulaConfirmation('β_1^t')).toBe(false);
    expect(requiresFormulaConfirmation('x^2 + ∫f(x)dx')).toBe(true);
  });

  it('keeps IDs stable, invalidates changed text, and bounds source/speech chunks', () => {
    const text = '∂L/∂w'.repeat(600);
    const chunks = splitSentences(text);
    expect(chunks).toEqual(splitSentences(text));
    expect(chunks[0].sentenceId).not.toBe(splitSentences(text + '。')[0].sentenceId);
    expect(chunks.map(value => value.sourceText).join('')).toBe(text);
    expect(chunks.every(value => value.speechText.length <= 1000)).toBe(true);
    expect(splitSentences('   ')).toEqual([]);
  });
});

describe('AudioCoordinator (mock playback; no hardware audio claims)', () => {
  it('pauses and resumes the same audio object without losing its position', async () => {
    const h = harness();
    await h.audio.play();
    h.handles[0].position = 3.25;
    h.audio.pause();
    expect(h.audio.getSnapshot().status).toBe('paused');
    expect(h.audible()).toBe(0);
    await h.audio.resume();
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0].position).toBe(3.25);
    expect(h.handles[0].plays).toBe(2);
    expect(h.requestSpeech).toHaveBeenCalledTimes(1);
    expect(h.audio.getSnapshot().status).toBe('speaking');
    h.audio.dispose();
  });

  it('stops current audio and resumes an unfinished sentence after a new question', async () => {
    const h = harness();
    await h.audio.play();
    h.handles[0].input.onEnded();
    await tick();
    expect(h.audio.getSnapshot().sentenceIndex).toBe(1);
    h.audio.interrupt();
    const bookmark = h.audio.getSnapshot().cursor;
    expect(bookmark).toMatchObject({ documentId: 'book-one', pageIndex: 2, blockId: 'block-one', sentenceIndex: 1 });
    expect(h.audible()).toBe(0);
    h.audio.rebind({ ...envelope, generationId: 3 });
    await h.audio.resume();
    expect(h.audio.getSnapshot().cursor).toEqual(bookmark);
    expect(h.requestSpeech).toHaveBeenLastCalledWith('第二句。', { ...envelope, generationId: 3 }, 1, expect.any(AbortSignal));
    expect(h.maxAudible()).toBe(1);
    h.audio.dispose();
  });

  it('rejects late network results and propagates upstream cancellation', async () => {
    const old = deferred<Blob>();
    const requestSpeech = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(new Blob(['new']));
    const h = harness(requestSpeech);
    const pending = h.audio.play();
    const oldSignal = requestSpeech.mock.calls[0][3] as AbortSignal;
    h.audio.interrupt();
    h.audio.rebind({ ...envelope, generationId: 2 });
    await h.audio.resume();
    old.resolve(new Blob(['late']));
    await pending;
    expect(oldSignal.aborted).toBe(true);
    expect(h.handles).toHaveLength(1);
    expect(h.audio.getSnapshot().status).toBe('speaking');
    expect(h.maxAudible()).toBe(1);
    h.audio.dispose();
  });

  it('pausing pending requests prevents background playback; resume retries that sentence', async () => {
    const old = deferred<Blob>();
    const h = harness(vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(new Blob(['new'])));
    const pending = h.audio.play();
    h.audio.pause();
    old.resolve(new Blob(['late']));
    await pending;
    expect(h.handles).toHaveLength(0);
    expect(h.audio.getSnapshot().status).toBe('paused');
    await h.audio.resume();
    expect(h.handles).toHaveLength(1);
    expect(h.audio.getSnapshot().sentenceIndex).toBe(0);
    h.audio.dispose();
  });

  it('ignores late ended/error events and never overlaps on navigation', async () => {
    const h = harness();
    await h.audio.play();
    const old = h.handles[0];
    h.audio.next();
    await tick();
    old.input.onEnded();
    old.input.onError('late error');
    expect(h.audio.getSnapshot().sentenceIndex).toBe(1);
    expect(h.onError).not.toHaveBeenCalled();
    h.audio.previous();
    await tick();
    expect(h.audio.getSnapshot().sentenceIndex).toBe(0);
    expect(h.maxAudible()).toBe(1);
    h.audio.stop();
    expect(h.audible()).toBe(0);
    expect(h.audio.getSnapshot().hasBookmark).toBe(true);
    h.audio.dispose();
  });

  it('invalidates bookmarks on changed text, page, or document fingerprint', async () => {
    const h = harness();
    await h.audio.play();
    h.audio.next();
    await tick();
    const cursor = h.audio.getSnapshot().cursor;
    h.audio.load({ ...target }, envelope, 'live');
    expect(h.audio.getSnapshot().cursor).toEqual(cursor);
    h.audio.load({ ...target, sourceText: '修改后的第一句。' }, envelope, 'live');
    expect(h.audio.getSnapshot()).toMatchObject({ sentenceIndex: 0, hasBookmark: false, cursor: null });
    await h.audio.play();
    expect(h.audio.getSnapshot().cursor?.textVersion).not.toBe(cursor?.textVersion);
    h.audio.load({ ...target, pageIndex: 8 }, envelope, 'live');
    expect(h.audio.getSnapshot().hasBookmark).toBe(false);
    await h.audio.play();
    h.audio.load({ ...target, documentId: 'same-name-different-content' }, envelope, 'live');
    expect(h.audio.getSnapshot().cursor).toBeNull();
    expect(h.audible()).toBe(0);
    h.audio.dispose();
  });

  it('does not count buffering/errors as read progress or retry failures automatically', async () => {
    const h = harness(vi.fn().mockRejectedValue(new Error('网络连接失败')));
    await h.audio.play();
    expect(h.audio.getSnapshot()).toMatchObject({ status: 'silent', sentenceIndex: 0, hasBookmark: true });
    expect(h.audio.getSnapshot().error).toContain('网络连接失败');
    expect(h.requestSpeech).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenCalledOnce();
    h.audio.dispose();
  });

  it('uses no paid request in demo and only clears bookmarks after all sentences ended', async () => {
    const h = harness();
    h.audio.load(target, envelope, 'demo');
    await h.audio.play();
    h.audio.setRate(1.5);
    h.audio.setVolume(0.4);
    for (let index = 0; index < 3; index += 1) { h.handles[index].input.onEnded(); await tick(); }
    expect(h.requestSpeech).not.toHaveBeenCalled();
    expect(h.audio.getSnapshot()).toMatchObject({ status: 'silent', hasBookmark: false, cursor: null });
    expect(h.handles[1].input).toMatchObject({ rate: 1.5, volume: 0.4 });
    expect(h.maxAudible()).toBe(1);
    h.audio.dispose();
  });

  it('disposes late adapter handles without playing after document reset', async () => {
    const late = deferred<PlaybackHandle>();
    const handle = { play: vi.fn(async () => {}), pause: vi.fn(), stop: vi.fn(), dispose: vi.fn(), setRate: vi.fn(), setVolume: vi.fn() };
    const audio = new AudioCoordinator({ requestSpeech: vi.fn(), onError: vi.fn(), onChange: vi.fn(), playbackAdapter: { create: () => late.promise } });
    audio.load(target, envelope, 'demo');
    const pending = audio.play();
    audio.reset();
    late.resolve(handle);
    await pending;
    expect(handle.play).not.toHaveBeenCalled();
    expect(handle.dispose).toHaveBeenCalled();
    expect(audio.getSnapshot()).toMatchObject({ sentences: [], cursor: null, hasBookmark: false });
    audio.dispose();
  });
});
// These adapter checks use fake browser objects, never a real speaker.
describe('browser adapter capability boundaries', () => {
  it('rejects remote-only voices instead of silently sending demo text off-device', async () => {
    vi.useFakeTimers();
    const events = new EventTarget();
    const synth = {
      getVoices: () => [{ localService: false, lang: 'zh-CN', name: 'remote' }],
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      speak: vi.fn(), resume: vi.fn(), pause: vi.fn(), cancel: vi.fn(),
    };
    vi.stubGlobal('window', { speechSynthesis: synth });
    vi.stubGlobal('SpeechSynthesisUtterance', class {});
    try {
      const { browserPlaybackAdapter } = await import('../../apps/web/src/features/voice/playback');
      const pending = browserPlaybackAdapter.create({ mode: 'demo', text: '本机测试', rate: 1, volume: 1, signal: new AbortController().signal, onStarted: vi.fn(), onEnded: vi.fn(), onError: vi.fn() });
      const assertion = expect(pending).rejects.toThrow('未找到可用的本机语音');
      await vi.advanceTimersByTimeAsync(1800);
      await assertion;
      expect(synth.speak).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
  });

  it('marks demo speaking only after start and clears start timeout even for immediate events', async () => {
    vi.useFakeTimers();
    const events = new EventTarget();
    const local = { localService: true, lang: 'zh-CN', name: 'local' };
    const synth = {
      getVoices: () => [local],
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      speak: vi.fn((utterance: { onstart?: () => void }) => utterance.onstart?.()),
      resume: vi.fn(), pause: vi.fn(), cancel: vi.fn(),
    };
    vi.stubGlobal('window', { speechSynthesis: synth });
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
    try {
      const { browserPlaybackAdapter } = await import('../../apps/web/src/features/voice/playback');
      const onStarted = vi.fn();
      const onError = vi.fn();
      const handle = await browserPlaybackAdapter.create({ mode: 'demo', text: '本机测试', rate: 1, volume: 1, signal: new AbortController().signal, onStarted, onEnded: vi.fn(), onError });
      expect(onStarted).not.toHaveBeenCalled();
      await handle.play();
      expect(onStarted).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(9000);
      expect(onError).not.toHaveBeenCalled();
      handle.pause();
      expect(synth.pause).toHaveBeenCalledOnce();
      handle.stop();
      handle.dispose();
      expect(synth.cancel).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
});
