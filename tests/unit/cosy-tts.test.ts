import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CosyTtsProvider } from '../../apps/server/src/cosyTts';
import type { spawn } from 'node:child_process';

const providers: CosyTtsProvider[] = [];
function worker(available = true) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false, kill: vi.fn(() => true) });
  const frames: Array<Record<string, unknown>> = [];
  child.stdin.on('data', data => { frames.push(JSON.parse(data.toString())); });
  const spawnMock = vi.fn(() => child);
  const provider = new CosyTtsProvider({ exists: () => available, spawn: spawnMock as unknown as typeof spawn, startupTimeoutMs: 1000, requestTimeoutMs: 1000 });
  providers.push(provider);
  const emit = (frame: object) => child.stdout.write(JSON.stringify(frame) + '\n');
  const ready = () => emit({ type: 'ready', device: 'cuda', sampleRate: 24000 });
  const current = () => [...frames].reverse().find(frame => frame.type === 'speak')!;
  const audio = (id: unknown, text = 'MP3-test') => emit({ type: 'audio', id, data: Buffer.from(text).toString('base64') });
  return { provider, child, frames, spawnMock, emit, ready, current, audio };
}
afterEach(() => { for (const provider of providers.splice(0)) provider.dispose(); vi.useRealTimers(); vi.unstubAllEnvs(); });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('project-owned CosyVoice worker (mock process, no GPU/network)', () => {
  it('is lazy, reports installation, and never launches when runtime files are missing', async () => {
    const h = worker(false); expect(h.provider.ready()).toBe(false); expect(h.provider.status()).toBe('missing');
    await expect(h.provider.speak('本地测试。', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'cosy_not_installed' });
    expect(h.spawnMock).not.toHaveBeenCalled();
  });
  it('forwards audio before done, retains a warm process, fixes voice and excludes credentials from child env', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'not-a-real-key');
    const h = worker(); expect(h.provider.status()).toBe('idle'); expect(h.spawnMock).not.toHaveBeenCalled();
    const onAudio = vi.fn(); const pending = h.provider.speak('第一句。', 3, new AbortController().signal, onAudio);
    expect(h.provider.status()).toBe('loading'); h.ready(); await tick();
    expect(h.provider.status()).toBe('ready'); expect(h.current()).toMatchObject({ type: 'speak', text: '第一句。', voice: 'cosy_default' });
    let completed = false; void pending.then(() => { completed = true; });
    h.audio(h.current().id, 'one'); await tick(); expect(onAudio).toHaveBeenCalledWith(Buffer.from('one')); expect(completed).toBe(false);
    h.audio(h.current().id, 'two'); h.emit({ type: 'done', id: h.current().id, metrics: { firstPcmMs: 200, totalMs: 600, audioSeconds: 2 } });
    expect(await pending).toMatchObject({ audio: Buffer.from('onetwo'), metrics: { audioSeconds: 2 } });
    const second = h.provider.speak('第二句。', 0.25, new AbortController().signal); await tick(); h.audio(h.current().id); h.emit({ type: 'done', id: h.current().id }); await second;
    expect(h.spawnMock).toHaveBeenCalledOnce();
    const options = (h.spawnMock.mock.calls[0] as unknown as [unknown, unknown, { env: Record<string, string>; windowsHide: boolean }])[2];
    expect(options.windowsHide).toBe(true); expect(options.env).not.toHaveProperty('OPENAI_API_KEY'); expect(options.env.HF_HUB_OFFLINE).toBe('1');
  });
  it('cancels by request id, discards late audio and does not kill a warm worker', async () => {
    const h = worker(); const controller = new AbortController(); const onAudio = vi.fn();
    const pending = h.provider.speak('取消原文。', 1, controller.signal, onAudio); const rejected = expect(pending).rejects.toMatchObject({ code: 'cosy_cancelled' });
    h.ready(); await tick(); const id = h.current().id; controller.abort(); await rejected;
    expect(h.frames).toContainEqual({ type: 'cancel', id }); h.audio(id); h.emit({ type: 'done', id }); expect(onAudio).not.toHaveBeenCalled(); expect(h.child.kill).not.toHaveBeenCalled();
  });
  it('fails visibly if worker falls back to CPU or leaks an untrusted diagnostic', async () => {
    const h = worker(); const pending = h.provider.speak('测试。', 1, new AbortController().signal); const rejected = expect(pending).rejects.toMatchObject({ code: 'cosy_gpu_unavailable' });
    h.emit({ type: 'ready', device: 'cpu', sampleRate: 24000 }); await rejected; expect(h.child.kill).toHaveBeenCalledOnce();
    const other = worker(); const failed = other.provider.speak('测试。', 1, new AbortController().signal); const failure = expect(failed).rejects.toMatchObject({ message: expect.not.stringContaining('PRIVATE') });
    other.emit({ type: 'error', code: 'library', message: 'PRIVATE TEXT AND STACK' }); await failure;
  });
  it('cancels while loading without submitting stale text and rejects malformed audio', async () => {
    const h = worker(); const controller = new AbortController(); const cancelled = h.provider.speak('不会提交。', 1, controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ code: 'cosy_cancelled' }); controller.abort(); await rejected;
    h.ready(); await tick(); expect(h.frames).toHaveLength(0);
    const pending = h.provider.speak('有效文字。', 1, new AbortController().signal); const invalid = expect(pending).rejects.toMatchObject({ code: 'cosy_worker_failed' }); await tick();
    h.emit({ type: 'audio', id: h.current().id, data: 'invalid-base64' }); await invalid; expect(h.child.kill).toHaveBeenCalledOnce();
  });
  it('bounds startup and rejects pending work when only its own process is disposed', async () => {
    vi.useFakeTimers(); const h = worker(); const pending = h.provider.speak('测试。', 1, new AbortController().signal); const rejected = expect(pending).rejects.toMatchObject({ code: 'cosy_startup_timeout' });
    await vi.advanceTimersByTimeAsync(1001); await rejected; expect(h.child.kill).toHaveBeenCalledOnce();
    const other = worker(); const speaking = other.provider.speak('测试。', 1, new AbortController().signal); const stopped = expect(speaking).rejects.toMatchObject({ code: 'cosy_cancelled' });
    other.ready(); await tick(); other.provider.dispose(); other.provider.dispose(); await stopped; expect(other.child.kill).toHaveBeenCalledOnce(); expect(other.provider.status()).toBe('stopped');
  });
});
