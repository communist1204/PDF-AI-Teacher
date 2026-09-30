import { describe, expect, it, vi } from 'vitest';
import { AudioCoordinator, requiresFormulaConfirmation, splitSentences, toSpeechText, type PlaybackAdapter, type PlaybackHandle, type PlaybackInput, type AudioCoordinatorOptions } from '../../apps/web/src/features/voice/AudioCoordinator';
import type { Envelope, PdfTarget, TeachingStep } from '../../packages/shared/protocol';

const envelope: Envelope = { sessionId: 'test-session', generationId: 1, contextRevision: 1 };
const target: PdfTarget = { sourceId: 'source-one', documentId: 'book-one', pageIndex: 2, pageLabel: '1', blockId: 'block-one', rect: null, sourceText: '第一句。第二句。第三句。' };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(requestSpeech: ReturnType<typeof vi.fn<AudioCoordinatorOptions['requestSpeech']>> = vi.fn(async () => new Blob(['mock-audio'])), options: Partial<AudioCoordinatorOptions> = {}) {
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
  const onComplete = vi.fn();
  const audio = new AudioCoordinator({ requestSpeech, onChange, onError, onComplete, playbackAdapter: adapter, ...options });
  audio.load(target, envelope, 'live');
  return { audio, handles, requestSpeech, onError, onChange, onComplete, audible: () => audible, maxAudible: () => maxAudible };
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
    h.audio.setRate(1.5);
    await h.audio.play();
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

describe('pause during unresolved browser play()', () => {
  const makeRace = () => {
    const attempts: Array<ReturnType<typeof deferred<void>>> = [];
    let input: PlaybackInput;
    const handle = {
      play: vi.fn(() => { const attempt = deferred<void>(); attempts.push(attempt); return attempt.promise; }),
      pause: vi.fn(), stop: vi.fn(), dispose: vi.fn(), setRate: vi.fn(), setVolume: vi.fn(),
    };
    const onError = vi.fn();
    const audio = new AudioCoordinator({ requestSpeech: vi.fn(), onChange: vi.fn(), onError, playbackAdapter: { create: value => { input = value; return handle; } } });
    audio.load(target, envelope, 'demo');
    return { audio, attempts, handle, onError, started: () => input.onStarted() };
  };

  it('keeps the paused handle when pause aborts the initial play promise', async () => {
    const h = makeRace();
    const pending = h.audio.play();
    await tick();
    h.audio.pause();
    h.attempts[0].reject(new DOMException('play interrupted by pause', 'AbortError'));
    await pending;
    expect(h.audio.getSnapshot()).toMatchObject({ status: 'paused', hasBookmark: true, sentenceIndex: 0 });
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.handle.dispose).not.toHaveBeenCalled();
    const resumed = h.audio.resume();
    h.started(); h.attempts[1].resolve();
    await resumed;
    expect(h.audio.getSnapshot().status).toBe('speaking');
    expect(h.handle.play).toHaveBeenCalledTimes(2);
    h.audio.dispose();
  });

  it('does not let a paused resume reject after a newer resume and stop that output', async () => {
    const h = makeRace();
    const initial = h.audio.play();
    await tick();
    h.started(); h.attempts[0].resolve();
    await initial;
    h.audio.pause();
    const oldResume = h.audio.resume();
    h.audio.pause();
    const latestResume = h.audio.resume();
    h.started(); h.attempts[2].resolve();
    await latestResume;
    h.attempts[1].reject(new DOMException('old play interrupted by pause', 'AbortError'));
    await oldResume;
    expect(h.audio.getSnapshot().status).toBe('speaking');
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.handle.dispose).not.toHaveBeenCalled();
    expect(h.handle.play).toHaveBeenCalledTimes(3);
    h.audio.dispose();
  });
});

const explanationStep: TeachingStep = { stepId: 'step-one', title: '说明符号', speechText: '这是第一句讲解。这是第二句讲解。', explanationMarkdown: '这是补充解释。', boardBlocks: [], sourceIds: [target.sourceId], exampleOrigin: 'none' };

describe('M2 separate source and explanation playback (mock audio)', () => {
  it('preserves original reading through explanations, repeated interruptions and a question', async () => {
    const h = harness();
    await h.audio.play();
    h.handles[0].input.onEnded();
    await tick();
    const source = h.audio.getBookmark();
    expect(source?.cursor.sentenceIndex).toBe(1);
    h.audio.loadExplanation(target, explanationStep, { ...envelope, generationId: 2 }, 'live');
    expect(h.audible()).toBe(0);
    expect(h.audio.getBookmark()).toEqual(source);
    await h.audio.play();
    h.handles[2].input.onEnded();
    await tick();
    expect(h.audio.getSnapshot()).toMatchObject({ channel: 'explanation', teachingStepId: 'step-one', sentenceIndex: 1 });
    const explanation = h.audio.getExplanationBookmark();
    for (let generationId = 3; generationId <= 12; generationId += 1) {
      h.audio.interrupt();
      h.audio.rebind({ ...envelope, generationId });
      await h.audio.resume();
      expect(h.requestSpeech).toHaveBeenLastCalledWith('这是第二句讲解。', { ...envelope, generationId }, 1, expect.any(AbortSignal));
      expect(h.audio.getBookmark()).toEqual(source);
    }
    h.audio.interrupt();
    h.audio.loadExplanation(target, { ...explanationStep, stepId: 'question-step', speechText: '这是追问的回答。' }, { ...envelope, generationId: 13 }, 'live');
    await h.audio.play();
    h.handles.at(-1)!.input.onEnded();
    expect(h.onComplete).toHaveBeenLastCalledWith({ channel: 'explanation', stepId: 'question-step', envelope: { ...envelope, generationId: 13 } });
    expect(h.audio.getBookmark()).toEqual(source);
    expect(h.audio.restoreExplanationBookmark(explanation!, { ...envelope, generationId: 14 }, 'live')).toBe(true);
    expect(h.audible()).toBe(0);
    await h.audio.resume();
    expect(h.requestSpeech).toHaveBeenLastCalledWith('这是第二句讲解。', { ...envelope, generationId: 14 }, 1, expect.any(AbortSignal));
    h.handles.at(-1)!.input.onEnded();
    expect(h.audio.getBookmark()).toEqual(source);
    await h.audio.resumeSource({ ...envelope, generationId: 15 }, 'live');
    expect(h.requestSpeech).toHaveBeenLastCalledWith('第二句。', { ...envelope, generationId: 15 }, 1, expect.any(AbortSignal));
    expect(h.audio.getSnapshot()).toMatchObject({ channel: 'source', teachingStepId: null, sentenceIndex: 1 });
    expect(h.maxAudible()).toBe(1);
    expect(h.onComplete).toHaveBeenCalledTimes(2);
    h.audio.dispose();
  });

  it('restores persisted original bookmarks without autoplay and checks every identity component', async () => {
    const h = harness();
    h.audio.next();
    const bookmark = h.audio.getBookmark()!;
    h.audio.reset();
    expect(h.audio.restoreBookmark(JSON.parse(JSON.stringify(bookmark)), { ...envelope, generationId: 5 }, 'live')).toBe(true);
    expect(h.audio.getSnapshot()).toMatchObject({ status: 'silent', sentenceIndex: 1, channel: 'source' });
    expect(h.requestSpeech).not.toHaveBeenCalled();
    expect(h.handles).toHaveLength(0);
    for (const wrong of [
      { documentId: 'another-book' }, { pageIndex: 99 }, { blockId: 'other-block' }, { sentenceId: 'unknown' }, { textVersion: 'old-segmentation' }, { sentenceIndex: 999 }, { sentenceIndex: 0.5 },
    ]) {
      expect(h.audio.restoreBookmark({ ...bookmark, cursor: { ...bookmark.cursor, ...wrong } }, envelope, 'live')).toBe(false);
      expect(h.audio.getBookmark()).toEqual(bookmark);
    }
    expect(h.audio.restoreBookmark({ ...bookmark, target: { ...bookmark.target, sourceText: '文字已修正。' } }, envelope, 'live')).toBe(false);
    const exposed = h.audio.getBookmark()!;
    exposed.cursor.sentenceIndex = 0;
    exposed.target.sourceText = '外部修改';
    expect(h.audio.getBookmark()).toEqual(bookmark);
    await h.audio.resumeSource({ ...envelope, generationId: 6 }, 'live');
    expect(h.requestSpeech).toHaveBeenLastCalledWith('第二句。', { ...envelope, generationId: 6 }, 1, expect.any(AbortSignal));
    h.audio.load({ ...target, documentId: 'same-name-different-book' }, envelope, 'live');
    expect(h.audio.restoreBookmark(bookmark, envelope, 'live')).toBe(false);
    expect(h.audio.getBookmark()).toBeNull();
    h.audio.dispose();
  });

  it('keeps paused source audio at its actual position on resumeSource with the same envelope', async () => {
    const h = harness();
    await h.audio.play();
    h.handles[0].position = 7.5;
    h.audio.pause();
    await h.audio.resumeSource(envelope, 'live');
    expect(h.handles).toHaveLength(1);
    expect(h.handles[0].position).toBe(7.5);
    expect(h.handles[0].plays).toBe(2);
    h.audio.dispose();
  });

  it('reloads the same teaching speech at the unfinished sentence and rejects changed saved speech', async () => {
    const h = harness();
    h.audio.loadExplanation(target, explanationStep, envelope, 'demo');
    await h.audio.play();
    h.handles[0].input.onEnded();
    await tick();
    const bookmark = h.audio.getExplanationBookmark()!;
    h.audio.loadExplanation(target, explanationStep, { ...envelope, generationId: 2 }, 'live');
    expect(h.audio.getSnapshot()).toMatchObject({ status: 'silent', sentenceIndex: 1, hasBookmark: true });
    expect(h.audio.getBookmark()).toBeNull();
    expect(h.audio.restoreExplanationBookmark({ ...bookmark, speechText: '已变更的讲解。' }, envelope, 'live')).toBe(false);
    expect(h.audio.restoreExplanationBookmark({ ...bookmark, sentenceId: 'wrong' }, envelope, 'live')).toBe(false);
    expect(h.audio.restoreExplanationBookmark({ ...bookmark, sentenceIndex: 99 }, envelope, 'live')).toBe(false);
    await h.audio.play();
    expect(h.requestSpeech).toHaveBeenLastCalledWith('这是第二句讲解。', { ...envelope, generationId: 2 }, 1, expect.any(AbortSignal));
    expect(h.maxAudible()).toBe(1);
    h.audio.loadExplanation(target, { ...explanationStep, speechText: '更新后的讲解。' }, envelope, 'live');
    expect(h.audio.getSnapshot()).toMatchObject({ sentenceIndex: 0, hasBookmark: false });
    h.audio.dispose();
  });

  it('completes a channel once, only after all actual endings, without marking original text as read', async () => {
    const h = harness();
    await h.audio.play();
    const bookmark = h.audio.getBookmark();
    h.audio.loadExplanation(target, explanationStep, envelope, 'live');
    await h.audio.play();
    const firstExplanation = h.handles[1];
    firstExplanation.input.onEnded();
    await tick();
    expect(h.onComplete).not.toHaveBeenCalled();
    const lastExplanation = h.handles[2];
    lastExplanation.input.onEnded();
    lastExplanation.input.onEnded();
    expect(h.onComplete).toHaveBeenCalledExactlyOnceWith({ channel: 'explanation', stepId: 'step-one', envelope });
    expect(h.audio.getBookmark()).toEqual(bookmark);
    expect(h.audio.getExplanationBookmark()).toBeNull();
    await h.audio.resumeSource({ ...envelope, generationId: 2 }, 'live');
    for (let index = 3; index <= 5; index += 1) { h.handles[index].input.onEnded(); await tick(); }
    expect(h.onComplete).toHaveBeenCalledTimes(2);
    expect(h.onComplete).toHaveBeenLastCalledWith({ channel: 'source', stepId: null, envelope: { ...envelope, generationId: 2 } });
    expect(h.audio.getBookmark()).toBeNull();
    h.audio.dispose();
  });

  it('suppresses late completion after interrupt, reset, revision changes and pending channel switches', async () => {
    const pendingSpeech = deferred<Blob>();
    const requestSpeech = vi.fn().mockImplementationOnce(() => pendingSpeech.promise).mockResolvedValue(new Blob(['audio']));
    const h = harness(requestSpeech);
    const pending = h.audio.play();
    const signal = requestSpeech.mock.calls[0][3] as AbortSignal;
    h.audio.loadExplanation(target, { ...explanationStep, speechText: '讲解。' }, { ...envelope, generationId: 2 }, 'live');
    await h.audio.play();
    pendingSpeech.resolve(new Blob(['stale original']));
    await pending;
    expect(signal.aborted).toBe(true);
    expect(h.handles).toHaveLength(1);
    for (const invalidate of [() => h.audio.interrupt(), () => h.audio.rebind({ ...envelope, generationId: 3 }), () => h.audio.reset()]) {
      const old = h.handles.at(-1)!;
      invalidate();
      old.input.onEnded();
      old.input.onError('stale');
      expect(h.onComplete).not.toHaveBeenCalled();
      expect(h.onError).not.toHaveBeenCalled();
      if (h.audio.getSnapshot().sentences.length) await h.audio.resume();
    }
    expect(h.maxAudible()).toBe(1);
    h.audio.dispose();
  });

  it('ignores an ending before playback starts or while paused', async () => {
    let input!: PlaybackInput;
    const handle: PlaybackHandle = { play: vi.fn(async () => {}), pause: vi.fn(), stop: vi.fn(), dispose: vi.fn(), setRate: vi.fn(), setVolume: vi.fn() };
    const onComplete = vi.fn();
    const audio = new AudioCoordinator({ requestSpeech: vi.fn(), onChange: vi.fn(), onError: vi.fn(), onComplete, playbackAdapter: { create: value => { input = value; return handle; } } });
    audio.load({ ...target, sourceText: '单句。' }, envelope, 'demo');
    await audio.play();
    input.onEnded();
    expect(onComplete).not.toHaveBeenCalled();
    input.onStarted();
    audio.pause();
    input.onEnded();
    expect(onComplete).not.toHaveBeenCalled();
    await audio.resume();
    input.onStarted();
    input.onEnded();
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({ channel: 'source', stepId: null, envelope });
    audio.dispose();
  });
});

describe('M3 external output ownership (mock transport; no realtime API)', () => {
  it('silences local playback before granting remote output and preserves both bookmarks', async () => {
    const h = harness();
    await h.audio.play();
    h.handles[0].input.onEnded();
    await tick();
    const sourceBookmark = h.audio.getBookmark();
    h.audio.loadExplanation(target, explanationStep, envelope, 'live');
    await h.audio.play();
    h.handles[2].input.onEnded();
    await tick();
    const explanationBookmark = h.audio.getExplanationBookmark();
    const oldHandle = h.handles[3];
    let remoteAudible = false;
    const stopRemote = vi.fn(() => { remoteAudible = false; });
    const lease = h.audio.claimExternalOutput(stopRemote);
    expect(lease.isCurrent()).toBe(true);
    expect(h.audible()).toBe(0);
    expect(oldHandle.stopped).toBe(true);
    expect(remoteAudible).toBe(false);
    remoteAudible = lease.isCurrent();
    expect(remoteAudible).toBe(true);
    expect(h.audio.getSnapshot()).toMatchObject({ outputOwner: 'realtime', status: 'silent', channel: 'explanation', sentenceIndex: 1 });
    expect(h.audio.getBookmark()).toEqual(sourceBookmark);
    expect(h.audio.getExplanationBookmark()).toEqual(explanationBookmark);
    oldHandle.input.onStarted();
    oldHandle.input.onEnded();
    oldHandle.input.onError('stale local output');
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onComplete).not.toHaveBeenCalled();
    expect(h.audio.getExplanationBookmark()).toEqual(explanationBookmark);
    await h.audio.resume();
    expect(remoteAudible).toBe(false);
    expect(lease.isCurrent()).toBe(false);
    expect(stopRemote).toHaveBeenCalledOnce();
    expect(h.audible()).toBe(1);
    expect(h.audio.getSnapshot()).toMatchObject({ outputOwner: 'local', channel: 'explanation', sentenceIndex: 1 });
    expect(h.requestSpeech).toHaveBeenLastCalledWith('这是第二句讲解。', envelope, 1, expect.any(AbortSignal));
    expect(h.audio.getBookmark()).toEqual(sourceBookmark);
    expect(h.maxAudible()).toBe(1);
    h.audio.dispose();
  });

  it('aborts pending TTS and rejects its late audio after external ownership begins', async () => {
    const response = deferred<Blob>();
    const requestSpeech = vi.fn().mockImplementation(() => response.promise);
    const h = harness(requestSpeech);
    const pending = h.audio.play();
    const signal = requestSpeech.mock.calls[0][3] as AbortSignal;
    const bookmark = h.audio.getBookmark();
    const stopRemote = vi.fn();
    const lease = h.audio.claimExternalOutput(stopRemote);
    expect(signal.aborted).toBe(true);
    response.resolve(new Blob(['late paid audio']));
    await pending;
    expect(h.handles).toHaveLength(0);
    expect(lease.isCurrent()).toBe(true);
    expect(h.audio.getBookmark()).toEqual(bookmark);
    lease.release();
    lease.release();
    expect(stopRemote).toHaveBeenCalledOnce();
    expect(h.requestSpeech).toHaveBeenCalledOnce();
    expect(h.audio.getSnapshot()).toMatchObject({ outputOwner: 'local', status: 'silent' });
    h.audio.dispose();
  });

  it('disposes an adapter that finishes connecting after an external lease was claimed', async () => {
    const lateHandle = deferred<PlaybackHandle>();
    const handle = { play: vi.fn(async () => {}), pause: vi.fn(), stop: vi.fn(), dispose: vi.fn(), setRate: vi.fn(), setVolume: vi.fn() };
    const audio = new AudioCoordinator({ requestSpeech: vi.fn(), onChange: vi.fn(), onError: vi.fn(), playbackAdapter: { create: () => lateHandle.promise } });
    audio.load(target, envelope, 'demo');
    const pending = audio.play();
    const lease = audio.claimExternalOutput(vi.fn());
    lateHandle.resolve(handle);
    await pending;
    expect(handle.play).not.toHaveBeenCalled();
    expect(handle.stop).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(lease.isCurrent()).toBe(true);
    audio.dispose();
  });

  it('revokes a previous lease before returning another and ignores stale release callbacks', () => {
    const h = harness();
    const stops: string[] = [];
    const first = h.audio.claimExternalOutput(() => { stops.push('first'); first.release(); });
    const second = h.audio.claimExternalOutput(() => { stops.push('second'); second.release(); });
    expect(stops).toEqual(['first']);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    first.release();
    expect(second.isCurrent()).toBe(true);
    expect(stops).toEqual(['first']);
    second.release();
    second.release();
    expect(stops).toEqual(['first', 'second']);
    expect(h.audio.getSnapshot()).toMatchObject({ outputOwner: 'local', status: 'silent' });
    expect(h.handles).toHaveLength(0);
    h.audio.dispose();
  });

  it.each(['pause', 'stop', 'interrupt', 'reset', 'dispose', 'previous', 'next'] as const)('%s immediately revokes external output without autoplay', async action => {
    const h = harness();
    await h.audio.play();
    const bookmark = h.audio.getBookmark();
    const stopRemote = vi.fn();
    const lease = h.audio.claimExternalOutput(stopRemote);
    const requests = h.requestSpeech.mock.calls.length;
    h.audio[action]();
    expect(lease.isCurrent()).toBe(false);
    expect(stopRemote).toHaveBeenCalledOnce();
    expect(h.audible()).toBe(0);
    expect(h.requestSpeech).toHaveBeenCalledTimes(requests);
    expect(h.audio.getSnapshot().outputOwner).toBe('local');
    if (action === 'pause' || action === 'stop' || action === 'interrupt') expect(h.audio.getBookmark()).toEqual(bookmark);
    lease.release();
    expect(stopRemote).toHaveBeenCalledOnce();
    h.audio.dispose();
  });

  it.each(['play', 'resume', 'resumeSource'] as const)('%s explicitly takes ownership and restarts the original unfinished sentence', async action => {
    const h = harness();
    await h.audio.play();
    h.handles[0].input.onEnded();
    await tick();
    const stopRemote = vi.fn();
    const lease = h.audio.claimExternalOutput(stopRemote);
    if (action === 'resumeSource') await h.audio.resumeSource(envelope, 'live');
    else await h.audio[action]();
    expect(stopRemote).toHaveBeenCalledOnce();
    expect(lease.isCurrent()).toBe(false);
    expect(h.audible()).toBe(1);
    expect(h.requestSpeech).toHaveBeenLastCalledWith('第二句。', envelope, 1, expect.any(AbortSignal));
    h.audio.dispose();
  });

  it('load, explanation load and rebind revoke external output while retaining the source anchor', async () => {
    const h = harness();
    await h.audio.play();
    const bookmark = h.audio.getBookmark();
    for (const change of [
      () => h.audio.load(target, envelope, 'live'),
      () => h.audio.loadExplanation(target, explanationStep, envelope, 'live'),
      () => h.audio.rebind(envelope),
    ]) {
      const stopRemote = vi.fn();
      const lease = h.audio.claimExternalOutput(stopRemote);
      change();
      expect(stopRemote).toHaveBeenCalledOnce();
      expect(lease.isCurrent()).toBe(false);
      expect(h.audio.getBookmark()).toEqual(bookmark);
      expect(h.audible()).toBe(0);
    }
    h.audio.dispose();
  });

  it('pause revokes the transport instead of resuming remote output through the local player', async () => {
    const h = harness();
    await h.audio.play();
    const stopRemote = vi.fn();
    const lease = h.audio.claimExternalOutput(stopRemote);
    h.audio.pause();
    expect(h.audio.getSnapshot()).toMatchObject({ status: 'paused', outputOwner: 'local' });
    expect(lease.isCurrent()).toBe(false);
    await h.audio.resume();
    expect(h.audio.getSnapshot()).toMatchObject({ status: 'speaking', outputOwner: 'local' });
    expect(stopRemote).toHaveBeenCalledOnce();
    expect(h.handles).toHaveLength(2);
    expect(h.requestSpeech).toHaveBeenLastCalledWith('第一句。', envelope, 1, expect.any(AbortSignal));
    h.audio.dispose();
  });

  it('cannot grant an output lease after disposal or revive one from a change callback', () => {
    const audio: AudioCoordinator = new AudioCoordinator({ requestSpeech: vi.fn(), onError: vi.fn(), onChange: state => { if (state.outputOwner === 'realtime') audio.dispose(); } });
    const firstStop = vi.fn();
    const lease = audio.claimExternalOutput(firstStop);
    expect(lease.isCurrent()).toBe(false);
    expect(firstStop).toHaveBeenCalledOnce();
    const lateStop = vi.fn();
    const late = audio.claimExternalOutput(lateStop);
    expect(late.isCurrent()).toBe(false);
    late.release();
    lease.release();
    expect(lateStop).toHaveBeenCalledOnce();
    expect(firstStop).toHaveBeenCalledOnce();
    expect(audio.getSnapshot()).toMatchObject({ outputOwner: 'local', status: 'silent' });
  });
});


describe('slow speech and rate changes (simulated playback)', () => {
  it.each(['demo', 'live'] as const)('starts %s at 0.25x and restarts only the unfinished sentence on a rate change', async mode => {
    const h = harness(); h.audio.load(target, envelope, mode); h.audio.setRate(0.25);
    await h.audio.play(); h.handles[0].input.onEnded(); await tick();
    const old = h.handles[1]; const bookmark = h.audio.getBookmark();
    expect(old.input.rate).toBe(0.25);
    h.audio.setRate(0.35);
    expect(old.stopped).toBe(true); expect(h.audible()).toBe(0);
    old.input.onEnded(); old.input.onError('late end from old rate'); await tick();
    expect(h.audio.getSnapshot()).toMatchObject({ status: 'speaking', sentenceIndex: 1, rate: 0.35 });
    expect(h.audio.getBookmark()).toEqual(bookmark);
    expect(h.handles[2].input).toMatchObject({ text: '第二句。', rate: 0.35 });
    expect(h.onComplete).not.toHaveBeenCalled(); expect(h.onError).not.toHaveBeenCalled();
    expect(h.maxAudible()).toBe(1);
    if (mode === 'demo') expect(h.requestSpeech).not.toHaveBeenCalled();
    else expect(h.requestSpeech).toHaveBeenLastCalledWith('第二句。', envelope, 0.35, expect.any(AbortSignal));
    h.audio.dispose();
  });

  it('keeps paused audio silent on a slow rate change and resumes its current sentence', async () => {
    const h = harness(); await h.audio.play(); h.audio.next(); await tick(); h.audio.pause();
    const old = h.handles[1]; const bookmark = h.audio.getBookmark();
    h.audio.setRate(0.25); await tick();
    expect(old.stopped).toBe(true); expect(h.audible()).toBe(0);
    expect(h.audio.getSnapshot()).toMatchObject({ status: 'paused', rate: 0.25 });
    expect(h.requestSpeech).toHaveBeenCalledTimes(2);
    await h.audio.resume();
    expect(h.audio.getBookmark()).toEqual(bookmark);
    expect(h.handles[2].input).toMatchObject({ text: '第二句。', rate: 0.25 });
    expect(h.maxAudible()).toBe(1); h.audio.dispose();
  });

  it('cancels a buffering sentence before requesting its new rate and rejects the old audio', async () => {
    const pending = deferred<Blob>(); const requestSpeech = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(new Blob(['slow']));
    const h = harness(requestSpeech); const playing = h.audio.play();
    const oldSignal = requestSpeech.mock.calls[0][3] as AbortSignal;
    h.audio.setRate(0.25); await tick();
    expect(oldSignal.aborted).toBe(true);
    pending.resolve(new Blob(['stale normal-speed audio'])); await playing;
    expect(h.handles).toHaveLength(1); expect(h.handles[0].input.rate).toBe(0.25);
    expect(requestSpeech).toHaveBeenLastCalledWith('第一句。', envelope, 0.25, expect.any(AbortSignal));
    expect(h.audio.getSnapshot().sentenceIndex).toBe(0); expect(h.maxAudible()).toBe(1); h.audio.dispose();
  });

  it('does not replay for the same rate or steal the realtime output lease when updating preferences', async () => {
    const h = harness(); h.audio.setRate(0.25); await h.audio.play(); h.audio.setRate(0.25); await tick();
    expect(h.requestSpeech).toHaveBeenCalledOnce();
    const stopRemote = vi.fn(); const lease = h.audio.claimExternalOutput(stopRemote); const bookmark = h.audio.getBookmark();
    h.audio.setRate(0.35);
    expect(lease.isCurrent()).toBe(true); expect(stopRemote).not.toHaveBeenCalled();
    expect(h.audio.getBookmark()).toEqual(bookmark); expect(h.audible()).toBe(0); h.audio.dispose();
  });

  it('passes a 0.25x rate to a local utterance instead of relying on changing an active utterance', async () => {
    const events = new EventTarget(); const spoken: Array<{ text: string; rate: number; onstart?: () => void }> = [];
    const synth = { getVoices: () => [{ localService: true, lang: 'zh-CN', name: 'local' }],
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      speak: vi.fn((value: (typeof spoken)[number]) => { spoken.push(value); value.onstart?.(); }), resume: vi.fn(), pause: vi.fn(), cancel: vi.fn(),
    };
    vi.stubGlobal('window', { speechSynthesis: synth });
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
    const audio = new AudioCoordinator({ requestSpeech: vi.fn(), onChange: vi.fn(), onError: vi.fn() });
    try {
      audio.load(target, envelope, 'demo'); audio.setRate(0.25); await audio.play();
      expect(spoken[0]).toMatchObject({ text: '第一句。', rate: 0.25 });
      audio.setRate(0.35); await tick(); await tick();
      expect(synth.cancel).toHaveBeenCalledOnce();
      expect(spoken[1]).toMatchObject({ text: '第一句。', rate: 0.35 });
      expect(spoken[1]).not.toBe(spoken[0]); expect(audio.getSnapshot().sentenceIndex).toBe(0);
    } finally { audio.dispose(); vi.unstubAllGlobals(); }
  });
});


describe('free local speech continuity and cancellation', () => {
  it('prefetches only one next sentence and transfers it without a duplicate request', async () => {
    const h = harness(undefined, { prefetchLocalSpeech: true, generatedSpeechRate: 1 });
    h.audio.setRate(0.25);
    await h.audio.play();
    expect(h.requestSpeech.mock.calls.map(call => call[0])).toEqual(['第一句。', '第二句。']);
    expect(h.handles[0].input).toMatchObject({ rate: 0.25, generatedRate: 1 });
    expect(h.audio.getSnapshot().sentenceIndex).toBe(0);
    h.handles[0].input.onEnded();
    await vi.waitFor(() => expect(h.handles).toHaveLength(2));
    expect(h.requestSpeech.mock.calls.map(call => call[0])).toEqual(['第一句。', '第二句。', '第三句。']);
    expect(h.handles[1].input.text).toBe('第二句。');
    expect(h.maxAudible()).toBe(1);
    h.audio.stop();
  });
  it('aborts pending local lookahead on stop and ignores its late audio', async () => {
    const next = deferred<Blob>();
    let pendingSignal: AbortSignal | undefined;
    const request = vi.fn<AudioCoordinatorOptions['requestSpeech']>(async (text, _env, _rate, signal) => {
      if (text === '第二句。') { pendingSignal = signal; return next.promise; }
      return new Blob(['fake']);
    });
    const h = harness(request, { prefetchLocalSpeech: true });
    await h.audio.play();
    expect(pendingSignal?.aborted).toBe(false);
    h.audio.stop();
    expect(pendingSignal?.aborted).toBe(true);
    next.resolve(new Blob(['old'])); await tick();
    expect(h.handles).toHaveLength(1);
    expect(h.audio.getSnapshot().status).toBe('silent');
    expect(h.audio.getBookmark()?.cursor.sentenceIndex).toBe(0);
    expect(h.audible()).toBe(0);
  });
  it('does not prefetch paid speech by default', async () => {
    const h = harness(); await h.audio.play(); expect(h.requestSpeech).toHaveBeenCalledOnce(); h.audio.stop();
  });
  it('applies local 0.25x once while preserving pitch, without changing cloud rate handling', async () => {
    const values: Array<{ playbackRate: number; preservesPitch: boolean }> = [];
    class AudioMock { playbackRate = 1; preservesPitch = false; volume = 1; onplaying = null; onended = null; onerror = null; constructor() { values.push(this); } async play() {} pause() {} load() {} removeAttribute() {} }
    vi.stubGlobal('Audio', AudioMock);
    try {
      const { browserPlaybackAdapter } = await import('../../apps/web/src/features/voice/playback');
      for (const generatedRate of [1, undefined]) {
        const handle = await browserPlaybackAdapter.create({ mode: 'live', text: '中文', blob: new Blob(['mock']), rate: 0.25, generatedRate, volume: 1, signal: new AbortController().signal, onStarted: vi.fn(), onEnded: vi.fn(), onError: vi.fn() });
        handle.setRate(0.25);
        expect(values.at(-1)?.playbackRate).toBe(generatedRate === 1 ? 0.25 : 1);
        expect(values.at(-1)?.preservesPitch).toBe(true);
        handle.dispose();
      }
    } finally { vi.unstubAllGlobals(); }
  });
});


describe('local lookahead failures do not poison resumed reading',()=>{
 it('retries a rejected lookahead only when its sentence is reached after a rapid pause and resume',async()=>{
  const aborted=deferred<Blob>();let secondCalls=0;let abortStillDraining=true;
  const request=vi.fn<AudioCoordinatorOptions['requestSpeech']>(async(text)=>{
   if(text==='第二句。'){
    secondCalls++;
    if(secondCalls===1)return aborted.promise;
    if(abortStillDraining)throw Error('request_in_progress');
   }
   return new Blob(['valid local audio']);
  });
  const h=harness(request,{prefetchLocalSpeech:true});await h.audio.play();
  h.audio.pause();await h.audio.resume();await tick();
  expect(secondCalls).toBe(2);expect(h.audio.getSnapshot().status).toBe('speaking');
  abortStillDraining=false;aborted.reject(Error('cancelled'));await tick();
  h.handles[0].input.onEnded();await vi.waitFor(()=>expect(h.handles).toHaveLength(2));
  expect(secondCalls).toBe(3);expect(h.handles[1].input.text).toBe('第二句。');
  expect(h.onError).not.toHaveBeenCalled();expect(h.maxAudible()).toBe(1);h.audio.dispose();
 });
 it('retries an adopted failed lookahead once, then reports a foreground failure without looping',async()=>{
  const next=deferred<Blob>();let calls=0;
  const request=vi.fn<AudioCoordinatorOptions['requestSpeech']>(async(text)=>{
   if(text==='第二句。'){calls++;if(calls===1)return next.promise;throw Error('engine unavailable');}
   return new Blob(['valid']);
  });
  const h=harness(request,{prefetchLocalSpeech:true});await h.audio.play();h.handles[0].input.onEnded();
  next.reject(Error('request_in_progress'));await vi.waitFor(()=>expect(h.onError).toHaveBeenCalledOnce());
  expect(calls).toBe(2);expect(h.audio.getSnapshot().status).toBe('silent');h.audio.dispose();
 });
 it('ignores rejection of an old aborted prefetch after a newer one has succeeded',async()=>{
  const old=deferred<Blob>();let calls=0;
  const request=vi.fn<AudioCoordinatorOptions['requestSpeech']>(async(text)=>{
   if(text==='第二句。'&&++calls===1)return old.promise;
   return new Blob(['fresh']);
  });
  const h=harness(request,{prefetchLocalSpeech:true});await h.audio.play();h.audio.pause();await h.audio.resume();
  old.reject(Error('old cancelled'));await tick();h.handles[0].input.onEnded();
  await vi.waitFor(()=>expect(h.handles).toHaveLength(2));
  expect(calls).toBe(2);expect(h.onError).not.toHaveBeenCalled();h.audio.dispose();
 });
});
