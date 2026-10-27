import { describe, expect, it, vi } from 'vitest';
import { recognizeWithOpenAI, VISION_ENDPOINT } from '../../apps/desktop/providers/openaiVision';
import { renderReadingPlan, type ReadingPlan } from '../../packages/shared/readingPlan';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9FoAAAAASUVORK5CYII=', 'base64');
const table: ReadingPlan = {
  blocks: [{ kind: 'table', text: '从左到右看，这里有三个阶段。', headers: ['阶段', '学习任务'], rows: [
    ['左：潜在动作量化', '看前后两帧，用离散编码表示变化'],
    ['中：潜在动作预训练', '根据当前画面和指令，预测这种编码'],
    ['右：真实动作微调', '用机器人示范，将模型适配为预测实际控制动作'],
  ] }, { kind: 'prose', text: '注意图中输出符号的变化：前两个阶段围绕 z：潜在动作，最后阶段输出 a：机器人动作。', headers: [], rows: [] }],
  omitted: ['source_badges', 'figure_labels'], warnings: [],
};
const response = (plan: unknown = table, status = 'completed') => new Response(JSON.stringify({ status, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }] }));
const options = (fetchImpl: typeof fetch) => ({ apiKey: 'mock-only-secret', allowed: true, skipFormulas: true, fetchImpl });

describe('reading plan validation (authored fixture, not a live model accuracy test)', () => {
  it('pairs each table row with headers instead of reading columns in isolation', () => {
    const { text } = renderReadingPlan(table, true);
    expect(text).toContain('第1行，阶段：左：潜在动作量化；学习任务：看前后两帧，用离散编码表示变化。');
    expect(text.indexOf('离散编码')).toBeLessThan(text.indexOf('潜在动作预训练'));
    expect(text).toContain('预测这种编码'); expect(text).not.toContain('预三');
    expect(text).toContain('z：潜在动作'); expect(text).toContain('a：机器人动作');
    expect(text).not.toContain('arxiv.org');
  });
  it('rejects unequal column counts, extra properties, empty prose, oversized output', () => {
    expect(() => renderReadingPlan({ ...table, blocks: [{ ...table.blocks[0], rows: [['one']] }] }, true)).toThrow();
    expect(() => renderReadingPlan({ ...table, code: 'run' }, true)).toThrow();
    expect(() => renderReadingPlan({ ...table, blocks: [{ kind: 'prose', text: '', headers: [], rows: [] }] }, true)).toThrow();
    expect(() => renderReadingPlan({ ...table, blocks: [{ kind: 'prose', text: '字'.repeat(12001), headers: [], rows: [] }] }, true)).toThrow();
  });
  it('keeps blank cells explicit and skips formula blocks without deleting prose variables', () => {
    const { text } = renderReadingPlan({ ...table, blocks: [
      { ...table.blocks[0], rows: [['阶段一', '']] },
      { kind: 'formula', text: 'a 等于 b。', headers: [], rows: [] },
      table.blocks[1],
    ] }, true);
    expect(text).toContain('学习任务：空白'); expect(text).not.toContain('a 等于 b'); expect(text).toContain('z：潜在动作');
  });
});

describe('OpenAI image planner (mock transport, no real API)', () => {
  it('sends only the PNG to the fixed endpoint, disables storage/reasoning and validates the returned plan', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response());
    const result = await recognizeWithOpenAI(png, options(fetcher), new AbortController().signal);
    expect(result.method).toBe('openai'); expect(result.reviewRequired).toBe(false);
    const [url, init] = fetcher.mock.calls[0]; expect(url).toBe(VISION_ENDPOINT);
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ model: 'gpt-5.4-mini', store: false, reasoning: { effort: 'none' }, max_output_tokens: 6000 });
    expect(body.tools).toBeUndefined(); expect(body.input[0].content[1]).toMatchObject({ type: 'input_image', detail: 'high', image_url: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(JSON.stringify(result)).not.toContain('mock-only-secret');
  });
  it('returns uncertainty explicitly so the UI can require review before reading', async () => {
    const result = await recognizeWithOpenAI(png, options(async () => response({ ...table, warnings: ['第二行有一处字形不清。'] })), new AbortController().signal);
    expect(result.reviewRequired).toBe(true); expect(result.plan?.warnings).toHaveLength(1);
  });
  it('never sends pixels without separate consent or a key', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(recognizeWithOpenAI(png, { ...options(fetcher), allowed: false }, new AbortController().signal)).rejects.toThrow('允许');
    await expect(recognizeWithOpenAI(png, { ...options(fetcher), apiKey: '' }, new AbortController().signal)).rejects.toThrow('Key');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects malformed images before network access', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(recognizeWithOpenAI(Buffer.from('not-an-image'), options(fetcher), new AbortController().signal)).rejects.toThrow('格式');
    expect(fetcher).not.toHaveBeenCalled();
  });
  for (const status of [401, 403, 429, 500]) it('sanitizes service failure without automatic retries: ' + status, async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('private image/secret/raw error', { status }));
    await expect(recognizeWithOpenAI(png, options(fetcher), new AbortController().signal)).rejects.not.toThrow(/private|secret|raw/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses incomplete output, refusal and malformed table instead of pretending success', async () => {
    for (const value of [response(table, 'incomplete'), new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal' }] }] })), response({ ...table, blocks: [{ ...table.blocks[0], rows: [['bad']] }] })]) {
      await expect(recognizeWithOpenAI(png, options(async () => value), new AbortController().signal)).rejects.toThrow();
    }
  });
  it('does not expose raw transport errors even if they begin with OpenAI', async () => {
    await expect(recognizeWithOpenAI(png, options(async () => { throw Error('OpenAI secret-key'); }), new AbortController().signal)).rejects.not.toThrow('secret-key');
  });
  it('can cancel even an uncooperative network request', async () => {
    const controller = new AbortController();
    const work = recognizeWithOpenAI(png, options(() => new Promise(() => {})), controller.signal);
    controller.abort(); await expect(work).rejects.toThrow('取消');
  });
  it('times out once without retrying', async () => {
    vi.useFakeTimers();
    try {
      const work = recognizeWithOpenAI(png, { ...options(() => new Promise(() => {})), timeoutMs: 40 }, new AbortController().signal);
      const checked = expect(work).rejects.toThrow('超时');
      await vi.advanceTimersByTimeAsync(41); await checked;
    } finally { vi.useRealTimers(); }
  });
});
