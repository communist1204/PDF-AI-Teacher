import { beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ChatGptAuthManager, type AuthStore } from '../../apps/desktop/auth';

const ISSUER = 'https://auth.openai.com';
const AUTH = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const REVOKE = `${ISSUER}/oauth/revoke`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const MODELS = 'https://api.openai.com/v1/models';
const DIRECT = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>;
let otherKey: Awaited<ReturnType<typeof generateKeyPair>>;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => { signingKey = await generateKeyPair('RS256'); otherKey = await generateKeyPair('RS256'); publicJwk = { ...await exportJWK(signingKey.publicKey), kid: 'mock-signing', alg: 'RS256', use: 'sig' }; });
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
async function harness(initial?: AuthStore, options: { autoCallback?: boolean; loginTimeoutMs?: number } = {}) {
  let persisted = initial ? structuredClone(initial) : null;
  let now = Date.now(); let refreshGate: Promise<void> | undefined; let writeGate: Promise<void> | undefined;
  const state = { scope: DIRECT, subject: 'mock-subject-a', clientId: 'oaiapp_mock_account', callbackState: '', callbackClientId: '', callbackError: '', tokenError: '', tokenStatus: 400, invalidIdentity: '', revokeFail: false, discoveryHostile: false, openFail: false };
  const opened: URL[] = []; const tokenRequests: URLSearchParams[] = []; const network: Array<{ url: string; init?: RequestInit }> = [];
  const writeAuth = vi.fn(async (store: AuthStore) => { await writeGate; persisted = structuredClone(store); });
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); network.push({ url, init });
    if (url === DISCOVERY) return json({ issuer: ISSUER, authorization_endpoint: AUTH, token_endpoint: TOKEN, jwks_uri: state.discoveryHostile ? 'https://untrusted.example/keys' : JWKS, revocation_endpoint: REVOKE });
    if (url === JWKS) return json({ keys: [publicJwk] });
    if (url === TOKEN) {
      const body = init!.body as URLSearchParams; tokenRequests.push(body);
      if (state.tokenError) return json({ error: state.tokenError, error_description: 'sensitive-upstream-diagnostic' }, state.tokenStatus);
      if (body.get('grant_type') === 'refresh_token') { await refreshGate; return json({ token_type: 'Bearer', access_token: 'mock-refreshed-access', refresh_token: 'mock-rotated-refresh', expires_in: 3600, scope: state.scope }); }
      const authorize = opened.at(-1)!;
      const nonce = state.invalidIdentity === 'nonce' ? 'wrong-nonce' : authorize.searchParams.get('nonce')!;
      const id = await new SignJWT({ nonce, email: 'test@example.invalid' }).setProtectedHeader({ alg: 'RS256', kid: 'mock-signing' }).setIssuer(state.invalidIdentity === 'issuer' ? 'https://wrong.example' : ISSUER).setAudience(state.invalidIdentity === 'audience' ? 'wrong-client' : state.clientId).setSubject(state.invalidIdentity === 'subject' ? '' : state.subject).setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(now / 1000) + (state.invalidIdentity === 'expiration' ? -60 : 3600)).sign(state.invalidIdentity === 'signature' ? otherKey.privateKey : signingKey.privateKey);
      return json({ access_token: 'mock-private-access', refresh_token: 'mock-private-refresh', id_token: id, token_type: 'Bearer', expires_in: 3600, scope: state.scope });
    }
    if (url === MODELS) return json({ models: [{ slug: 'model-first', display_name: 'First model', visibility: 'list' }, { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' }, { slug: 'model-second', display_name: 'Second model', visibility: 'list' }] });
    if (url === REVOKE) return state.revokeFail ? new Response('', { status: 503 }) : new Response('', { status: 200 });
    throw new Error('Unexpected network destination in offline test');
  });
  const openExternal = vi.fn(async (raw: string) => {
    if (state.openFail) throw new Error('private-browser-diagnostic');
    const url = new URL(raw); opened.push(url);
    expect(persisted?.hostId).toBe(url.searchParams.get('ext_agent_host_id'));
    if (options.autoCallback === false) return;
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', state.callbackState || url.searchParams.get('state')!);
    callback.searchParams.set('client_id', state.callbackClientId || state.clientId);
    if (state.callbackError) callback.searchParams.set('error', state.callbackError); else callback.searchParams.set('code', 'mock-one-time-code');
    await fetch(callback);
  });
  const manager = new ChatGptAuthManager({ readAuth: async () => persisted, writeAuth, openExternal, fetch: fetcher as typeof fetch, now: () => now, loginTimeoutMs: options.loginTimeoutMs ?? 1000 });
  await manager.initialize();
  return { manager, state, opened, tokenRequests, network, fetcher, writeAuth, gateRefresh: (gate: Promise<void>) => { refreshGate = gate; }, gateWrite: (gate: Promise<void>) => { writeGate = gate; }, persisted: () => persisted!, advance: (ms: number) => { now += ms; } };
}

describe('desktop ChatGPT OAuth (official endpoints mocked; real local callback and JWT verification)', () => {
  it('registers with fresh state/nonce/S256 and an exact loopback redirect; saves only validated credentials', async () => {
    const h = await harness();
    try {
      const result = await h.manager.login();
      expect(result.status).toBe('signed_in'); expect(result.email).toBe('test@example.invalid');
      const url = h.opened[0]; expect(url.origin + url.pathname).toBe(AUTH);
      expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client'); expect(url.searchParams.get('agent_name_hint')).toBe('PDF AI Teacher');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(url.searchParams.get('scope')).toBe(DIRECT);
      expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
      const exchange = h.tokenRequests[0]; expect(exchange.get('client_id')).toBe(h.state.clientId); expect(exchange.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
      const { createHash } = await import('node:crypto');
      expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
      expect(exchange.has('client_secret')).toBe(false); expect(exchange.get('resource')).toBe('https://api.openai.com/v1');
      const saved = h.persisted(); expect(saved.accounts[0]).toMatchObject({ clientId: h.state.clientId, subject: h.state.subject, issuer: ISSUER });
      expect(saved.accounts[0].credentials?.accessToken).toBe('mock-private-access');
      expect(JSON.stringify(result)).not.toMatch(/mock-private|idToken|clientId|refreshToken|nonce|code_verifier/);
      expect(h.network.every(call => call.init?.redirect === 'error')).toBe(true);
      await expect(fetch(url.searchParams.get('redirect_uri')!)).rejects.toThrow();
    } finally { h.manager.dispose(); }
  });
  it.each(['nonce', 'issuer', 'audience', 'expiration', 'signature', 'subject'])('rejects invalid ID-token %s before creating an account', async invalid => {
    const h = await harness(); h.state.invalidIdentity = invalid;
    try { await expect(h.manager.login()).rejects.toThrow('身份验证失败'); expect(h.persisted().accounts).toHaveLength(0); }
    finally { h.manager.dispose(); }
  });
  it.each(['state', 'denied', 'dynamic-client'])('rejects %s callbacks before exchanging any code', async kind => {
    const h = await harness();
    if (kind === 'state') h.state.callbackState = 'foreign-state';
    if (kind === 'denied') h.state.callbackError = 'access_denied';
    if (kind === 'dynamic-client') h.state.callbackClientId = 'dynamic_agent_client';
    try { await expect(h.manager.login()).rejects.toThrow(); expect(h.tokenRequests).toHaveLength(0); expect(h.persisted().accounts).toHaveLength(0); }
    finally { h.manager.dispose(); }
  });
  it('keeps valid identity when plan permission is declined but never invokes models', async () => {
    const h = await harness(); h.state.scope = 'openid email profile';
    try {
      const snapshot = await h.manager.login(); expect(snapshot.status).toBe('signed_in'); expect(snapshot.message).toContain('尚未授权');
      await expect(h.manager.listModels()).rejects.toThrow('尚未授权'); expect(h.network.some(call => call.url === MODELS)).toBe(false);
      await h.manager.login(snapshot.activeAccountId);
      expect(h.opened[1].searchParams.get('prompt')).toBe('consent');
    } finally { h.manager.dispose(); }
  });
  it('returns only visible account-specific models in server order and never exposes bearer tokens', async () => {
    const h = await harness();
    try {
      await h.manager.login(); expect(await h.manager.listModels()).toEqual([{ id: 'model-first', name: 'First model' }, { id: 'model-second', name: 'Second model' }]);
      const call = h.network.find(item => item.url === MODELS)!; expect(new Headers(call.init?.headers).get('Authorization')).toBe('Bearer mock-private-access');
      expect(h.network.some(call => /backend-api|audio|responses/.test(call.url))).toBe(false);
    } finally { h.manager.dispose(); }
  });
  it('serializes rotating refreshes and preserves registration and host across restart', async () => {
    const h = await harness();
    try {
      await h.manager.login(); h.advance(3600000);
      expect(await Promise.all([h.manager.getAccessToken(), h.manager.getAccessToken()])).toEqual(['mock-refreshed-access', 'mock-refreshed-access']);
      expect(h.tokenRequests).toHaveLength(2); expect(h.tokenRequests[1].get('grant_type')).toBe('refresh_token');
      expect(h.tokenRequests[1].get('client_id')).toBe(h.state.clientId); expect(h.tokenRequests[1].has('scope')).toBe(false);
      expect(h.persisted().accounts[0].credentials?.refreshToken).toBe('mock-rotated-refresh');
      const restarted = await harness(h.persisted());
      try { expect(restarted.persisted().hostId).toBe(h.persisted().hostId); expect(await restarted.manager.getAccessToken()).toBe('mock-refreshed-access'); expect(restarted.network).toHaveLength(0); }
      finally { restarted.manager.dispose(); }
    } finally { h.manager.dispose(); }
  });
  it.each(['network', 'persistence'])('retains rotated credentials for account A when switching to B during %s, but rejects the old request', async phase => {
    const h = await harness();
    try {
      const first = await h.manager.login(); h.state.clientId = 'oaiapp_second'; h.state.subject = 'mock-subject-b';
      const second = await h.manager.login(); await h.manager.selectAccount(first.activeAccountId!); h.advance(3600000);
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      if (phase === 'network') h.gateRefresh(gate); else h.gateWrite(gate);
      const writesBefore = h.writeAuth.mock.calls.length;
      const pending = h.manager.getAccessToken(); const assertion = expect(pending).rejects.toThrow('账号已切换');
      if (phase === 'network') await vi.waitFor(() => expect(h.tokenRequests).toHaveLength(3));
      else await vi.waitFor(() => expect(h.writeAuth.mock.calls.length).toBeGreaterThan(writesBefore));
      const switching = h.manager.selectAccount(second.activeAccountId!);
      await vi.waitFor(() => expect(h.manager.snapshot().activeAccountId).toBe(second.activeAccountId));
      release(); await assertion; await switching;
      expect(h.persisted().accounts.find(account => account.id === first.activeAccountId)?.credentials?.refreshToken).toBe('mock-rotated-refresh');
      expect(h.persisted().activeAccountId).toBe(second.activeAccountId);
    } finally { h.manager.dispose(); }
  });
  it('clears unusable refresh tokens but retains client mapping for safe reauthorization', async () => {
    const h = await harness();
    try {
      await h.manager.login(); const original = h.persisted(); h.advance(3600000); h.state.tokenError = 'invalid_grant';
      await expect(h.manager.getAccessToken()).rejects.toThrow('登录已失效');
      expect(h.manager.snapshot().status).toBe('expired'); expect(h.persisted().accounts[0].credentials).toBeUndefined();
      expect(h.persisted().accounts[0].clientId).toBe(original.accounts[0].clientId);
      h.state.tokenError = ''; await h.manager.login(original.activeAccountId);
      const url = h.opened[1]; expect(url.searchParams.get('client_id')).toBe(original.accounts[0].clientId); expect(url.searchParams.has('agent_name_hint')).toBe(false);
      expect(url.searchParams.has('id_token_hint')).toBe(false); expect(url.searchParams.get('ext_agent_host_id')).toBe(original.hostId);
    } finally { h.manager.dispose(); }
  });
  it('preserves credentials during a temporary refresh failure and sanitizes upstream text', async () => {
    const h = await harness();
    try {
      await h.manager.login(); const original = h.persisted(); h.advance(3600000); h.state.tokenError = 'temporarily_unavailable'; h.state.tokenStatus = 503;
      await expect(h.manager.getAccessToken()).rejects.toThrow('已保留登录信息');
      expect(h.persisted()).toEqual(original); expect(JSON.stringify(h.manager.snapshot())).not.toContain('sensitive-upstream-diagnostic');
    } finally { h.manager.dispose(); }
  });
  it('reauthorizes only the chosen identity, preserves hints, and rejects changed client or subject', async () => {
    const h = await harness();
    try {
      const first = await h.manager.login(); const saved = h.persisted();
      h.state.callbackClientId = 'oaiapp_wrong_client'; await expect(h.manager.login(first.activeAccountId)).rejects.toThrow('不匹配');
      expect(h.tokenRequests).toHaveLength(1); expect(h.persisted()).toEqual(saved);
      h.state.callbackClientId = ''; h.state.subject = 'foreign-subject'; await expect(h.manager.login(first.activeAccountId)).rejects.toThrow('不一致');
      expect(h.persisted()).toEqual(saved);
      expect(h.opened[1].searchParams.get('id_token_hint')).toBe(saved.accounts[0].credentials?.idToken);
      expect(h.opened[1].searchParams.get('state')).not.toBe(h.opened[0].searchParams.get('state'));
      expect(h.opened[1].searchParams.get('nonce')).not.toBe(h.opened[0].searchParams.get('nonce'));
    } finally { h.manager.dispose(); }
  });
  it('stores separate same-email registrations and switches without mixing tokens', async () => {
    const h = await harness();
    try {
      const first = await h.manager.login(); h.state.clientId = 'oaiapp_second'; h.state.subject = 'mock-subject-b';
      const second = await h.manager.login(); expect(second.accounts).toHaveLength(2); expect(second.activeAccountId).not.toBe(first.activeAccountId);
      expect(second.accounts[0].label).not.toBe(second.accounts[1].label);
      await h.manager.selectAccount(first.activeAccountId!); expect(h.manager.snapshot().activeAccountId).toBe(first.activeAccountId);
      expect(h.persisted().accounts.map(item => item.clientId)).toEqual(['oaiapp_mock_account', 'oaiapp_second']);
    } finally { h.manager.dispose(); }
  });
  it.each([false, true])('signs out locally and reports whether remote revocation failed=%s', async failed => {
    const h = await harness();
    try {
      await h.manager.login(); const old = h.persisted(); h.state.revokeFail = failed;
      const snapshot = await h.manager.logout(); expect(snapshot.status).toBe('signed_out'); expect(h.persisted().accounts[0].credentials).toBeUndefined();
      expect(h.persisted().hostId).toBe(old.hostId); expect(h.persisted().accounts[0].clientId).toBe(old.accounts[0].clientId);
      const calls = h.network.filter(call => call.url === REVOKE); expect(calls).toHaveLength(failed ? 2 : 1);
      expect((calls[0].init!.body as URLSearchParams).get('token_type_hint')).toBe('refresh_token');
      expect(Boolean(snapshot.message?.includes('未能确认远端撤销'))).toBe(failed);
      await expect(h.manager.getAccessToken()).rejects.toThrow('登录 ChatGPT');
    } finally { h.manager.dispose(); }
  });
  it('cancels and times out pending login, closes its listener, and rejects duplicate attempts', async () => {
    const h = await harness(undefined, { autoCallback: false });
    try {
      const pending = h.manager.login(); const assertion = expect(pending).rejects.toThrow('取消');
      await vi.waitFor(() => expect(h.opened).toHaveLength(1));
      await expect(h.manager.login()).rejects.toThrow('已有登录窗口');
      h.manager.cancelLogin(); await assertion; expect(h.tokenRequests).toHaveLength(0);
      await expect(fetch(h.opened[0].searchParams.get('redirect_uri')!)).rejects.toThrow();
    } finally { h.manager.dispose(); }
    const timed = await harness(undefined, { autoCallback: false, loginTimeoutMs: 40 });
    try { await expect(timed.manager.login()).rejects.toThrow('超时'); expect(timed.tokenRequests).toHaveLength(0); }
    finally { timed.manager.dispose(); }
  });
  it('fails closed for malicious discovery and browser-opening failures without exposing diagnostics', async () => {
    const h = await harness(); h.state.discoveryHostile = true;
    try { await expect(h.manager.login()).rejects.toThrow('连接失败'); expect(h.opened).toHaveLength(0); expect(h.network).toHaveLength(1); }
    finally { h.manager.dispose(); }
    const other = await harness(); other.state.openFail = true;
    try { await expect(other.manager.login()).rejects.toThrow('连接失败'); expect(other.tokenRequests).toHaveLength(0); }
    finally { other.manager.dispose(); }
  });
});
