import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey } from 'jose';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ChatGPTAccountService } from '../../apps/desktop/chatgpt/accounts';
import type { Cipher } from '../../apps/desktop/settings';

const ISSUER = 'https://auth.openai.com';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const CLIENT = 'oaiapp_reader_test';
let privateKey: CryptoKey; let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
const temporary: string[] = []; const services: ChatGPTAccountService[] = [];
const cipher: Cipher = { available: () => true,
  encrypt: value => Buffer.from(Buffer.from(value).toString('base64')),
  decrypt: value => Buffer.from(value.toString(), 'base64').toString() };
beforeAll(async () => {
  const keys = await generateKeyPair('RS256'); privateKey = keys.privateKey;
  publicJwk = { ...await exportJWK(keys.publicKey), kid: 'reader-test', alg: 'RS256', use: 'sig' };
});
afterEach(async () => {
  services.splice(0).forEach(service => service.dispose());
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Timed out waiting for local mock flow');
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'qingread-auth-test-')); temporary.push(directory);
  const path = join(directory, 'test.bin');
  const state = {
    opened: [] as URL[], calls: [] as { url: string; init?: RequestInit }[],
    scopes: SCOPE, subject: 'test-subject', wrongNonce: false, wrongAudience: false,
    issuer: ISSUER, client: CLIENT, codeStatus: 200, refreshStatus: 200, revokeStatus: 200,
    tokenDelay: null as Promise<void> | null, refreshDelay: null as Promise<void> | null,
    modelStatus: 200, modelCalls: 0, refreshCalls: 0, codeCalls: 0, revokeCalls: 0,
    expiresIn: 3600,
    models: [
      { slug: 'image-fast', display_name: 'Image Fast', visibility: 'list', input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'high' }, { effort: 'low' }, { effort: 'none' }] },
      { slug: 'text-only', display_name: 'Text', visibility: 'list', input_modalities: ['text'] },
      { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'unknown-capabilities', display_name: 'Unknown', visibility: 'list', supported_reasoning_efforts: ['minimal', 'low'] },
    ] as unknown[],
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input); state.calls.push({ url, init });
    if (url === ISSUER + '/.well-known/openid-configuration') return json({
      issuer: ISSUER, authorization_endpoint: ISSUER + '/api/accounts/authorize', token_endpoint: ISSUER + '/api/accounts/oauth/token',
      jwks_uri: ISSUER + '/.well-known/jwks.json', revocation_endpoint: ISSUER + '/api/accounts/oauth/revoke', id_token_signing_alg_values_supported: ['RS256'],
    });
    if (url === ISSUER + '/.well-known/jwks.json') return json({ keys: [publicJwk] });
    if (url === ISSUER + '/api/accounts/oauth/token') {
      const params = new URLSearchParams(String(init?.body));
      if (params.get('grant_type') === 'refresh_token') {
        state.refreshCalls++; if (state.refreshDelay) await state.refreshDelay;
        if (state.refreshStatus !== 200) return json({ error: 'invalid_grant', error_description: 'SENSITIVE_SERVER_ERROR' }, state.refreshStatus);
        return json({ access_token: 'SENSITIVE_ACCESS_REFRESHED', refresh_token: 'SENSITIVE_REFRESH_ROTATED_' + state.refreshCalls, token_type: 'Bearer', scope: state.scopes, expires_in: 3600 });
      }
      state.codeCalls++;
      if (state.tokenDelay) await state.tokenDelay;
      if (state.codeStatus !== 200) return json({ error: 'invalid_grant', error_description: 'SENSITIVE_SERVER_ERROR' }, state.codeStatus);
      const authorization = state.opened.at(-1)!;
      expect(params.get('client_id')).toBe(state.client);
      expect(params.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'));
      expect(params.get('resource')).toBe('https://api.openai.com/v1');
      expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
      const idToken = await new SignJWT({ nonce: state.wrongNonce ? 'wrong' : authorization.searchParams.get('nonce'), email: 'test@example.test' })
        .setProtectedHeader({ alg: 'RS256', kid: 'reader-test' }).setIssuer(state.issuer).setAudience(state.wrongAudience ? 'wrong-client' : state.client)
        .setSubject(state.subject).setIssuedAt().setExpirationTime('1h').sign(privateKey);
      return json({ access_token: 'SENSITIVE_ACCESS', refresh_token: 'SENSITIVE_REFRESH', id_token: idToken, scope: state.scopes, expires_in: state.expiresIn, token_type: 'Bearer' });
    }
    if (url === 'https://api.openai.com/v1/models') { state.modelCalls++; return json(state.modelStatus === 200 ? { models: state.models } : { detail: 'SENSITIVE_SERVER_ERROR' }, state.modelStatus); }
    if (url === ISSUER + '/api/accounts/oauth/revoke') { state.revokeCalls++; return state.revokeStatus === 200 ? new Response(null, { status: 200 }) : json({ detail: 'SENSITIVE_SERVER_ERROR' }, state.revokeStatus); }
    throw Error('Unexpected endpoint');
  };
  const service = new ChatGPTAccountService({ path, cipher, fetchImpl, openExternal: async url => { state.opened.push(new URL(url)); } });
  services.push(service); await service.load();
  const callback = async (overrides: Record<string, string | null> = {}) => {
    const opened = state.opened.at(-1)!; const url = new URL(opened.searchParams.get('redirect_uri')!);
    url.searchParams.set('state', opened.searchParams.get('state')!); url.searchParams.set('code', 'test-code');
    url.searchParams.set('client_id', state.client);
    for (const [key, value] of Object.entries(overrides)) { if (value === null) url.searchParams.delete(key); else url.searchParams.set(key, value); }
    return fetch(url);
  };
  const login = async () => {
    await service.beginLogin(); const response = await callback(); expect(response.status).toBe(200);
    await until(() => service.getState().status !== 'authorizing'); await service.flush();
  };
  return { service, state, path, fetchImpl, callback, login };
}

describe('official ChatGPT account flow (mock service, no real requests)', () => {
  it('opens PKCE login, verifies signed identity and exposes only safe account/model state', async () => {
    const h = await harness(); await h.login();
    const opened = h.state.opened[0];
    expect(opened.origin + opened.pathname).toBe(ISSUER + '/api/accounts/authorize');
    expect(opened.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(opened.searchParams.get('agent_name_hint')).toBe('QingRead');
    expect(opened.searchParams.get('scope')).toBe(SCOPE);
    expect(opened.searchParams.get('code_challenge_method')).toBe('S256');
    expect(opened.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    expect(opened.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(h.service.getState()).toMatchObject({ status: 'connected', sharing: true, models: [
      { id: 'image-fast', reasoningEffort: 'none' }, { id: 'unknown-capabilities', reasoningEffort: 'minimal' },
    ] });
    expect(JSON.stringify(h.service.getState())).not.toMatch(/SENSITIVE|idToken|accessToken|refreshToken|code_challenge|authorize\?/);
    expect((await readFile(h.path)).toString()).not.toContain('SENSITIVE');
    expect(h.state.calls.every(call => call.init?.credentials === 'omit' && call.init.redirect === 'error')).toBe(true);
    expect(h.state.calls.some(call => call.url.includes('/responses'))).toBe(false);
  });
  it('rejects mismatched and duplicated state without exchanging credentials', async () => {
    const h = await harness(); await h.service.beginLogin();
    const response = await h.callback({ state: 'wrong' }); expect(response.status).toBe(400);
    expect(h.state.codeCalls).toBe(0); expect(h.service.getState().status).toBe('authorizing');
    await h.service.cancelLogin(); expect(h.service.getState().status).toBe('disconnected');
  });
  it('handles denied consent without any network token call', async () => {
    const h = await harness(); await h.service.beginLogin();
    await h.callback({ error: 'access_denied' }); await h.service.flush();
    expect(h.state.codeCalls).toBe(0); expect(h.service.getState().sharing).toBe(false);
  });
  it('requires an issued client ID and preserves it before an invalid-grant exchange', async () => {
    const h = await harness(); await h.service.beginLogin(); await h.callback({ client_id: null });
    await h.service.flush(); expect(h.state.codeCalls).toBe(0);
    h.state.codeStatus = 400; await h.service.beginLogin(); await h.callback();
    await until(() => h.service.getState().status !== 'authorizing'); await h.service.flush();
    const profile = h.service.getState().profiles[0]; expect(profile.connected).toBe(false);
    await h.service.beginLogin(profile.id);
    expect(h.state.opened.at(-1)!.searchParams.get('client_id')).toBe(CLIENT);
    expect(h.state.opened.at(-1)!.searchParams.has('agent_name_hint')).toBe(false);
    expect(h.state.opened.at(-1)!.searchParams.get('ext_agent_host_id')).toBe(h.state.opened[0].searchParams.get('ext_agent_host_id'));
  });
  it.each(['wrongNonce', 'wrongAudience'] as const)('rejects a signed ID token with %s', async flag => {
    const h = await harness(); h.state[flag] = true;
    await h.service.beginLogin(); await h.callback(); await until(() => h.service.getState().status !== 'authorizing'); await h.service.flush();
    expect(h.service.getState().status).toBe('disconnected'); expect(h.state.modelCalls).toBe(0);
    expect(h.service.getState().message).toContain('身份验证失败');
  });
  it('does not enable plan usage without the returned direct scope', async () => {
    const h = await harness(); h.state.scopes = 'openid profile email'; await h.login();
    expect(h.service.getState()).toMatchObject({ status: 'connected', sharing: false, models: [] });
    expect(h.state.modelCalls).toBe(0);
    await expect(h.service.getAccess('', new AbortController().signal)).rejects.toThrow('授权');
    await h.service.beginLogin(h.service.getState().activeProfileId!);
    expect(h.state.opened.at(-1)!.searchParams.get('prompt')).toBe('consent');
  });
  it('cancellation during the code exchange prevents late credentials becoming active', async () => {
    const h = await harness(); let release!: () => void;
    h.state.tokenDelay = new Promise<void>(resolve => { release = resolve; });
    await h.service.beginLogin(); await h.callback(); await until(() => h.state.codeCalls === 1);
    await h.service.cancelLogin(); release(); await h.service.flush();
    expect(h.service.getState().status).toBe('disconnected'); expect(h.service.getState().sharing).toBe(false);
    expect(h.state.modelCalls).toBe(0);
  });
  it('rejects another identity on reconnect without replacing the original registration', async () => {
    const h = await harness(); await h.login(); const before = h.service.getState();
    h.state.subject = 'other-user';
    await h.service.beginLogin(before.activeProfileId!); await h.callback({ client_id: null });
    await until(() => h.service.getState().status !== 'authorizing'); await h.service.flush();
    expect(h.service.getState().activeProfileId).toBe(before.activeProfileId);
    expect(h.service.getState().message).toContain('账号与所选连接不一致');
    expect(h.service.getState().sharing).toBe(true);
  });
  it('rejects a changed issued client on reconnect', async () => {
    const h = await harness(); await h.login(); const count = h.state.codeCalls;
    await h.service.beginLogin(h.service.getState().activeProfileId!); await h.callback({ client_id: 'oaiapp_other' });
    await h.service.flush(); expect(h.state.codeCalls).toBe(count); expect(h.service.getState().sharing).toBe(true);
  });
  it('keeps multiple registrations separate even when their email matches', async () => {
    const h = await harness(); await h.login(); const first = h.service.getState().activeProfileId!;
    h.state.client = 'oaiapp_second'; await h.login();
    const state = h.service.getState(); expect(state.profiles).toHaveLength(2);
    expect(state.profiles[0].label).not.toBe(state.profiles[1].label);
    await h.service.selectProfile(first); expect(h.service.getState().activeProfileId).toBe(first);
  });
  it('serializes refreshes and persists rotated credentials for restart', async () => {
    const h = await harness(); await h.login();
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 3_550_000);
    const results = await Promise.all([h.service.getAccess('', new AbortController().signal), h.service.getAccess('image-fast', new AbortController().signal)]);
    expect(h.state.refreshCalls).toBe(1); expect(results.every(result => result.accessToken === 'SENSITIVE_ACCESS_REFRESHED')).toBe(true);
    const saved = JSON.parse(cipher.decrypt(await readFile(h.path)));
    expect(saved.profiles[0].refreshToken).toBe('SENSITIVE_REFRESH_ROTATED_1');
    const reopened = new ChatGPTAccountService({ path: h.path, cipher, fetchImpl: h.fetchImpl, openExternal: async () => {} }); services.push(reopened);
    const before = h.state.calls.length; await reopened.load(); expect(h.state.calls.length).toBe(before);
    expect(reopened.getState().sharing).toBe(true);
  });
  it('clears unusable refresh tokens but retains registration for reconnect', async () => {
    const h = await harness(); await h.login(); h.state.refreshStatus = 400;
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 3_550_000);
    await expect(h.service.getAccess('', new AbortController().signal)).rejects.toThrow('重新登录');
    expect(h.service.getState().sharing).toBe(false);
    expect(h.service.getState().profiles).toHaveLength(1);
    expect(JSON.stringify(h.service.getState())).not.toContain('SENSITIVE');
  });
  it('signout revokes the renewable session and retains no tokens', async () => {
    const h = await harness(); await h.login(); await h.service.signOut();
    expect(h.state.revokeCalls).toBe(1); expect(h.service.getState()).toMatchObject({ status: 'disconnected', sharing: false, models: [] });
    const saved = JSON.parse(cipher.decrypt(await readFile(h.path)));
    expect(saved.profiles[0]).toMatchObject({ clientId: CLIENT, accessToken: '', refreshToken: '', idToken: '' });
  });
  it('reports unconfirmed remote revocation without retaining local credentials', async () => {
    const h = await harness(); await h.login(); h.state.revokeStatus = 500; await h.service.signOut();
    expect(h.service.getState().message).toContain('远程撤销未确认');
    expect(h.service.getState().sharing).toBe(false);
    expect(JSON.stringify(h.service.getState())).not.toContain('SENSITIVE');
  });
  it('model errors preserve credentials and never surface raw response text', async () => {
    const h = await harness(); h.state.modelStatus = 403; await h.login();
    expect(h.service.getState().sharing).toBe(true); expect(h.service.getState().models).toEqual([]);
    expect(h.service.getState().message).toContain('权限'); expect(h.service.getState().message).not.toContain('SENSITIVE');
    await expect(h.service.getAccess('', new AbortController().signal)).rejects.toThrow('权限');
  });
  it('stops a pre-cancelled request before accessing the network', async () => {
    const h = await harness(); await h.login(); const count = h.state.calls.length;
    const controller = new AbortController(); controller.abort();
    await expect(h.service.getAccess('', controller.signal)).rejects.toThrow('取消');
    expect(h.state.calls.length).toBe(count);
  });
  it('does not overwrite a damaged encrypted file', async () => {
    const h = await harness(); await writeFile(h.path, 'damaged');
    await expect(h.service.load()).rejects.toThrow('原文件未被覆盖');
    await expect(h.service.beginLogin()).rejects.toThrow();
    expect(await readFile(h.path, 'utf8')).toBe('damaged');
  });
  it('cancels access promptly while a refresh transport ignores cancellation', async () => {
    const h = await harness(); await h.login(); let release!: () => void;
    h.state.refreshDelay = new Promise<void>(resolve => { release = resolve; });
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 3_550_000);
    const controller = new AbortController(); const access = h.service.getAccess('', controller.signal);
    await until(() => h.state.refreshCalls === 1); controller.abort();
    await expect(access).rejects.toThrow('取消'); release();
    await h.service.flush();
  });
  it('a refresh finishing after signout cannot restore credentials', async () => {
    const h = await harness(); await h.login(); let release!: () => void;
    h.state.refreshDelay = new Promise<void>(resolve => { release = resolve; });
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 3_550_000);
    const access = h.service.getAccess('', new AbortController().signal).catch(error => error);
    await until(() => h.state.refreshCalls === 1); await h.service.signOut(); release(); await access; await h.service.flush();
    expect(h.service.getState().sharing).toBe(false);
    const saved = JSON.parse(cipher.decrypt(await readFile(h.path)));
    expect(saved.profiles[0].refreshToken).toBe('');
  });
  it('rejects a different issuer even when the signing key is trusted', async () => {
    const h = await harness(); h.state.issuer = 'https://other.example.test';
    await h.service.beginLogin(); await h.callback(); await until(() => h.service.getState().status !== 'authorizing'); await h.service.flush();
    expect(h.service.getState().status).toBe('disconnected'); expect(h.state.modelCalls).toBe(0);
  });
  it('rejects duplicate callback state and replayed codes', async () => {
    const h = await harness(); await h.service.beginLogin();
    const opened = h.state.opened.at(-1)!; const url = new URL(opened.searchParams.get('redirect_uri')!);
    url.searchParams.append('state', opened.searchParams.get('state')!); url.searchParams.append('state', opened.searchParams.get('state')!);
    url.searchParams.set('client_id', CLIENT); url.searchParams.set('code', 'test');
    expect((await fetch(url)).status).toBe(400); expect(h.state.codeCalls).toBe(0);
    await h.callback(); await until(() => h.service.getState().status !== 'authorizing'); await h.service.flush();
    await expect(fetch(url)).rejects.toThrow(); expect(h.state.codeCalls).toBe(1);
  });

});
