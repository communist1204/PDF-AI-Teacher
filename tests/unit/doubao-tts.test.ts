import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOUBAO_TTS_VOICES, DoubaoTtsProvider, type DoubaoTtsOptions } from '../../apps/server/src/doubaoTts';

const pcm = Buffer.from([0, 0, 120, 0, 240, 0, 120, 0]);
const end = { code: 20000000, usage: { text_words: 7 } };
const data = { code: 0, data: pcm.toString('base64') };
const signal = () => new AbortController().signal;
const encode = (value: unknown) => JSON.stringify(value);
function response(frames: unknown[] = [data, end], split = false) {
  const cancel = vi.fn();
  const bytes = Buffer.from(frames.map(encode).join('\r\n'));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const stop = split ? Math.min(offset + 3, bytes.length) : bytes.length;
      controller.enqueue(bytes.subarray(offset, stop)); offset = stop;
    }, cancel,
  });
  return { value: new Response(body, { headers: { 'content-type': 'application/json' } }), cancel };
}
function setup(overrides: Partial<DoubaoTtsOptions> = {}, upstream = response().value) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(upstream);
  const provider = new DoubaoTtsProvider({ apiKey: 'fake-private-key', voice: DOUBAO_TTS_VOICES[0], instructions: '温和自然地读，保持相同音色。', fetchImpl, ...overrides });
  return { provider, fetchImpl };
}
afterEach(() => vi.useRealTimers());

describe('Doubao 2.0 official HTTP contract (mock only, no cloud calls)', () => {
  it('uses the fixed official endpoint, key header and JSON-string additions for formulas', async () => {
    const { provider, fetchImpl } = setup();
    const text = '私有公式：$x=\\frac{1}{2}$。';
    const result = await provider.speak(text, 3, signal(), 'session-123:paragraph.1');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', headers: {
      'X-Api-Key': 'fake-private-key', 'X-Api-Resource-Id': 'seed-tts-2.0', 'X-Control-Require-Usage-Tokens-Return': '*',
      'X-Api-Request-Id': expect.stringMatching(/^[0-9a-f-]{36}$/),
    } });
    const body = JSON.parse(options!.body as string);
    expect(body.req_params).toMatchObject({ text, speaker: DOUBAO_TTS_VOICES[0], audio_params: { format: 'pcm', sample_rate: 24000, speech_rate: 0 } });
    expect(JSON.parse(body.req_params.additions)).toEqual({ disable_markdown_filter: true, enable_latex_tn: true, latex_parser: 'v2', context_texts: ['温和自然地读，保持相同音色。'], section_id: 'session-123:paragraph.1' });
    expect(options!.body).not.toContain('fake-private-key'); expect(String(url)).not.toContain(text);
    expect(result.characters).toBe(7); expect(result.audio.subarray(44)).toEqual(pcm);
    expect(result.audio.toString('ascii', 0, 4)).toBe('RIFF'); expect(result.audio.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(result.audio.readUInt32LE(4)).toBe(result.audio.length - 8); expect(result.audio.readUInt32LE(40)).toBe(pcm.length);
    expect(result.audio.readUInt16LE(20)).toBe(1); expect(result.audio.readUInt16LE(22)).toBe(1); expect(result.audio.readUInt32LE(24)).toBe(24000);
    expect(result.audio.readUInt32LE(28)).toBe(48000); expect(result.audio.readUInt16LE(32)).toBe(2); expect(result.audio.readUInt16LE(34)).toBe(16);
  });
  it.each(DOUBAO_TTS_VOICES)('supports documented voice %s without a live entitlement check', async voice => {
    const { provider, fetchImpl } = setup({ voice }); expect(provider.ready()).toBe(true); expect(fetchImpl).not.toHaveBeenCalled();
    await provider.speak('你好。', 0.25, signal()); expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string).req_params.speaker).toBe(voice);
  });
  it('decodes arbitrary byte boundaries and skips subtitle frames while keeping final usage', async () => {
    const first = { code: 0, data: pcm.subarray(0, 3).toString('base64'), usage: { text_words: 1 } };
    const second = { code: 0, data: pcm.subarray(3).toString('base64') };
    const upstream = response([first, { code: 0, data: null, sentence: { text: '中文分割测试' } }, second, end], true);
    const { provider } = setup({}, upstream.value);
    const result = await provider.speak('连续完整段落。', 1, signal()); expect(result.audio.subarray(44)).toEqual(pcm); expect(result.characters).toBe(7);
  });
  it('accepts terminal-frame audio and leaves missing usage unknown rather than fabricating zero', async () => {
    const { provider } = setup({ instructions: '' }, response([{ code: 20000000, data: pcm.toString('base64') }]).value);
    const result = await provider.speak('你好。', 1, signal()); expect(result.audio.subarray(44)).toEqual(pcm); expect(result).not.toHaveProperty('characters');
  });
  it('stops at the explicit terminal frame without waiting on an open keep-alive body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(`${encode(data)}\n${encode(end)}\n`)); }, cancel });
    const { provider } = setup({}, new Response(body));
    await expect(provider.speak('你好。', 1, signal())).resolves.toMatchObject({ characters: 7 }); expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(['', '  ', 'bad\nkey'])('does not call the network without a valid local key', async apiKey => {
    const { provider, fetchImpl } = setup({ apiKey }); expect(provider.ready()).toBe(false);
    await expect(provider.speak('你好。', 1, signal())).rejects.toMatchObject({ code: 'doubao_tts_missing' }); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects invalid configuration and input before transmitting anything', async () => {
    expect(() => setup({ voice: 'unverified-voice' })).toThrow('音色');
    expect(() => setup({ instructions: 'x'.repeat(1001) })).toThrow('1000');
    expect(() => setup({ instructions: 'bad\0instruction' })).toThrow('1000');
    const { provider, fetchImpl } = setup();
    for (const text of ['', ' ', 'x'.repeat(6001), '\0']) await expect(provider.speak(text, 1, signal())).rejects.toMatchObject({ code: 'doubao_tts_text' });
    for (const speed of [0, 4, NaN]) await expect(provider.speak('你好。', speed, signal())).rejects.toMatchObject({ code: 'doubao_tts_speed' });
    await expect(provider.speak('你好。', 1, signal(), '私有书籍原文')).rejects.toMatchObject({ code: 'doubao_tts_section' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 500, 302])('handles HTTP %s without exposing private errors or retrying', async status => {
    const cancel = vi.fn(); const upstream = new Response(new ReadableStream({ cancel }), { status });
    const { provider, fetchImpl } = setup({}, upstream);
    const error = await provider.speak('秘密原文', 1, signal()).catch(error => error);
    expect(error.code).toMatch(/^doubao_tts_(auth|limit|http)$/); expect(error.message).not.toMatch(/fake-private-key|秘密原文/);
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not infer free quota or display raw service diagnostics', async () => {
    const { provider, fetchImpl } = setup({}, response([data, { code: 45000000, message: 'fake-private-key 秘密原文' }]).value);
    const error = await provider.speak('秘密原文', 1, signal()).catch(error => error);
    expect(error).toMatchObject({ code: 'doubao_tts_service' }); expect(error.message).not.toMatch(/fake-private-key|秘密原文/); expect(fetchImpl).toHaveBeenCalledOnce();
  });
  const malformed: unknown[][] = [
    [data], [end], [{ code: 0, data: '%%%=' }, end], [{ code: 0, data: 'AB==' }, end],
    [{ code: 0, data: 42 }, end], [{ code: 0, data: Buffer.from([1]).toString('base64') }, end],
    [data, { code: 20000000, usage: { text_words: -1 } }], [data, { code: 20000000, usage: { text_words: 1.5 } }],
    [data, { code: 20000000, usage: { text_words: '7' } }], [data, { code: 20000000, usage: null }],
    [data, { code: '20000000' }], [data, end, data], [{ data: pcm.toString('base64') }, end], [null],
  ];
  it.each(malformed.map(frames => ({ frames })))('rejects malformed, incomplete or invalid audio/usage response %#', async ({ frames }) => {
    const { provider } = setup({}, response(frames).value);
    await expect(provider.speak('你好。', 1, signal())).rejects.toMatchObject({ code: 'doubao_tts_response' });
  });
  it.each(['not-json\n', '{"code":0,', new Uint8Array([0xff, 0xff])])('rejects invalid JSON or UTF-8 without disclosing it', async content => {
    const { provider } = setup({}, new Response(content));
    await expect(provider.speak('你好。', 1, signal())).rejects.toMatchObject({ code: 'doubao_tts_response' });
  });
  it('bounds advertised and actual response bytes at 8 MiB including non-audio content', async () => {
    const advertised = setup({}, new Response('private body', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }));
    await expect(advertised.provider.speak('你好。', 1, signal())).rejects.toMatchObject({ code: 'doubao_tts_response' });
    const cancel = vi.fn(); const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel });
    const actual = setup({}, new Response(oversized));
    await expect(actual.provider.speak('你好。', 1, signal())).rejects.toMatchObject({ code: 'doubao_tts_response' }); expect(cancel).toHaveBeenCalledOnce();
  });
  it('sanitizes transport failures and never retries another provider', async () => {
    const { provider, fetchImpl } = setup(); fetchImpl.mockRejectedValue(new Error('fake-private-key 秘密原文'));
    const error = await provider.speak('秘密原文', 1, signal()).catch(error => error);
    expect(error).toMatchObject({ code: 'doubao_tts_response' }); expect(error.message).not.toMatch(/fake-private-key|秘密原文/); expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('rejects an already cancelled request before fetch', async () => {
    const controller = new AbortController(); controller.abort('private reason'); const { provider, fetchImpl } = setup();
    await expect(provider.speak('你好。', 1, controller.signal)).rejects.toMatchObject({ code: 'doubao_tts_cancelled' }); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('aborts a pending transport without exposing the caller cancellation reason', async () => {
    const controller = new AbortController(); const { provider, fetchImpl } = setup(); fetchImpl.mockImplementation(() => new Promise(() => {}));
    const result = provider.speak('你好。', 1, controller.signal); controller.abort('private reason');
    await expect(result).rejects.toMatchObject({ code: 'doubao_tts_cancelled', message: expect.not.stringContaining('private reason') });
    expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });
  it('cancels pending reads and releases the stream when stopped', async () => {
    const cancel = vi.fn(); const stream = new ReadableStream<Uint8Array>({ cancel });
    const { provider, fetchImpl } = setup({}, new Response(stream)); const controller = new AbortController();
    const result = provider.speak('你好。', 1, controller.signal); await vi.waitFor(() => expect(stream.locked).toBe(true)); controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'doubao_tts_cancelled' }); expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
    expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });
  it('times out a transport ignoring its signal and cleans up a late response', async () => {
    vi.useFakeTimers(); let release!: (response: Response) => void;
    const { provider, fetchImpl } = setup(); fetchImpl.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const result = provider.speak('你好。', 1, signal()); const check = expect(result).rejects.toMatchObject({ code: 'doubao_tts_timeout' });
    await vi.advanceTimersByTimeAsync(120000); await check;
    const cancel = vi.fn(); release(new Response(new ReadableStream({ cancel }))); await Promise.resolve(); expect(cancel).toHaveBeenCalledOnce();
  });
  it('dispose cancels its own requests and prevents further transmission', async () => {
    const { provider, fetchImpl } = setup(); fetchImpl.mockImplementation(() => new Promise(() => {}));
    const result = provider.speak('你好。', 1, signal()); provider.dispose();
    await expect(result).rejects.toMatchObject({ code: 'doubao_tts_cancelled' }); expect(provider.ready()).toBe(false);
    await expect(provider.speak('下一句。', 1, signal())).rejects.toMatchObject({ code: 'doubao_tts_closed' }); expect(fetchImpl).toHaveBeenCalledOnce();
  });
});