import { describe, expect, it, vi } from 'vitest';
import { BingTtsProvider } from '../../apps/desktop/providers/bingTts';
import { createBingFetch } from '../../apps/desktop/network';

const html = '<div data-iid="translator.42" id="rich_tta"></div><script>_G={IG:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"};var params_AbusePreventionHelper = [12345,"anonymous-test-session",3600000];</script>';
const mp3 = new Uint8Array(64); mp3.set([255, 243, 68, 0]);
const page = () => new Response(html);
const sound = () => new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } });
const signal = () => new AbortController().signal;
const provider = (mock: ReturnType<typeof vi.fn>) => new BingTtsProvider({ fetchImpl: mock as typeof fetch });

describe('Bing translator speech (anonymous website protocol mock)', () => {
  it('shares one page bootstrap and uses the exact voice, origin, dynamic IID and escaped SSML', async () => {
    const fetcher = vi.fn(async (url: string) => url.includes('/translator?') ? page() : sound());
    const service = provider(fetcher);
    const results = await Promise.all([service.speak('<voice>甲 & 乙</voice>', 1, signal()), service.speak('第二句。', 1, signal())]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const posts = fetcher.mock.calls.filter(call => String(call[0]).includes('/tfettts')) as unknown as [string, RequestInit][];
    expect(new Set(posts.map(([url]) => new URL(url).searchParams.get('SFX'))).size).toBe(2);
    for (const [url, options] of posts) {
      expect(new URL(url).searchParams.get('IID')).toBe('translator.42');
      expect(options.credentials).toBe('include');
      expect(options.redirect).toBe('manual');
      const body = new URLSearchParams(String(options.body));
      expect(body.get('ssml')).toContain('name="zh-CN-XiaoxiaoNeural"');
      expect(body.get('ssml')).toContain('rate="-20.00%"');
      expect(body.get('token')).toBe('anonymous-test-session');
      expect(body.has('apiKey')).toBe(false);
    }
    expect(new URLSearchParams(String(posts[0][1].body)).get('ssml')).toContain('&lt;voice&gt;甲 &amp; 乙&lt;/voice&gt;');
    expect(results[0]).toMatchObject({ audio: Buffer.from(mp3), mimeType: 'audio/mpeg' });
    service.dispose();
  });
  it('follows only a bounded translator redirect and posts to that same origin', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cn.bing.com/translator?edgepdftranslator=1' } })).mockResolvedValueOnce(page()).mockResolvedValueOnce(sound());
    const service = provider(fetcher);
    await service.speak('中文。', 1, signal());
    expect(String(fetcher.mock.calls[2][0])).toMatch(/^https:\/\/cn\.bing\.com\/tfettts\?/);
    service.dispose();
    const denied = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://untrusted.example/translator' } }));
    await expect(provider(denied).speak('不得外发。', 1, signal())).rejects.toThrow('未返回有效声音');
    expect(denied).toHaveBeenCalledTimes(1);
  });
  it('fails closed on changed/challenge HTML without submitting text or executing scripts', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<script>throw Error("should never execute")</script>Verify your request'));
    await expect(provider(fetcher).speak('正文。', 1, signal())).rejects.toThrow('未发送朗读文字');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429])('does not retry or switch providers after HTTP %s', async status => {
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response('private-server-message', { status }));
    await expect(provider(fetcher).speak('正文。', 1, signal())).rejects.toThrow(status === 429 ? '限流' : '拒绝');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    () => new Response('', { headers: { 'content-type': 'text/html' } }),
    () => new Response('not audio', { headers: { 'content-type': 'audio/mpeg' } }),
    () => new Response(mp3, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(10 * 1024 * 1024) } }),
  ])('rejects false success, malformed and oversized audio', async invalid => {
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(invalid());
    await expect(provider(fetcher).speak('正文。', 1, signal())).rejects.toThrow('未返回有效声音');
  });
  it('rejects invalid input before any request and refuses use after disposal', async () => {
    const fetcher = vi.fn(), service = provider(fetcher);
    for (const text of ['', '\0', '字'.repeat(3001)]) await expect(service.speak(text, 1, signal())).rejects.toThrow('3000');
    service.dispose();
    await expect(service.speak('正文', 1, signal())).rejects.toThrow('取消');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cancels immediately even when transport does not settle', async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {})), controller = new AbortController();
    const service = provider(fetcher), pending = service.speak('正文。', 1, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('取消');
    service.dispose();
  });
  it('bounds a stuck request by timeout without surfacing raw transport data', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(() => new Promise<Response>(() => {}));
      const service = new BingTtsProvider({ fetchImpl: fetcher, timeoutMs: 100 });
      const pending = expect(service.speak('正文。', 1, signal())).rejects.toThrow('超时');
      await vi.advanceTimersByTimeAsync(101); await pending; service.dispose();
    } finally { vi.useRealTimers(); }
  });
  it('refreshes an expired page in memory before the next request', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const fetcher = vi.fn(async (url: string) => url.includes('/translator?') ? page() : sound());
      const service = provider(fetcher);
      await service.speak('第一句。', 1, signal());
      now.mockReturnValue(3601001);
      await service.speak('第二句。', 1, signal());
      expect(fetcher.mock.calls.filter(([url]) => url.includes('/translator?'))).toHaveLength(2);
      service.dispose();
    } finally { now.mockRestore(); }
  });
});

describe('Bing partition transport', () => {
  it('only permits HTTPS public translator endpoints and forces isolated cookie handling/manual redirects', async () => {
    const transport = vi.fn(async () => page());
    const beforeRequest = vi.fn();
    const request = createBingFetch({ fetch: transport, webRequest: { onBeforeRequest: beforeRequest } });
    const guard = beforeRequest.mock.calls[0][0];
    const result = vi.fn();
    guard({ url: 'https://evil.example/translator' }, result);
    expect(result).toHaveBeenCalledWith({ cancel: true });
    guard({ url: 'https://cn.bing.com/translator' }, result);
    expect(result).toHaveBeenLastCalledWith({ cancel: false });
    await request('https://cn.bing.com/translator', { credentials: 'omit', redirect: 'follow' });
    expect(transport).toHaveBeenCalledWith('https://cn.bing.com/translator', expect.objectContaining({ credentials: 'include', redirect: 'follow', cache: 'no-store' }));
    for (const url of ['http://www.bing.com/translator', 'https://evil.example/translator', 'https://www.bing.com/account', 'https://u:p@www.bing.com/translator']) await expect(request(url)).rejects.toThrow('未知');
    expect(transport).toHaveBeenCalledTimes(1);
    await request('https://cn.bing.com/tfettts', { method: 'POST', redirect: 'follow' });
    expect(transport).toHaveBeenLastCalledWith('https://cn.bing.com/tfettts', expect.objectContaining({ redirect: 'error' }));
  });
});
