import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../apps/server/src/config';
import { makeDemoPlan } from '../../apps/server/src/demo';
import { ChatGptTeachingProvider } from '../../apps/server/src/provider';
import type { AskRequest } from '../../packages/shared/protocol';

const request: AskRequest = { sessionId: 'mock-session', generationId: 8, contextRevision: 5, question: '解释截图的公式', context: { documentId: 'book', sources: [{ sourceId: 'selection', documentId: 'book', pageIndex: 4, pageLabel: '1', blockId: 'block', rect: null, sourceText: '' }], selectedBoardText: null, imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }, history: [] };
const config = () => ({ ...readConfig({}), demoMode: false, authMode: 'chatgpt' as const, chatModel: 'chosen-text', visionModel: 'chosen-vision', visionReasoningEffort: 'xhigh' as const });
const plan = makeDemoPlan(request); // Fixture only; production never falls back to this.
const item = (text: string, extra = {}) => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }], ...extra });
const complete = (output: unknown[] = []) => ({ type: 'response.completed', response: { id: 'resp_mock', status: 'completed', output, usage: { input_tokens: 23, output_tokens: 71, total_tokens: 94 } } });
function sse(events: unknown[]) { return new Response(events.map((event, sequence_number) => 'data: ' + JSON.stringify({ sequence_number, ...event as object }) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_board_stream' } }); }
function providerFor(events: unknown[]) {
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => sse(events));
  const provider = new ChatGptTeachingProvider(config(), { getAccessToken: async () => 'test-only-oauth' }, fetcher as typeof fetch);
  return { provider, fetcher };
}

describe('ChatGPT completed Responses through the real SDK, with mocked SSE', () => {
  it('recovers an image question teaching plan from output_item.done when completed.output is empty', async () => {
    const { provider, fetcher } = providerFor([{ type: 'response.output_item.done', output_index: 0, item: item(JSON.stringify(plan)) }, complete()]);
    const result = await provider.ask(request, 'chosen-vision', new AbortController().signal);
    expect(result).toMatchObject({ plan, requestId: 'req_board_stream', inputTokens: 23, outputTokens: 71 });
    expect(fetcher).toHaveBeenCalledOnce();
    const sent = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(sent).toMatchObject({ model: 'chosen-vision', reasoning: { effort: 'xhigh' }, store: false, stream: true });
    expect(sent).not.toHaveProperty('max_output_tokens');
    expect(JSON.stringify(sent.input)).toContain(request.context.imageDataUrl);
  });
  it('uses final_answer instead of commentary JSON from the completed snapshot', async () => {
    const { provider } = providerFor([complete([item('private reasoning', { phase: 'commentary' }), item(JSON.stringify(plan), { id: 'msg_final', phase: 'final_answer' })])]);
    expect((await provider.ask(request, 'chosen-vision', new AbortController().signal)).plan).toEqual(plan);
  });
  it.each([
    ['empty_model_output', []],
    ['empty_model_output', [item('analysis must stay private', { phase: 'commentary' })]],
    ['model_refusal', [item('', { content: [{ type: 'refusal', refusal: 'raw provider detail' }] })]],
    ['invalid_model_output', [item('{broken JSON containing private source text')]],
  ])('reports %s distinctly without forwarding raw provider text', async (code, output) => {
    const { provider, fetcher } = providerFor([complete(output as unknown[])]);
    try { await provider.ask(request, 'chosen-vision', new AbortController().signal); throw new Error('unexpected success'); }
    catch (error) { expect(error).toMatchObject({ code, requestId: 'req_board_stream' }); expect((error as Error).message).not.toMatch(/raw provider|private|analysis/); }
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['response.failed', 'response.incomplete', 'disconnect'])('does not turn finalized text into a plan after %s', async terminal => {
    const events: unknown[] = [{ type: 'response.output_item.done', output_index: 0, item: item(JSON.stringify(plan)) }];
    if (terminal !== 'disconnect') events.push({ type: terminal, response: { status: terminal === 'response.failed' ? 'failed' : 'incomplete', error: { code: 'subscription_sharing_usage_limit_exceeded' }, incomplete_details: { reason: 'max_output_tokens' } } });
    const { provider, fetcher } = providerFor(events);
    if (terminal === 'response.incomplete') expect(await provider.ask(request, 'chosen-vision', new AbortController().signal)).toMatchObject({ plan: null, incompleteReason: 'other' });
    else await expect(provider.ask(request, 'chosen-vision', new AbortController().signal)).rejects.toMatchObject({ code: terminal === 'disconnect' ? 'chatgpt_interrupted_stream' : 'subscription_sharing_usage_limit_exceeded' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('shares corrected stream assembly with explicit reading recognition and preserves usage', async () => {
    const draft = { contextRevision: 5, readingText: '这是朗读稿。', uncertain: false, warnings: [] };
    const { provider } = providerFor([{ type: 'response.output_item.done', output_index: 0, item: item(JSON.stringify(draft)) }, complete()]);
    expect(await provider.readingAssist(request, 'chosen-vision', new AbortController().signal)).toMatchObject({ draft, inputTokens: 23, outputTokens: 71 });
  });
});
