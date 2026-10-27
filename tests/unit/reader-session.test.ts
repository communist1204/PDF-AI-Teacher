import { describe, expect, it, vi } from 'vitest';
import { SpeechSession } from '../../apps/desktop/speechSession';
import { defaultPreferences } from '../../apps/desktop/settings';
import type { DoubaoTtsOptions, DoubaoTtsResult } from '../../apps/desktop/providers/doubaoTts';

const preferences = { ...defaultPreferences, allowCloud: true };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
function setup() {
  const requests: { options: DoubaoTtsOptions; signal: AbortSignal; text: string; speed: number; section?: string; job: ReturnType<typeof deferred<DoubaoTtsResult>> }[] = [];
  const disposals = vi.fn();
  const create = vi.fn((options: DoubaoTtsOptions) => ({
    dispose: disposals,
    speak: (text: string, speed: number, signal: AbortSignal, section?: string) => { const job = deferred<DoubaoTtsResult>(); requests.push({ options, signal, text, speed, section, job }); return job.promise; },
  }));
  return { session: new SpeechSession(create), requests, create, disposals };
}
describe('Reader speech generation ownership', () => {
  it('blocks cloud requests without consent or credentials before creating a provider', () => {
    const { session, create } = setup();
    expect(() => session.begin('g1', defaultPreferences, 'test-key')).toThrow('允许');
    expect(() => session.begin('g1', preferences, '')).toThrow('API Key');
    expect(() => session.begin('bad id', preferences, 'test-key')).toThrow('标识');
    expect(create).not.toHaveBeenCalled();
  });
  it('freezes voice configuration and generates at native rate for in-place playback speed', async () => {
    const { session, requests } = setup(); const prefs = { ...preferences }; session.begin('g1', prefs, 'test-key');
    prefs.voice = 'changed'; prefs.rate = 3;
    const pending = session.speak({ generationId: 'g1', chunkId: 0, text: '你好。' });
    expect(requests[0]).toMatchObject({ speed: 1, section: 'g1', options: { voice: defaultPreferences.voice } });
    requests[0].job.resolve({ audio: Buffer.from([1, 2]) });
    expect(await pending).toEqual({ generationId: 'g1', chunkId: 0, audio: new Uint8Array([1, 2]) });
  });
  it('limits prefetch to two active requests and prevents duplicate billing for a chunk', async () => {
    const { session, requests } = setup(); session.begin('g1', preferences, 'test-key');
    const one = session.speak({ generationId: 'g1', chunkId: 0, text: '第一句。' });
    const two = session.speak({ generationId: 'g1', chunkId: 1, text: '第二句。' });
    await expect(session.speak({ generationId: 'g1', chunkId: 2, text: '第三句。' })).rejects.toThrow('稍等');
    requests[0].job.resolve({ audio: Buffer.from([1]) }); await one;
    await expect(session.speak({ generationId: 'g1', chunkId: 0, text: '第一句。' })).rejects.toThrow('请求过');
    requests[1].job.resolve({ audio: Buffer.from([2]) }); await two;
    expect(requests).toHaveLength(2);
  });
  it('cancels both in-flight requests and rejects late results from a stale generation', async () => {
    const { session, requests, disposals } = setup(); session.begin('g1', preferences, 'test-key');
    const one = session.speak({ generationId: 'g1', chunkId: 0, text: '旧内容。' });
    const two = session.speak({ generationId: 'g1', chunkId: 1, text: '旧下一句。' });
    session.begin('g2', preferences, 'test-key');
    expect(requests.every(request => request.signal.aborted)).toBe(true); expect(disposals).toHaveBeenCalledOnce();
    requests.forEach(request => request.job.resolve({ audio: Buffer.from([1]) }));
    await expect(one).rejects.toThrow('过期'); await expect(two).rejects.toThrow('过期');
    await expect(session.speak({ generationId: 'g1', chunkId: 2, text: '旧第三句。' })).rejects.toThrow('过期');
  });
  it('rejects oversized or invalid chunks without network and bounds one screenshot to 12000 characters', async () => {
    const { session, requests } = setup(); session.begin('g1', preferences, 'test-key');
    for (const text of ['', '\0', 'a'.repeat(6001)]) await expect(session.speak({ generationId: 'g1', chunkId: 0, text })).rejects.toThrow('无效');
    await expect(session.speak({ generationId: 'g1', chunkId: -1, text: '你好' })).rejects.toThrow('无效');
    expect(requests).toHaveLength(0);
    const a = session.speak({ generationId: 'g1', chunkId: 0, text: 'a'.repeat(6000) }); requests[0].job.resolve({ audio: Buffer.from([1]) }); await a;
    const b = session.speak({ generationId: 'g1', chunkId: 1, text: 'a'.repeat(6000) }); requests[1].job.resolve({ audio: Buffer.from([1]) }); await b;
    await expect(session.speak({ generationId: 'g1', chunkId: 2, text: '多了' })).rejects.toThrow('12000');
  });
  it('cancels the previous generation even if the replacement has invalid settings', async () => {
    const { session, requests } = setup(); session.begin('g1', preferences, 'test-key');
    const pending = session.speak({ generationId: 'g1', chunkId: 0, text: '旧内容。' });
    expect(() => session.begin('g2', defaultPreferences, 'test-key')).toThrow('允许');
    expect(requests[0].signal.aborted).toBe(true); requests[0].job.resolve({ audio: Buffer.from([1]) });
    await expect(pending).rejects.toThrow('过期');
  });
});

it('keeps Bing consent separate and never needs or passes a Doubao key to its provider', async () => {
  const doubao = vi.fn(), bingSpeak = vi.fn(async () => ({ audio: Buffer.from([1, 2]), mimeType: 'audio/mpeg' as const }));
  const bing = vi.fn(() => ({ speak: bingSpeak, dispose: vi.fn() }));
  const session = new SpeechSession(doubao, undefined, bing);
  expect(() => session.begin('b1', { ...defaultPreferences, provider: 'bing', allowCloud: true }, 'private-doubao-key')).toThrow('微软 Bing');
  session.begin('b2', { ...defaultPreferences, provider: 'bing', allowBingCloud: true }, '');
  expect(await session.speak({ generationId: 'b2', chunkId: 0, text: '你好。' })).toMatchObject({ mimeType: 'audio/mpeg' });
  expect(bing).toHaveBeenCalledWith(); expect(doubao).not.toHaveBeenCalled();
  session.cancel();
});
