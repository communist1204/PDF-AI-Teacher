import { describe, expect, it } from 'vitest';
import { HttpError, providerError } from '../../apps/server/src/errors';

describe('provider error privacy boundaries', () => {
  it('keeps local errors distinct from provider limits', () => {
    const local = new HttpError(429, 'local_rate_limit', '本机请求过快');
    expect(providerError(local)).toBe(local);
  });
  it('validates both SDK and legacy request IDs without exposing arbitrary values', () => {
    const data = { status: 429, code: 'insufficient_quota', requestID: 'sk-private-value', request_id: 'req_safe_legacy' };
    expect(providerError(data).requestId).toBe('req_safe_legacy');
    expect(providerError({ ...data, request_id: 'https://private.example/key' }).requestId).toBeUndefined();
  });
  it('handles nested quota metadata but never interprets provider message text', () => {
    expect(providerError({ status: 429, error: { type: 'insufficient_quota' } }).code).toBe('provider_quota');
    const mapped = providerError({ status: 429, message: 'insufficient_quota sk-private', error: { code: '<script>secret</script>' } });
    expect(mapped.code).toBe('provider_limit_unknown');
    expect(mapped.message).not.toMatch(/sk-private|script|secret/);
  });
});
