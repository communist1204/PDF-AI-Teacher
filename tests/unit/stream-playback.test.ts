import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStreamPlayback } from '../../apps/web/src/features/voice/streamPlayback';
import type { PlaybackInput } from '../../apps/web/src/features/voice/playback';

function fixture(secondsPerByte = 0) {
  const buffers: BufferMock[] = []; const media: MediaMock[] = []; const audio: AudioMock[] = [];
  class BufferMock extends EventTarget {
    seconds = 0; buffered = { length: 0, start: () => 0, end: () => this.seconds }; updating = false; writes: Uint8Array[] = [];
    appendBuffer(value: Uint8Array) { this.writes.push(value); this.updating = true; queueMicrotask(() => { this.seconds += value.byteLength * secondsPerByte; this.buffered.length = this.seconds > 0 ? 1 : 0; this.updating = false; this.dispatchEvent(new Event('updateend')); }); }
    abort() { this.updating = false; }
  }
  class MediaMock extends EventTarget {
    readyState = 'closed'; endOfStream = vi.fn(() => { expect(buffers.every(buffer => !buffer.updating)).toBe(true); this.readyState = 'ended'; });
    static isTypeSupported() { return true; }
    constructor() { super(); media.push(this); }
    addSourceBuffer() { const value = new BufferMock(); buffers.push(value); return value; }
    open() { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); }
  }
  class AudioMock extends EventTarget {
    volume = 1; currentTime = 0; preservesPitch = false; playbackRate = 1; paused = true;
    onplaying: (() => void) | null = null; onended: (() => void) | null = null; onerror: (() => void) | null = null; onwaiting = null;
    constructor() { super(); audio.push(this); }
    play = vi.fn(() => { this.paused = false; this.onplaying?.(); return Promise.resolve(); });
    pause() { this.paused = true; }
    removeAttribute() {} load() {}
  }
  vi.stubGlobal('MediaSource', MediaMock); vi.stubGlobal('Audio', AudioMock);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-media'); const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const controller = new AbortController();
  const input: PlaybackInput = { mode: 'live', text: '测试', rate: 1, generatedRate: 1, volume: 0.8, signal: controller.signal, onStarted: vi.fn(), onStreamComplete: vi.fn(), onEnded: vi.fn(), onError: vi.fn() };
  return { media, buffers, audio, input, controller, revoke };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('bounded stream playback lifecycle (mock media, no listening claims)', () => {
  it('waits for two playable seconds rather than starting the short first chunk, and still plays before EOF', async () => {
    const f = fixture(0.001); let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new Uint8Array(800)); } });
    const handle = createStreamPlayback(f.input, { body, mimeType: 'audio/mpeg' }); const play = handle.play(); f.media[0].open();
    await vi.waitFor(() => expect(f.buffers[0].seconds).toBe(0.8)); expect(f.audio[0].play).not.toHaveBeenCalled(); expect(f.input.onStarted).not.toHaveBeenCalled();
    stream.enqueue(new Uint8Array(1300)); await play;
    expect(f.audio[0].play).toHaveBeenCalledOnce(); expect(f.input.onStarted).toHaveBeenCalledOnce(); expect(f.media[0].endOfStream).not.toHaveBeenCalled(); handle.stop();
  });

  it('starts a short complete utterance at EOF without waiting for an impossible buffer duration', async () => {
    const f = fixture(0.001); const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(700)); controller.close(); } });
    const handle = createStreamPlayback(f.input, { body, mimeType: 'audio/mpeg' }); const play = handle.play(); f.media[0].open(); await play;
    expect(f.audio[0].play).toHaveBeenCalledOnce(); expect(f.media[0].endOfStream).toHaveBeenCalledOnce(); expect(f.input.onError).not.toHaveBeenCalled(); handle.stop();
  });

  it('pausing before the startup buffer is ready revokes pending play and requires explicit resume', async () => {
    const f = fixture(0.001); let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new Uint8Array(800)); } });
    const handle = createStreamPlayback(f.input, { body, mimeType: 'audio/mpeg' }); const cancelled = expect(handle.play()).rejects.toMatchObject({ name: 'AbortError' }); f.media[0].open();
    await vi.waitFor(() => expect(f.buffers[0].seconds).toBe(0.8)); handle.pause(); await cancelled;
    stream.enqueue(new Uint8Array(2000)); await vi.waitFor(() => expect(f.buffers[0].seconds).toBe(2.8));
    expect(f.audio[0].play).not.toHaveBeenCalled(); await handle.play(); expect(f.audio[0].play).toHaveBeenCalledOnce(); handle.stop();
  });

  it('stop during startup buffering aborts the play promise and releases without late output', async () => {
    const f = fixture(0.001); const cancelledReader = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(800)); }, cancel: cancelledReader });
    const handle = createStreamPlayback(f.input, { body, mimeType: 'audio/mpeg' }); const cancelledPlay = expect(handle.play()).rejects.toMatchObject({ name: 'AbortError' }); f.media[0].open();
    await vi.waitFor(() => expect(f.buffers[0].seconds).toBe(0.8)); handle.stop(); await cancelledPlay;
    expect(cancelledReader).toHaveBeenCalledOnce(); expect(f.audio[0].play).not.toHaveBeenCalled(); expect(f.input.onError).not.toHaveBeenCalled();
  });

  it('scales the initial reserve to playback speed and rechecks it when the user slows down', async () => {
    const f = fixture(0.001); f.input.rate = 3; let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new Uint8Array(2100)); } });
    const handle = createStreamPlayback(f.input, { body, mimeType: 'audio/mpeg' }); const play = handle.play(); f.media[0].open();
    await vi.waitFor(() => expect(f.buffers[0].seconds).toBe(2.1)); expect(f.audio[0].play).not.toHaveBeenCalled();
    handle.setRate(1); await play; expect(f.audio[0].play).toHaveBeenCalledOnce(); expect(f.audio[0].playbackRate).toBe(1);
    stream.close(); handle.stop();
  });

  it('splits a large network chunk into bounded appends and completes only after their updateend', async () => {
    const f = fixture();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(600_000)); controller.close(); } });
    const handle = createStreamPlayback(f.input, { body, mimeType: 'audio/mpeg' });
    f.media[0].open(); await vi.waitFor(() => expect(f.media[0].endOfStream).toHaveBeenCalledOnce());
    expect(f.buffers[0].writes.map(value => value.byteLength)).toEqual([262144, 262144, 75712]);
    expect(f.input.onStreamComplete).toHaveBeenCalledOnce();
    expect(f.input.onEnded).not.toHaveBeenCalled(); expect(f.input.onError).not.toHaveBeenCalled();
    handle.dispose(); expect(f.revoke).toHaveBeenCalledOnce();
  });

  it('cancels before sourceopen and cannot append late input', async () => {
    const f = fixture(); const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const handle = createStreamPlayback(f.input, { body, mimeType: 'audio/mpeg' });
    f.controller.abort(); f.media[0].open(); await Promise.resolve(); handle.dispose();
    expect(cancelled).toHaveBeenCalledOnce(); expect(f.buffers).toHaveLength(0);
    expect(f.input.onStarted).not.toHaveBeenCalled(); expect(f.input.onError).not.toHaveBeenCalled(); expect(f.revoke).toHaveBeenCalledOnce();
    expect(f.input.onStreamComplete).not.toHaveBeenCalled();
  });

  it('rejects oversized input, cancels its reader and never signals normal completion', async () => {
    const f = fixture(); const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); }, cancel: cancelled });
    createStreamPlayback(f.input, { body, mimeType: 'audio/mpeg' }); f.media[0].open();
    await vi.waitFor(() => expect(f.input.onError).toHaveBeenCalledOnce());
    expect(f.input.onError).toHaveBeenCalledWith(expect.stringContaining('超过大小限制'));
    expect(f.buffers[0].writes).toHaveLength(0); expect(cancelled).toHaveBeenCalledOnce();
    expect(f.media[0].endOfStream).not.toHaveBeenCalled(); expect(f.input.onEnded).not.toHaveBeenCalled();
  });

  it('reports a failed stream exactly once and releases media and object URLs', async () => {
    const f = fixture(); let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; controller.enqueue(new Uint8Array([1, 2])); } });
    const handle = createStreamPlayback(f.input, { body, mimeType: 'audio/mpeg' }); f.media[0].open();
    await vi.waitFor(() => expect(f.buffers[0].writes).toHaveLength(1)); source.error(new Error('fixture disconnected'));
    await vi.waitFor(() => expect(f.input.onError).toHaveBeenCalledOnce()); handle.stop(); handle.dispose();
    expect(f.revoke).toHaveBeenCalledOnce(); expect(f.media[0].endOfStream).not.toHaveBeenCalled(); expect(f.input.onEnded).not.toHaveBeenCalled();
  });
});
