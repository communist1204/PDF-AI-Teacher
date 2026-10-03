import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../apps/web/src/services/api';
import type { AppConfig, Envelope } from '../../packages/shared/protocol';

const envelope: Envelope = { sessionId: 'session', generationId: 4, contextRevision: 2 };
const headers = { 'x-session-id': 'session', 'x-generation-id': '4', 'x-context-revision': '2', 'x-audio-streaming': '1', 'content-type': 'audio/mpeg' };
const client = () => apiClient({ csrfToken: 'local-token' } as AppConfig, 'speech');
afterEach(() => vi.unstubAllGlobals());

describe('local foreground stream transport', () => {
  it('returns a live body before EOF with envelope, CSRF and speech-lane checks', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; controller.enqueue(new Uint8Array([1, 2])); } });
    const fetch = vi.fn(async () => new Response(body, { headers })); vi.stubGlobal('fetch', fetch);
    const result = await client().speechStream('正文', envelope, 1, new AbortController().signal);
    expect(fetch.mock.calls[0]).toMatchObject(['/api/tts', { headers: { 'x-audio-stream': '1', 'x-task-lane': 'speech', 'x-csrf-token': 'local-token' } }]);
    expect(result).not.toBeInstanceOf(Blob);
    if (result instanceof Blob) throw new Error('Expected streaming body');
    const reader = result.body.getReader(); expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
    source.enqueue(new Uint8Array([3])); source.close(); expect((await reader.read()).value).toEqual(new Uint8Array([3])); expect((await reader.read()).done).toBe(true);
  });

  it('accepts a complete cached response without forcing it through MSE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('cached', { headers: { ...headers, 'x-audio-streaming': '0' } })));
    const result = await client().speechStream('正文', envelope, 1, new AbortController().signal);
    expect(result).toBeInstanceOf(Blob); expect(await (result as Blob).text()).toBe('cached');
  });

  it.each([{ 'x-generation-id': '3' }, { 'content-type': 'text/html' }])('cancels unusable streamed data before creating audio: %j', async invalid => {
    const cancelled = vi.fn(); const body = new ReadableStream({ cancel: cancelled });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { ...headers, ...invalid } })));
    await expect(client().speechStream('正文', envelope, 1, new AbortController().signal)).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
