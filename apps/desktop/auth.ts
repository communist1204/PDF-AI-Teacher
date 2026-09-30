import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const REQUIRED_PERMISSION = 'chatgpt.tokens.use.direct';
const CALLBACK_PATH = '/auth/callback';
const SECRET = z.string().min(1).max(100000);
const CredentialsSchema = z.object({ accessToken: SECRET, refreshToken: SECRET.optional(), idToken: SECRET, scopes: z.array(z.string()).max(32), expiresAt: z.number().finite() });
const AccountSchema = z.object({ id: z.string().uuid(), clientId: z.string().min(1).max(512), issuer: z.literal(ISSUER), subject: z.string().min(1).max(1024), email: z.string().max(320).optional(), credentials: CredentialsSchema.optional(), expired: z.boolean().optional() });
export const AuthStoreSchema = z.object({ version: z.literal(1), hostId: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/i), activeAccountId: z.string().uuid().optional(), accounts: z.array(AccountSchema).max(20) });
export type AuthStore = z.infer<typeof AuthStoreSchema>;
type Account = z.infer<typeof AccountSchema>;
type Credentials = z.infer<typeof CredentialsSchema>;
export type AuthSnapshot = {
  status: 'signed_out' | 'signed_in' | 'expired'; email?: string; message?: string;
  activeAccountId?: string;
  accounts: Array<{ id: string; label: string; email?: string; status: 'signed_out' | 'signed_in' | 'expired' }>;
};
type Discovery = { issuer: typeof ISSUER; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint?: string };
type Options = {
  readAuth: () => Promise<AuthStore | null>;
  writeAuth: (store: AuthStore) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  /** Dependency injection is used only by offline tests; production endpoints stay fixed. */
  fetch?: typeof fetch; now?: () => number; loginTimeoutMs?: number;
};
class AuthError extends Error { constructor(message: string, readonly code?: string) { super(message); this.name = 'AuthError'; } }
const safeFailure = () => new AuthError('ChatGPT 登录连接失败。请检查网络后重新登录；没有改用 API Key。');
function equal(a: string, b: string) { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function randomValue() { return randomBytes(32).toString('base64url'); }
function authUrl(value: unknown): string {
  if (typeof value !== 'string') throw safeFailure();
  const url = new URL(value);
  if (url.origin !== ISSUER || url.username || url.password || url.search || url.hash) throw safeFailure();
  return url.href;
}
function status(account?: Account): AuthSnapshot['status'] { return account?.credentials ? 'signed_in' : account?.expired ? 'expired' : 'signed_out'; }
function errorCode(data: unknown) {
  if (!data || typeof data !== 'object') return undefined;
  const error = (data as Record<string, unknown>).error;
  const code = typeof error === 'string' ? error : error && typeof error === 'object' ? (error as Record<string, unknown>).code : undefined;
  return typeof code === 'string' && /^[a-z_]{1,100}$/.test(code) ? code : undefined;
}

/** Own OAuth registration only. Never reads browser, ChatGPT or Codex credential stores. */
export class ChatGptAuthManager {
  private store: AuthStore = { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
  private initialized?: Promise<void>;
  private writes = Promise.resolve();
  private discovery?: Discovery;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private pending?: AbortController;
  private readonly refreshes = new Map<string, Promise<string>>();
  private readonly controllers = new Set<AbortController>();
  private epoch = 0;
  private closed = false;
  private message?: string;
  constructor(private readonly options: Options) { this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now; }

  initialize(): Promise<void> {
    this.initialized ??= (async () => {
      const saved = await this.options.readAuth();
      if (saved) this.store = AuthStoreSchema.parse(saved);
      else await this.persist(); // Host ID exists on disk before the first authorization request.
    })();
    return this.initialized;
  }
  private persist() {
    const saved = structuredClone(this.store);
    const pending = this.writes.catch(() => undefined).then(() => this.options.writeAuth(saved));
    this.writes = pending;
    return pending;
  }
  snapshot(): AuthSnapshot {
    const active = this.store.accounts.find(account => account.id === this.store.activeAccountId);
    return { status: status(active), email: active?.email, message: this.message, activeAccountId: active?.id, accounts: this.store.accounts.map(account => ({ id: account.id, label: `${account.email || 'ChatGPT 账号'} · ${account.id.slice(0, 8)}`, email: account.email, status: status(account) })) };
  }
  private ensureOpen() { if (this.closed) throw new AuthError('应用已关闭，请重新打开后登录。'); }
  private async jsonRequest(url: string, init: RequestInit, signal?: AbortSignal): Promise<{ response: Response; data: unknown }> {
    const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]) });
    const raw = await response.text();
    if (raw.length > 2 * 1024 * 1024) throw safeFailure();
    let data: unknown;
    try { data = raw ? JSON.parse(raw) : null; } catch { throw safeFailure(); }
    return { response, data };
  }
  private async metadata(signal?: AbortSignal) {
    if (this.discovery) return this.discovery;
    const { response, data } = await this.jsonRequest(DISCOVERY_URL, {}, signal);
    const object = z.object({ issuer: z.literal(ISSUER), authorization_endpoint: z.string(), token_endpoint: z.string(), jwks_uri: z.string(), revocation_endpoint: z.string().optional() }).safeParse(data);
    if (!response.ok || !object.success) throw safeFailure();
    const value = object.data;
    this.discovery = { issuer: ISSUER, authorization_endpoint: authUrl(value.authorization_endpoint), token_endpoint: authUrl(value.token_endpoint), jwks_uri: authUrl(value.jwks_uri), ...(value.revocation_endpoint ? { revocation_endpoint: authUrl(value.revocation_endpoint) } : {}) };
    // Refuse a changed token exchange route rather than sending a credential to an unverified endpoint.
    if (this.discovery.authorization_endpoint !== `${ISSUER}/api/accounts/authorize` || this.discovery.token_endpoint !== `${ISSUER}/api/accounts/oauth/token`) { this.discovery = undefined; throw safeFailure(); }
    return this.discovery;
  }
  private async identity(token: string, clientId: string, nonce: string | undefined, signal?: AbortSignal): Promise<JWTPayload> {
    const metadata = await this.metadata(signal);
    const { response, data } = await this.jsonRequest(metadata.jwks_uri, {}, signal);
    if (!response.ok || !data || typeof data !== 'object' || !Array.isArray((data as { keys?: unknown }).keys)) throw safeFailure();
    try {
      const jwks = createLocalJWKSet(data as Parameters<typeof createLocalJWKSet>[0]);
      const { payload } = await jwtVerify(token, jwks, { issuer: metadata.issuer, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5, currentDate: new Date(this.now()), algorithms: ['RS256', 'ES256'] });
      if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce)) throw safeFailure();
      return payload;
    } catch { throw new AuthError('ChatGPT 身份验证失败。签名、账号或登录校验信息不匹配，请重新登录。'); }
  }
  private credentials(data: unknown, previous?: Credentials): Credentials {
    const parsed = z.object({ access_token: SECRET, refresh_token: SECRET.optional(), id_token: SECRET.optional(), token_type: z.string(), expires_in: z.number().int().positive().max(86400), scope: z.string().optional() }).safeParse(data);
    if (!parsed.success || parsed.data.token_type.toLowerCase() !== 'bearer') throw safeFailure();
    const value = parsed.data;
    const idToken = value.id_token ?? previous?.idToken;
    if (!idToken) throw safeFailure();
    return { accessToken: value.access_token, refreshToken: value.refresh_token ?? previous?.refreshToken, idToken, expiresAt: this.now() + value.expires_in * 1000, scopes: value.scope !== undefined ? value.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [] };
  }

  async login(accountId?: string): Promise<AuthSnapshot> {
    await this.initialize(); this.ensureOpen();
    if (this.pending) throw new AuthError('已有登录窗口正在等待，请完成或取消后重试。');
    const selected = accountId ? this.store.accounts.find(account => account.id === accountId) : undefined;
    if (accountId && !selected) throw new AuthError('未找到所选账号，请重新选择。');
    if (!selected && this.store.accounts.length >= 20) throw new AuthError('已保存 20 个账号，请使用已有账号。');
    const controller = new AbortController(); this.pending = controller;
    const timer = setTimeout(() => controller.abort(new AuthError('登录等待已超时，请重新点击 Continue with ChatGPT。')), this.options.loginTimeoutMs ?? 5 * 60 * 1000);
    timer.unref();
    let server: Server | undefined;
    try {
      const metadata = await this.metadata(controller.signal);
      const state = randomValue(); const nonce = randomValue(); const verifier = randomValue();
      let redirectUri = ''; let consumed = false;
      const callback = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
        const onAbort = () => reject(controller.signal.reason ?? new AuthError('登录已取消。'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        server = createServer((req, res) => {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
          const expected = new URL(redirectUri);
          if (req.method !== 'GET' || req.headers.host !== expected.host || (req.url?.length ?? 0) > 16000) { res.writeHead(400).end('无效登录回调。'); return; }
          const url = new URL(req.url ?? '/', redirectUri);
          if (url.pathname !== CALLBACK_PATH) { res.writeHead(404).end('未找到。'); return; }
          if (consumed || controller.signal.aborted) { res.writeHead(410).end('这次登录已结束，请返回应用。'); return; }
          consumed = true; controller.signal.removeEventListener('abort', onAbort);
          const fail = (message: string) => { res.writeHead(400).end(message); reject(new AuthError(message)); };
          if (url.searchParams.getAll('state').length !== 1 || !equal(url.searchParams.get('state') ?? '', state)) { fail('登录校验失败，请返回应用重新登录。'); return; }
          if (url.searchParams.has('error')) { fail(url.searchParams.get('error') === 'access_denied' ? '你取消了授权，尚未连接 ChatGPT。' : 'ChatGPT 未完成授权，请返回应用重试。'); return; }
          const clientId = url.searchParams.get('client_id') ?? selected?.clientId;
          if (!clientId || clientId === DYNAMIC_CLIENT || !/^[a-zA-Z0-9_-]{1,512}$/.test(clientId) || (selected && clientId !== selected.clientId) || url.searchParams.getAll('client_id').length > 1) { fail('登录注册信息不匹配，请返回应用重新登录。'); return; }
          const code = url.searchParams.get('code');
          if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) { fail('登录回调不完整，请返回应用重新登录。'); return; }
          res.writeHead(200).end('已收到 ChatGPT 授权，请返回 PDF AI Teacher 等待身份验证完成。你可以关闭此页面。');
          resolve({ code, clientId });
        });
      });
      // The callback can reject while opening the browser; attach its observer immediately.
      void callback.catch(() => undefined);
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', () => resolve()); });
      controller.signal.throwIfAborted();
      const address = server!.address();
      if (!address || typeof address === 'string') throw safeFailure();
      redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      const url = new URL(metadata.authorization_endpoint);
      url.search = new URLSearchParams({ client_id: selected?.clientId ?? DYNAMIC_CLIENT, ...(selected ? {} : { agent_name_hint: 'PDF AI Teacher' }), ext_agent_host_id: this.store.hostId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...(selected?.credentials?.idToken ? { id_token_hint: selected.credentials.idToken } : {}), ...(selected?.email ? { login_hint: selected.email } : {}), ...(selected?.credentials && !selected.credentials.scopes.includes(REQUIRED_PERMISSION) ? { prompt: 'consent' } : {}) }).toString();
      await this.options.openExternal(url.href);
      const result = await callback;
      controller.signal.throwIfAborted();
      const { response, data } = await this.jsonRequest(metadata.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: result.code, client_id: result.clientId, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }) }, controller.signal);
      if (!response.ok) throw new AuthError('ChatGPT 授权码交换失败，请重新登录。', errorCode(data));
      const credentials = this.credentials(data);
      const identity = await this.identity(credentials.idToken, result.clientId, nonce, controller.signal);
      if (selected && identity.sub !== selected.subject) throw new AuthError('登录的账号与所选账号不一致，已保留原账号配置。');
      controller.signal.throwIfAborted(); this.ensureOpen();
      const existing = this.store.accounts.find(account => account.clientId === result.clientId);
      if (existing && existing.subject !== identity.sub) throw new AuthError('账号注册信息不一致，未替换原账号。');
      const account: Account = { id: existing?.id ?? selected?.id ?? randomUUID(), issuer: ISSUER, clientId: result.clientId, subject: identity.sub!, ...(typeof identity.email === 'string' ? { email: identity.email.slice(0, 320) } : {}), credentials };
      this.store.accounts = [...this.store.accounts.filter(item => item.id !== account.id), account];
      this.store.activeAccountId = account.id; this.epoch++;
      this.message = credentials.scopes.includes(REQUIRED_PERMISSION) ? undefined : '账号已登录，但尚未授权使用 ChatGPT 计划。请重新授权，或自行选择 API Key 方式。';
      await this.persist();
      return this.snapshot();
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error instanceof AuthError ? error : safeFailure();
    } finally {
      clearTimeout(timer); controller.abort();
      server?.close(); server?.closeAllConnections();
      if (this.pending === controller) this.pending = undefined;
    }
  }
  cancelLogin() { this.pending?.abort(new AuthError('登录已取消。')); }
  async selectAccount(accountId: string): Promise<AuthSnapshot> {
    await this.initialize(); this.ensureOpen(); this.cancelLogin();
    const account = this.store.accounts.find(item => item.id === accountId);
    if (!account) throw new AuthError('未找到所选账号。');
    this.epoch++; this.store.activeAccountId = account.id; this.message = undefined;
    await this.persist(); return this.snapshot();
  }
  async getAccessToken(signal?: AbortSignal): Promise<string> {
    await this.initialize(); this.ensureOpen(); signal?.throwIfAborted();
    const account = this.store.accounts.find(item => item.id === this.store.activeAccountId);
    if (!account?.credentials) throw new AuthError('请在桌面设置中登录 ChatGPT。');
    if (!account.credentials.scopes.includes(REQUIRED_PERMISSION)) throw new AuthError('当前账号尚未授权使用 ChatGPT 计划，请在桌面设置中重新授权。');
    if (account.credentials.expiresAt > this.now() + 60000) return account.credentials.accessToken;
    let pending = this.refreshes.get(account.id);
    if (!pending) {
      pending = this.refresh(account).finally(() => this.refreshes.delete(account.id));
      this.refreshes.set(account.id, pending);
    }
    if (!signal) return pending;
    return new Promise<string>((resolve, reject) => {
      const stop = () => reject(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
      pending!.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
  }
  private async refresh(account: Account): Promise<string> {
    const epoch = this.epoch; const previous = account.credentials!;
    if (!previous.refreshToken) throw new AuthError('ChatGPT 登录已到期，请重新登录。');
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const metadata = await this.metadata(controller.signal);
      const { response, data } = await this.jsonRequest(metadata.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: previous.refreshToken, resource: RESOURCE }) }, controller.signal);
      const registered = this.store.accounts.find(item => item.id === account.id);
      if (!registered || registered.credentials !== previous || this.closed) throw new AuthError('账号已退出或重新授权，请重新提问。');
      if (!response.ok) {
        const code = errorCode(data);
        if (code && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(code)) {
          const latest = this.store.accounts.find(item => item.id === account.id);
          if (latest) { latest.credentials = undefined; latest.expired = true; }
          this.message = 'ChatGPT 登录已失效，请重新登录。'; await this.persist();
          throw new AuthError(this.message, code);
        }
        throw new AuthError('ChatGPT 暂时无法续期，已保留登录信息。请稍后重试。', code);
      }
      const credentials = this.credentials(data, previous);
      if (credentials.idToken !== previous.idToken) {
        const identity = await this.identity(credentials.idToken, account.clientId, undefined, controller.signal);
        if (identity.sub !== account.subject) throw new AuthError('续期返回的账号不匹配，未替换登录信息。');
      }
      controller.signal.throwIfAborted(); this.ensureOpen();
      const latest = this.store.accounts.find(item => item.id === account.id);
      if (!latest || latest.credentials !== previous) throw new AuthError('账号已退出或重新授权，请重新提问。');
      // Refresh rotation belongs to this registration, even if another account became active.
      latest.credentials = credentials; latest.expired = false;
      await this.persist();
      controller.signal.throwIfAborted(); this.ensureOpen();
      if (epoch !== this.epoch || this.store.activeAccountId !== account.id) throw new AuthError('账号已切换，请重新提问。');
      if (!credentials.scopes.includes(REQUIRED_PERMISSION)) throw new AuthError('ChatGPT 计划授权已关闭，请重新授权。');
      return credentials.accessToken;
    } catch (error) { throw error instanceof AuthError ? error : safeFailure(); }
    finally { this.controllers.delete(controller); }
  }
  async listModels(): Promise<Array<{ id: string; name: string }>> {
    const token = await this.getAccessToken();
    const { response, data } = await this.jsonRequest(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new AuthError('无法读取当前账号的可用模型，请检查计划权限或稍后重试。');
    const parsed = z.object({ models: z.array(z.object({ slug: z.string().min(1).max(256), display_name: z.string().max(256), visibility: z.string() })).max(1000) }).safeParse(data);
    if (!parsed.success) throw new AuthError('模型目录格式不符合官方登录接口，未猜测可用模型。');
    return parsed.data.models.filter(model => model.visibility === 'list').map(model => ({ id: model.slug, name: model.display_name }));
  }
  async logout(): Promise<AuthSnapshot> {
    await this.initialize(); this.cancelLogin(); this.epoch++;
    for (const controller of this.controllers) controller.abort();
    const account = this.store.accounts.find(item => item.id === this.store.activeAccountId);
    const token = account?.credentials?.refreshToken;
    // Clear locally immediately so no new request can use the old token while revocation waits.
    if (account) { account.credentials = undefined; account.expired = false; }
    await this.persist(); this.message = undefined;
    if (token && account) {
      let confirmed = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const metadata = await this.metadata();
          if (!metadata.revocation_endpoint) break;
          const { response } = await this.jsonRequest(metadata.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: account.clientId }) });
          if (response.status === 200) { confirmed = true; break; }
          if (response.status < 500) break;
        } catch { /* No token or upstream text is exposed to the renderer. */ }
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (!confirmed) this.message = '已退出本机账号；未能确认远端撤销。可在 ChatGPT 设置 → 用量中断开本应用。';
    }
    return this.snapshot();
  }
  dispose() { this.closed = true; this.epoch++; this.cancelLogin(); for (const controller of this.controllers) controller.abort(); }
}
