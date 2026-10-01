import { describe, expect, it } from 'vitest';
import type { Response, ResponseStreamEvent } from 'openai/resources/responses/responses';
import { ResponseTextCollector } from '../../apps/server/src/responseTextCollector';

const textPart = (text: string) => ({ type: 'output_text', text, annotations: [], logprobs: [] });
const message = (text: string, extra = {}) => ({ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [textPart(text)], ...extra });
const completed = (output: unknown[] = []) => ({ id: 'resp_test', status: 'completed', output }) as Response;
const added = (extra = {}, outputIndex = 0) => ({ type: 'response.output_item.added', output_index: outputIndex, item: message('', { status: 'in_progress', content: [], ...extra }) });
const delta = (text: string, extra = {}) => ({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: text, ...extra });
const textDone = (text: string, extra = {}) => ({ type: 'response.output_text.done', output_index: 0, item_id: 'msg_1', content_index: 0, text, ...extra });
function collect(events: unknown[], response = completed()) {
  const collector = new ResponseTextCollector('req_collector');
  events.forEach(event => collector.accept(event as ResponseStreamEvent));
  return collector.finish(response);
}

describe('final assistant Responses text collection', () => {
  it('assembles the official delta/text-done/part-done/item-done sequence without duplicate text', () => {
    const text = '{"answer":"最终回答"}';
    expect(collect([
      added(), delta('{"answer":'), delta('"最终回答"}'), textDone(text),
      { type: 'response.content_part.done', output_index: 0, item_id: 'msg_1', content_index: 0, part: textPart(text) },
      { type: 'response.output_item.done', output_index: 0, item: message(text) },
    ])).toEqual({ text, refused: false });
  });
  it.each(['delta', 'text_done', 'part_done', 'item_done'])('recovers final text from %s when the completed output array is empty', variant => {
    const text = '{"answer":"已经完成"}';
    const event = variant === 'delta' ? delta(text)
      : variant === 'text_done' ? textDone(text)
      : variant === 'part_done' ? { type: 'response.content_part.done', output_index: 0, item_id: 'msg_1', content_index: 0, part: textPart(text) }
      : { type: 'response.output_item.done', output_index: 0, item: message(text) };
    expect(collect([added(), event])).toEqual({ text, refused: false });
  });
  it('accepts an item-done snapshot without preceding incremental events', () => {
    expect(collect([{ type: 'response.output_item.done', output_index: 0, item: message('最终回答') }]).text).toBe('最终回答');
  });
  it('prefers the complete final snapshot over all earlier content', () => {
    expect(collect([added(), delta('partial incorrect'), textDone('earlier')], completed([message('authoritative')])).text).toBe('authoritative');
  });
  it('preserves a finalized item when the terminal snapshot has an empty text part', () => {
    expect(collect([added(), textDone('finalized')], completed([message('')])).text).toBe('finalized');
  });
  it('orders indexed content parts and output messages rather than arrival order', () => {
    expect(collect([
      added({ id: 'msg_2' }, 1), textDone(' C', { output_index: 1, item_id: 'msg_2' }),
      added(), textDone('B', { content_index: 1 }), textDone('A'),
    ]).text).toBe('AB C');
  });
  it.each([
    { type: 'reasoning' }, { role: 'user' }, { phase: 'commentary' },
    { channel: 'analysis' }, { channel: 'commentary' }, { channel: 'reasoning' },
  ])('never takes non-final content from items with %j', extra => {
    expect(collect([added(extra), delta('private chain'), textDone('private chain'), { type: 'response.output_item.done', output_index: 0, item: message('private chain', extra) }], completed([message('private chain', extra)]))).toEqual({ text: '', refused: false });
  });
  it('excludes commentary while selecting only the final answer', () => {
    expect(collect([], completed([
      message('private intermediate', { phase: 'commentary' }),
      message('actual answer', { id: 'msg_2', phase: 'final_answer' }),
    ])).text).toBe('actual answer');
  });
  it('does not reinterpret reasoning deltas or unknown bare text events as a final assistant message', () => {
    expect(collect([
      { type: 'response.reasoning_text.delta', delta: 'private' },
      { type: 'response.reasoning_summary_text.done', text: 'private' },
      textDone('unidentified'), delta('unidentified'),
    ]).text).toBe('');
  });
  it('checks identity and excludes late commentary/incomplete metadata', () => {
    expect(collect([added(), textDone('wrong item', { item_id: 'different' })]).text).toBe('');
    for (const extra of [{ phase: 'commentary' }, { status: 'incomplete' }]) {
      expect(collect([added(), textDone('not final')], completed([message('', extra)])).text).toBe('');
    }
  });
  it('never completes any text when the response itself is incomplete', () => {
    expect(collect([added(), textDone('valid looking text')], { ...completed(), status: 'incomplete' })).toEqual({ text: '', refused: false });
  });
  it('gives a terminal refusal priority over previous generated text without returning provider wording', () => {
    const refusal = { type: 'refusal', refusal: 'private refusal detail' };
    expect(collect([added(), delta('earlier')], completed([message('', { content: [refusal] })]))).toEqual({ text: '', refused: true });
    expect(collect([added(), { type: 'response.content_part.done', output_index: 0, item_id: 'msg_1', content_index: 0, part: refusal }])).toEqual({ text: '', refused: true });
    expect(collect([added(), { type: 'response.refusal.done', output_index: 0, item_id: 'msg_1', content_index: 0, refusal: 'private' }])).toEqual({ text: '', refused: true });
  });
  it('bounds UTF-8 bytes for both event fragments and completed snapshots', () => {
    const tooLarge = '中'.repeat(700000);
    expect(() => collect([added(), delta(tooLarge)])).toThrow(expect.objectContaining({ code: 'model_output_too_large', requestId: 'req_collector' }));
    expect(() => collect([], completed([message(tooLarge)]))).toThrow(expect.objectContaining({ code: 'model_output_too_large' }));
    expect(() => collect([added(), delta('x'.repeat(1024 * 1024)), delta('y'.repeat(1024 * 1024)), delta('z')])).toThrow();
  });
  it('replaces repeated done snapshots without counting the same text against the limit twice', () => {
    const text = 'x'.repeat(1024 * 1024 + 1);
    expect(collect([added(), textDone(text), textDone(text), { type: 'response.output_item.done', output_index: 0, item: message(text) }]).text.length).toBe(text.length);
  });
});
