import { describe, expect, it, vi } from 'vitest';
import { recognizeWithChatGPT, VISION_ENDPOINT } from '../../apps/desktop/providers/openaiVision';
import { ReadingCache } from '../../apps/desktop/readingCache';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9FoAAAAASUVORK5CYII=', 'base64');
const plan = { blocks: [{ kind: 'table', text: '学习阶段。', headers: ['阶段', '任务'], rows: [['预训练', '预测这种编码'], ['微调', '预测控制动作']] }], omitted: ['source_badges'], warnings: [] };
const completed = (value: unknown = plan) => ({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] } });
function stream(events: unknown[], fragmented = false) {
  const bytes = new TextEncoder().encode(events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join(''));
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += fragmented ? 7 : bytes.length) controller.enqueue(bytes.slice(i, i + (fragmented ? 7 : bytes.length))); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
const options = (fetchImpl: typeof fetch) => ({ accessToken: 'test-oauth-secret', model: { id: 'account-image-model', label: 'Account model', reasoningEffort: 'none' }, allowed: true, skipFormulas: true, fetchImpl });
const signal = () => new AbortController().signal;
describe('subscription screenshot planning (mock inference)', () => {
  it('uses account model, image input, stream/store contract without paid-route-only fields', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => stream([{ type: 'response.output_text.delta', delta: 'not final' }, completed()], true));
    const result = await recognizeWithChatGPT(png, options(fetcher), signal());
    expect(result.text).toContain('阶段：预训练；任务：预测这种编码');
    expect(result.text.indexOf('预测这种编码')).toBeLessThan(result.text.indexOf('微调'));
    const [url, init] = fetcher.mock.calls[0]; expect(url).toBe(VISION_ENDPOINT);
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', headers: { Authorization: 'Bearer test-oauth-secret' } });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'account-image-model', store: false, stream: true, reasoning: { effort: 'none' } });
    for (const key of ['max_output_tokens', 'temperature', 'tools', 'previous_response_id', 'background']) expect(body[key]).toBeUndefined();
    expect(body.input[0].content[1].image_url).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(result)).not.toContain('test-oauth-secret');
  });
  it('never invents an unsupported reasoning effort', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => stream([completed()]));
    await recognizeWithChatGPT(png, { ...options(fetcher), model: { id: 'visible-model', label: 'Visible' } }, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).reasoning).toBeUndefined();
  });
  it.each(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'])('refuses partial speech after %s and makes no API fallback or retry', async code => {
    const fetcher = vi.fn<typeof fetch>(async () => stream([{ type: 'response.output_text.delta', delta: JSON.stringify(plan) }, { type: 'response.failed', response: { error: { code, message: 'test-oauth-secret' } } }]));
    await expect(recognizeWithChatGPT(png, options(fetcher), signal())).rejects.toThrow('订阅额度'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ type: 'response.output_text.delta', delta: JSON.stringify(plan) }],
    [{ type: 'response.incomplete' }],
    [{ type: 'error', message: 'test-oauth-secret' }],
    [{ type: 'response.completed', response: { status: 'in_progress' } }],
    [completed({ ...plan, blocks: [{ ...plan.blocks[0], rows: [['missing column']] }] })],
  ])('rejects incomplete or invalid final output', async events => {
    await expect(recognizeWithChatGPT(png, options(async () => stream(Array.isArray(events) ? events : [events])), signal())).rejects.toThrow(/未开始朗读|未完整|连接提前/);
  });
  it('blocks requests without independent image permission', async () => {
    const fetcher = vi.fn<typeof fetch>(); await expect(recognizeWithChatGPT(png, { ...options(fetcher), allowed: false }, signal())).rejects.toThrow('允许'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('cancels an unfinished stream and never returns its partial text', async () => {
    const controller = new AbortController(); let cancelled = false;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
    const task = recognizeWithChatGPT(png, options(fetcher), controller.signal); await new Promise(resolve => setTimeout(resolve, 5)); controller.abort();
    await expect(task).rejects.toThrow('取消'); expect(cancelled).toBe(true);
  });
  it('preserves warnings for the UI to require review', async () => {
    const result = await recognizeWithChatGPT(png, options(async () => stream([completed({ ...plan, warnings: ['第二行不清楚'] })])), signal());
    expect(result.reviewRequired).toBe(true);
  });
  it('bounds timeout even when transport ignores abort', async () => {
    await expect(recognizeWithChatGPT(png, { ...options(() => new Promise(() => {})), timeoutMs: 10 }, signal())).rejects.toThrow('超时');
  });
  it.each([401, 403, 429, 500])('sanitizes HTTP %s and does not retry', async status => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('test-oauth-secret', { status }));
    await expect(recognizeWithChatGPT(png, options(fetcher), signal())).rejects.not.toThrow('test-oauth-secret'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
it('reuses only completed plans for the same image/account/model/options, in bounded memory', () => {
  const cache = new ReadingCache(), value = { text: 'test', language: 'zh-Hans', method: 'openai' as const };
  const key = cache.key(png, 'account-a', 'model-a', true); cache.put(key, value, signal());
  expect(cache.get(key)).toEqual(value); expect(cache.get(cache.key(png, 'account-b', 'model-a', true))).toBeUndefined();
  expect(cache.get(cache.key(png, 'account-a', 'model-b', true))).toBeUndefined(); expect(cache.get(cache.key(png, 'account-a', 'model-a', false))).toBeUndefined();
  const copy = cache.get(key)!; copy.text = 'changed'; expect(cache.get(key)?.text).toBe('test');
  cache.put('warning', { ...value, reviewRequired: true }, signal()); expect(cache.get('warning')).toBeUndefined();
  const stopped = new AbortController(); stopped.abort(); cache.put('cancelled', value, stopped.signal); expect(cache.get('cancelled')).toBeUndefined();
  for (let i = 0; i < 4; i++) cache.put('new-' + i, value, signal()); expect(cache.get(key)).toBeUndefined();
  cache.clear(); expect(cache.get('new-3')).toBeUndefined();
});
