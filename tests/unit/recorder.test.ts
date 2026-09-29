import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_RECORDING_BYTES, MAX_RECORDING_MS } from '../../packages/shared/protocol';
import { microphoneError, QuestionRecorder, recordingBase64, type RecorderPlatform } from '../../apps/web/src/features/voice/recorder';

class FakeRecorder {
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  payload = new Blob([new Uint8Array(100)], { type: 'audio/webm' });
  start = vi.fn(() => { this.state = 'recording'; });
  stop = vi.fn(() => {
    this.state = 'inactive';
    setTimeout(() => { this.ondataavailable?.({ data: this.payload }); this.onstop?.(); }, 0);
  });
}
function setup(level = 0.08) {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const media = new FakeRecorder();
  const meter = { peak: vi.fn(() => level), close: vi.fn() };
  const platform: RecorderPlatform = {
    getUserMedia: vi.fn(async () => stream), isTypeSupported: type => type.startsWith('audio/webm'),
    createRecorder: vi.fn(() => media as unknown as MediaRecorder), createMeter: vi.fn(() => meter), now: () => Date.now(),
  };
  const callbacks = { onState: vi.fn(), onComplete: vi.fn(), onError: vi.fn() };
  return { track, stream, media, meter, platform, callbacks, recorder: new QuestionRecorder(callbacks, platform) };
}
afterEach(() => { vi.useRealTimers(); });

describe('bounded microphone input lifecycle (mock devices, no human recording)', () => {
  it('releases a permission result that arrives after cancellation without recording', async () => {
    const f = setup(); let resolve!: (value: MediaStream) => void;
    vi.mocked(f.platform.getUserMedia).mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = f.recorder.start(); expect(f.recorder.currentState).toBe('requesting');
    f.recorder.cancel(); resolve(f.stream); await pending;
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.platform.createRecorder).not.toHaveBeenCalled();
    expect(f.callbacks.onComplete).not.toHaveBeenCalled();
  });
  it('bounds the permission wait and rejects a late stream', async () => {
    vi.useFakeTimers(); const f = setup(); let resolve!: (value: MediaStream) => void;
    vi.mocked(f.platform.getUserMedia).mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = f.recorder.start(); await vi.advanceTimersByTimeAsync(20000);
    expect(f.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('权限超时'));
    resolve(f.stream); await pending; expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.recorder.currentState).toBe('idle');
  });
  it('finishes once, closes input immediately and returns only the recorded bytes', async () => {
    vi.useFakeTimers(); const f = setup(); await f.recorder.start(); await f.recorder.start();
    expect(f.platform.getUserMedia).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1500);
    f.recorder.finish(); f.recorder.finish(); expect(f.track.stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.callbacks.onComplete).toHaveBeenCalledOnce();
    expect(f.callbacks.onComplete.mock.calls[0][0]).toMatchObject({ mimeType: 'audio/webm', durationMs: 1500 });
    expect((f.callbacks.onComplete.mock.calls[0][0].blob as Blob).size).toBe(100);
    expect(f.meter.close).toHaveBeenCalledOnce(); expect(f.media.stop).toHaveBeenCalledOnce();
  });
  it('cancels data and stop callbacks already queued by the recorder', async () => {
    vi.useFakeTimers(); const f = setup(); await f.recorder.start(); await vi.advanceTimersByTimeAsync(1000);
    f.recorder.finish(); f.recorder.cancel(); await vi.runAllTimersAsync();
    expect(f.callbacks.onComplete).not.toHaveBeenCalled(); expect(f.meter.close).toHaveBeenCalledOnce();
  });
  it('automatically stops at 60 seconds and leaves no device or recurring timer', async () => {
    vi.useFakeTimers(); const f = setup(); await f.recorder.start(); await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS + 1);
    expect(f.callbacks.onComplete).toHaveBeenCalledOnce(); expect(f.callbacks.onComplete.mock.calls[0][0].durationMs).toBe(MAX_RECORDING_MS);
    expect(f.recorder.currentState).toBe('idle'); expect(f.track.stop).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['quiet', 'short', 'empty'])('rejects a %s recording before any transcript callback', async kind => {
    vi.useFakeTimers(); const f = setup(kind === 'quiet' ? 0 : 0.08); if (kind === 'empty') f.media.payload = new Blob([]);
    await f.recorder.start(); await vi.advanceTimersByTimeAsync(kind === 'short' ? 200 : 1500); f.recorder.finish(); await vi.advanceTimersByTimeAsync(1);
    expect(f.callbacks.onComplete).not.toHaveBeenCalled(); expect(f.callbacks.onError).toHaveBeenCalledOnce(); expect(f.track.stop).toHaveBeenCalled();
  });
  it('rejects excessive bytes and releases all resources', async () => {
    vi.useFakeTimers(); const f = setup(); await f.recorder.start();
    f.media.ondataavailable?.({ data: new Blob([new Uint8Array(MAX_RECORDING_BYTES + 1)]) }); await vi.runAllTimersAsync();
    expect(f.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('超过 4 MB')); expect(f.callbacks.onComplete).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('closes the input on device loss and recording failure', async () => {
    vi.useFakeTimers(); const f = setup(); await f.recorder.start(); f.track.dispatchEvent(new Event('ended')); await vi.runAllTimersAsync();
    expect(f.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('断开')); expect(f.recorder.currentState).toBe('idle');
    await f.recorder.start(); f.media.onerror?.(); await vi.runAllTimersAsync(); expect(f.callbacks.onError).toHaveBeenCalledTimes(2);
  });
  it('provides actionable permission, device and unsupported-format errors', async () => {
    const f = setup(); vi.mocked(f.platform.getUserMedia).mockRejectedValueOnce({ name: 'NotAllowedError' }); await f.recorder.start();
    expect(f.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('网站权限'));
    expect(microphoneError({ name: 'NotFoundError' })).toContain('连接设备'); expect(microphoneError({ name: 'NotReadableError' })).toContain('独占');
    f.platform.isTypeSupported = () => false; await f.recorder.start(); expect(f.track.stop).toHaveBeenCalled(); expect(f.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('不支持'));
  });
  it('encodes exact recording bytes and rejects an oversized blob', async () => {
    expect(await recordingBase64(new Blob([new Uint8Array([0, 1, 255, 16])]))).toBe('AAH/EA==');
    await expect(recordingBase64(new Blob([new Uint8Array(MAX_RECORDING_BYTES + 1)]))).rejects.toThrow('4 MB');
  });
});
