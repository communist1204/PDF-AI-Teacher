import { describe, expect, it, vi } from 'vitest';
import { AudioCoordinator, type PlaybackAdapter, type PlaybackHandle, type PlaybackInput } from '../../apps/web/src/features/voice/AudioCoordinator';
import { COSY_AUDITION_TEXT, CosyVoiceAudition, type CosyAuditionState } from '../../apps/web/src/features/voice/CosyVoiceAudition';
import type { Envelope, PdfTarget } from '../../packages/shared/protocol';
import type { CosyVoiceId } from '../../packages/shared/cosySpeech';
import type { SpeechStream } from '../../apps/web/src/features/voice/streamPlayback';

const envelope: Envelope = { sessionId: 'audition-test', generationId: 0, contextRevision: 0 };
const target: PdfTarget = { sourceId: 'paragraph', documentId: 'book', pageIndex: 2, pageLabel: null, blockId: 'block', rect: null, sourceText: '原文第一句。原文第二句。' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

function harness(request = vi.fn<(_text: string, _envelope: Envelope, _speed: number, _signal: AbortSignal, _voice: CosyVoiceId) => Promise<Blob | SpeechStream>>(async () => new Blob(['synthetic-test']))) {
  let active = 0; let maximum = 0; let available = true;
  const inputs: PlaybackInput[] = [];
  const handles: PlaybackHandle[] = [];
  const states: CosyAuditionState[] = [];
  const adapter: PlaybackAdapter = { create(input) {
    inputs.push(input); let playing = false;
    const stop = () => { if (playing) active--; playing = false; };
    const handle = { play: vi.fn(async () => { if (!playing) active++; playing = true; maximum = Math.max(maximum, active); input.onStarted(); }), pause: stop, stop: vi.fn(stop), dispose: vi.fn(stop), setRate: vi.fn(), setVolume: vi.fn() };
    handles.push(handle); return handle;
  } };
  const audio = new AudioCoordinator({ requestSpeech: async () => new Blob(['reader-test']), onChange: vi.fn(), onError: vi.fn(), playbackAdapter: adapter });
  const begin = vi.fn(() => { audio.interrupt(); return { ...envelope, generationId: ++envelope.generationId }; });
  const preview = new CosyVoiceAudition({ available: () => available, begin, claimOutput: stop => audio.claimExternalOutput(stop, 'preview'), request, playbackAdapter: adapter, onChange: state => states.push(state) });
  return { preview, audio, states, inputs, handles, begin, request, available(value: boolean) { available = value; }, active: () => active, maximum: () => maximum };
}

describe('explicit Cosy voice auditions', () => {
  it('does not generate at construction; sends the selected voice with the same one-times sample', async () => {
    const h = harness(); expect(h.request).not.toHaveBeenCalled();
    await h.preview.play('cosy_male_2');
    expect(h.request).toHaveBeenCalledWith(COSY_AUDITION_TEXT, expect.objectContaining({ sessionId: envelope.sessionId }), 1, expect.any(AbortSignal), 'cosy_male_2');
    expect(h.audio.getSnapshot().outputOwner).toBe('preview');
    expect(h.states.at(-1)).toEqual({ status: 'playing', voice: 'cosy_male_2' });
    h.inputs[0].onEnded(); expect(h.states.at(-1)).toEqual({ status: 'finished', voice: 'cosy_male_2' }); expect(h.active()).toBe(0);
  });

  it('refuses unapplied/cloud engines before touching output or the network', async () => {
    const h = harness(); h.available(false); await h.preview.play('cosy_female_1');
    expect(h.request).not.toHaveBeenCalled(); expect(h.begin).not.toHaveBeenCalled(); expect(h.handles).toHaveLength(0); expect(h.states.at(-1)?.status).toBe('error');
  });

  it('borrows the one output owner, preserves the exact original sentence, and never resumes automatically', async () => {
    const h = harness(); h.audio.load(target, envelope, 'live'); await h.audio.play(); h.audio.next(); await Promise.resolve(); await Promise.resolve();
    const bookmark = h.audio.getBookmark();
    await h.preview.play('cosy_female_2'); expect(h.maximum()).toBe(1); expect(h.audio.getBookmark()).toEqual(bookmark);
    h.preview.stop(); expect(h.active()).toBe(0); expect(h.audio.getBookmark()).toEqual(bookmark);
    await h.audio.resumeSource({ ...envelope }, 'live'); expect(h.inputs.at(-1)?.text).toBe('原文第二句。'); expect(h.maximum()).toBe(1);
  });

  it('a newer voice aborts the old request and discards its late stream without playing it', async () => {
    const first = deferred<Blob | SpeechStream>(); const second = deferred<Blob | SpeechStream>();
    const request = vi.fn<(_text: string, _envelope: Envelope, _speed: number, _signal: AbortSignal, _voice: CosyVoiceId) => Promise<Blob | SpeechStream>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const h = harness(request); const old = h.preview.play('cosy_default'); const next = h.preview.play('cosy_male_1');
    expect(request.mock.calls[0][3].aborted).toBe(true);
    second.resolve(new Blob(['second'])); await next;
    const cancelled = vi.fn(); first.resolve({ mimeType: 'audio/mpeg', body: new ReadableStream({ cancel: cancelled }) }); await old;
    expect(cancelled).toHaveBeenCalledOnce(); expect(h.handles).toHaveLength(1); expect(h.states.at(-1)?.voice).toBe('cosy_male_1'); expect(h.active()).toBe(1);
  });

  it('stop or close during generation aborts and prevents late autoplay', async () => {
    const pending = deferred<Blob | SpeechStream>(); const h = harness(vi.fn(() => pending.promise)); const playing = h.preview.play('cosy_male_3');
    h.preview.stop(); pending.resolve(new Blob(['late'])); await playing;
    expect(h.request.mock.calls[0][3].aborted).toBe(true); expect(h.handles).toHaveLength(0); expect(h.states.at(-1)).toEqual({ status: 'idle' });
  });

  it('normal reading revokes the preview and stale preview callbacks cannot stop the new reader', async () => {
    const h = harness(); await h.preview.play('cosy_male_3'); const oldInput = h.inputs[0];
    h.audio.load(target, envelope, 'live'); await h.audio.play();
    oldInput.onEnded(); oldInput.onError('late'); expect(h.active()).toBe(1); expect(h.audio.getSnapshot().outputOwner).toBe('local'); expect(h.maximum()).toBe(1);
  });

  it('failed synthesis releases the output slot, surfaces the error, and never automatically retries', async () => {
    const h = harness(vi.fn(async () => { throw new Error('reference missing'); })); await h.preview.play('cosy_female_1');
    expect(h.states.at(-1)).toEqual({ status: 'error', voice: 'cosy_female_1', message: 'reference missing' }); expect(h.audio.getSnapshot().outputOwner).toBe('local'); expect(h.request).toHaveBeenCalledOnce();
  });

  it('disposal releases audio without state updates and future play calls do nothing', async () => {
    const h = harness(); await h.preview.play('cosy_default'); const count = h.states.length; h.preview.dispose(); await h.preview.play('cosy_male_2');
    expect(h.active()).toBe(0); expect(h.request).toHaveBeenCalledOnce(); expect(h.states).toHaveLength(count);
  });
});
