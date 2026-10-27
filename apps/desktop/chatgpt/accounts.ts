import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLocalJWKSet, jwtVerify, errors as joseErrors, type JSONWebKeySet } from 'jose';
import { z } from 'zod';
import type { Cipher } from '../settings';
import type { ChatGPTModel, ChatGPTState } from '../../../packages/shared/chatgpt';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const AUTHORIZE = ISSUER + '/api/accounts/authorize';
const TOKEN = ISSUER + '/api/accounts/oauth/token';
const DISCOVERY = ISSUER + '/.well-known/openid-configuration';
const JWKS = ISSUER + '/.well-known/jwks.json';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const LOGIN_TIMEOUT = 5 * 60_000;
const REQUEST_TIMEOUT = 20_000;
const MAX_BODY = 2 * 1024 * 1024;
const ProfileSchema = z.object({
  id: z.string().uuid(), clientId: z.string().min(1).max(300), subject: z.string().max(500),
  label: z.string().max(250), email: z.string().max(250), idToken: z.string().max(100000),
  accessToken: z.string().max(100000), refreshToken: z.string().max(100000),
  scopes: z.array(z.string().max(200)).max(100), expiresAt: z.number().finite(),
}).strict();
const VaultSchema = z.object({
  version: z.literal(1), hostId: z.string().regex(/^urn:uuid:[a-f0-9-]{36}$/),
  profiles: z.array(ProfileSchema).max(32), activeProfileId: z.string().uuid().nullable(),
}).strict();
type Profile = z.infer<typeof ProfileSchema>;
type Vault = z.infer<typeof VaultSchema>;
type Options = { path: string; cipher: Cipher; fetchImpl: typeof fetch; openExternal: (url: string) => Promise<void> };
type Attempt = {
  epoch: number; profileId: string; clientId?: string; subject?: string; state: string; nonce: string;
  verifier: string; redirectUri: string; controller: AbortController; server: Server; timer: ReturnType<typeof setTimeout>;
  consumed: boolean;
};
type Metadata = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint: string; algorithms: string[] };
class AuthFailure extends Error {}
function fail(message: string): AuthFailure { return new AuthFailure(message); }
function safeMessage(error: unknown): string {
  return error instanceof AuthFailure ? error.message === 'AUTH_RELOGIN' ? 'ChatGPT 登录信息已过期，请重新登录。' : error.message : 'ChatGPT 连接未完成，请检查网络或重新登录。';
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('ChatGPT 返回的数据格式不正确。');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 100000): string { return typeof value === 'string' && value.length <= max ? value : ''; }
function connected(profile?: Profile): boolean { return Boolean(profile?.subject && profile.idToken); }
function sharing(profile?: Profile): boolean { return connected(profile) && Boolean(profile?.scopes.includes(DIRECT_SCOPE) && (profile.accessToken || profile.refreshToken)); }
function publicLabel(value: unknown, fallback: string): string {
  // Identity values are displayed as text only and are never used as credentials.
  return text(value, 250).replace(/[\p{Cc}\p{Cf}]/gu, '').trim() || fallback;
}
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function interrupted(signal: AbortSignal): void { if (signal.aborted) throw fail('操作已取消。'); }
function withoutCredentials(profile: Profile): Profile {
  return { ...profile, accessToken: '', refreshToken: '', idToken: '', scopes: [], expiresAt: 0 };
}

/** Own OAuth registration only; never reads credentials belonging to ChatGPT, Codex or a browser. */
export class ChatGPTAccountService {
  private vault: Vault = { version: 1, hostId: 'urn:uuid:' + randomUUID(), profiles: [], activeProfileId: null };
  private damaged = false;
  private disposed = false;
  private epoch = 0;
  private attempt?: Attempt;
  private queue: Promise<void> = Promise.resolve();
  private background = new Set<Promise<unknown>>();
  private requests = new Set<AbortController>();
  private refreshes = new Map<string, Promise<Profile>>();
  private models: ChatGPTModel[] = [];
  private modelOwner: string | null = null;
  private message = '登录 ChatGPT 后，授权使用订阅额度来整理截图。';
  private metadata?: Metadata;
  private jwks?: ReturnType<typeof createLocalJWKSet>;
  private jwksAt = 0;
  constructor(private readonly options: Options) {}

  async load(): Promise<void> {
    let bytes: Buffer;
    try { bytes = await readFile(this.options.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.damaged = true; throw fail('无法读取 ChatGPT 连接文件，原文件未被覆盖。');
    }
    try {
      if (!this.options.cipher.available()) throw fail('unavailable');
      this.vault = VaultSchema.parse(JSON.parse(this.options.cipher.decrypt(bytes)));
      if (this.vault.activeProfileId && !this.vault.profiles.some(p => p.id === this.vault.activeProfileId)) throw fail('invalid');
      if (new Set(this.vault.profiles.map(p => p.id)).size !== this.vault.profiles.length) throw fail('invalid');
      this.message = connected(this.active()) ? '已保存 ChatGPT 连接；识图时使用已授权的订阅额度。' : '请登录 ChatGPT。';
    } catch { this.damaged = true; this.message = 'ChatGPT 连接文件无法解密或已损坏，原文件未被覆盖；仍可手动使用本机识字。'; throw fail(this.message); }
  }
  private active(): Profile | undefined { return this.vault.profiles.find(p => p.id === this.vault.activeProfileId); }
  getState(): ChatGPTState {
    const active = this.active();
    return {
      status: this.attempt ? 'authorizing' : connected(active) ? 'connected' : 'disconnected',
      profiles: this.vault.profiles.map((p, i) => ({ id: p.id, label: p.label ? p.label + ' · 连接 ' + (i + 1) : '待完成的连接 ' + (i + 1), connected: connected(p), sharing: sharing(p) })),
      activeProfileId: this.vault.activeProfileId, sharing: sharing(active),
      models: sharing(active) && this.modelOwner === active?.id ? structuredClone(this.models) : [], message: this.message,
    };
  }
  private update(change: (current: Vault) => Vault, guard: () => boolean = () => !this.disposed): Promise<void> {
    const operation = this.queue.then(async () => {
      if (this.damaged) throw fail('连接文件损坏，已阻止覆盖。');
      if (!this.options.cipher.available()) throw fail('Windows 凭证加密不可用，无法保存登录信息。');
      if (!guard()) throw fail('操作已取消。');
      const before = structuredClone(this.vault);
      const next = VaultSchema.parse(change(structuredClone(before)));
      const bytes = this.options.cipher.encrypt(JSON.stringify(next));
      await mkdir(dirname(this.options.path), { recursive: true });
      const temporary = this.options.path + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, bytes, { mode: 0o600 });
        if (!guard()) throw fail('操作已取消。');
        await rename(temporary, this.options.path);
        if (!guard()) {
          // Cancellation can race the atomic rename; restore the prior encrypted state before releasing the queue.
          await writeFile(temporary, this.options.cipher.encrypt(JSON.stringify(before)), { mode: 0o600 });
          await rename(temporary, this.options.path);
          throw fail('操作已取消。');
        }
        this.vault = next;
      } finally { await unlink(temporary).catch(() => {}); }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  private track(operation: Promise<unknown>): void {
    this.background.add(operation); void operation.finally(() => this.background.delete(operation)).catch(() => {});
  }
  private async request(url: string, init: RequestInit, parent?: AbortSignal): Promise<unknown> {
    const target = new URL(url);
    if (target.username || target.password || target.hash || target.search ||
      !(target.origin === ISSUER || url === RESOURCE + '/models')) throw fail('已阻止非官方连接地址。');
    const controller = new AbortController(); this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(fail(parent?.aborted ? '操作已取消。' : '连接 ChatGPT 超时，请稍后重试。'));
      signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
    });
    const job = (async () => {
      interrupted(signal);
      const response = await this.options.fetchImpl(url, { ...init, signal, redirect: 'error', credentials: 'omit' });
      if (response.redirected) throw fail('ChatGPT 连接出现不受支持的跳转。');
      const reader = response.body?.getReader(); let body = ''; let size = 0;
      if (reader) {
        const decoder = new TextDecoder();
        try {
          while (true) {
            interrupted(signal);
            const chunk = await Promise.race([reader.read(), aborted]);
            if (chunk.done) break;
            size += chunk.value.byteLength; if (size > MAX_BODY) throw fail('ChatGPT 返回数据过大。');
            body += decoder.decode(chunk.value, { stream: true });
          }
          body += decoder.decode();
        } finally { void reader.cancel().catch(() => {}); }
      }
      interrupted(signal);
      let data: unknown = {};
      if (body) { try { data = JSON.parse(body); } catch { throw fail('ChatGPT 返回的数据格式不正确。'); } }
      if (!response.ok) {
        const raw = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        const error = raw.error && typeof raw.error === 'object' ? raw.error as Record<string, unknown> : raw;
        const code = text(error.code || raw.error, 100);
        if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(code)) throw fail('AUTH_RELOGIN');
        if (response.status === 401) throw fail('ChatGPT 登录或授权无效，请重新登录。');
        if (response.status === 403) throw fail('当前 ChatGPT 账号、地区或权限不支持此连接。');
        if (response.status === 429) throw fail('ChatGPT 请求达到限制，请查看用量并稍后重试。');
        throw fail('ChatGPT 服务暂时不可用，请稍后重试。');
      }
      return data;
    })();
    try { return await Promise.race([job, aborted]); }
    finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); this.requests.delete(controller); }
  }
  private async discovery(signal?: AbortSignal): Promise<Metadata> {
    if (this.metadata) return this.metadata;
    const data = record(await this.request(DISCOVERY, {}, signal));
    if (data.issuer !== ISSUER || data.authorization_endpoint !== AUTHORIZE || data.token_endpoint !== TOKEN || data.jwks_uri !== JWKS) throw fail('ChatGPT 身份服务配置不匹配。');
    const revoke = new URL(text(data.revocation_endpoint));
    if (revoke.origin !== ISSUER || !revoke.pathname.startsWith('/api/accounts/') || revoke.username || revoke.password || revoke.search || revoke.hash) throw fail('ChatGPT 退出地址不受支持。');
    const allowed = Array.isArray(data.id_token_signing_alg_values_supported) ? data.id_token_signing_alg_values_supported : [];
    const algorithms = allowed.filter((value): value is string => typeof value === 'string' && ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384'].includes(value));
    if (!algorithms.length) throw fail('ChatGPT 身份签名算法不受支持。');
    this.metadata = { issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN, jwks_uri: JWKS, revocation_endpoint: revoke.href, algorithms };
    return this.metadata;
  }
  private async verifyIdentity(idToken: string, clientId: string, nonce: string | undefined, signal?: AbortSignal) {
    const metadata = await this.discovery(signal);
    const loadKeys = async () => {
      const raw = record(await this.request(JWKS, {}, signal));
      if (!Array.isArray(raw.keys) || raw.keys.length > 50) throw fail('ChatGPT 身份公钥无效。');
      this.jwks = createLocalJWKSet(raw as unknown as JSONWebKeySet); this.jwksAt = Date.now();
    };
    if (!this.jwks || Date.now() - this.jwksAt > 60 * 60_000) await loadKeys();
    const verify = () => jwtVerify(idToken, this.jwks!, {
      issuer: metadata.issuer, audience: clientId, algorithms: metadata.algorithms,
      requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5,
    });
    let payload;
    try { ({ payload } = await verify()); }
    catch (error) {
      if (error instanceof joseErrors.JWKSNoMatchingKey) { await loadKeys(); ({ payload } = await verify()); }
      else throw fail('ChatGPT 身份验证失败，请重新登录。');
    }
    if (!payload.sub || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) || (nonce !== undefined && payload.nonce !== nonce)) throw fail('ChatGPT 身份验证失败，请重新登录。');
    return payload;
  }

  async beginLogin(profileId?: string): Promise<ChatGPTState> {
    if (this.disposed) throw fail('应用正在关闭。');
    if (this.damaged || !this.options.cipher.available()) throw fail('本机凭证加密不可用，未开始登录。');
    const saved = profileId ? this.vault.profiles.find(p => p.id === profileId) : undefined;
    if (profileId && !saved) throw fail('所选 ChatGPT 连接不存在。');
    if (!saved && this.vault.profiles.length >= 32) throw fail('已达到本机连接数量上限。');
    await this.cancelLogin(); const epoch = ++this.epoch;
    // Persist the installation identity before opening any browser.
    await this.update(current => current, () => !this.disposed && this.epoch === epoch);
    const server = createServer();
    const controller = new AbortController();
    const attempt: Attempt = {
      epoch, profileId: saved?.id ?? randomUUID(), clientId: saved?.clientId, subject: saved?.subject || undefined,
      state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(64).toString('base64url'), redirectUri: '', server, controller,
      timer: setTimeout(() => { if (this.attempt === attempt) { this.closeAttempt(); this.message = '登录等待超时，请重新点击登录。'; } }, LOGIN_TIMEOUT), consumed: false,
    };
    this.attempt = attempt; this.message = '请在系统浏览器完成 ChatGPT 登录并授权使用订阅额度。';
    server.on('request', (req, res) => {
      const task = this.handleCallback(attempt, req, res).catch(error => {
        if (!res.writableEnded) this.respond(res, 400, '登录未完成，请回到轻读查看。');
        if (this.attempt === attempt) { this.message = safeMessage(error); this.closeAttempt(); }
      });
      this.track(task);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      if (this.attempt !== attempt) { server.close(); return this.getState(); }
      const address = server.address(); if (!address || typeof address === 'string') throw fail('无法开启本机登录回调。');
      attempt.redirectUri = 'http://127.0.0.1:' + address.port + '/auth/callback';
      const params = new URLSearchParams({
        client_id: saved?.clientId || 'dynamic_agent_client', ext_agent_host_id: this.vault.hostId,
        response_type: 'code', redirect_uri: attempt.redirectUri, scope: SCOPE, resource: RESOURCE,
        state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
      });
      if (!saved) params.set('agent_name_hint', 'QingRead');
      else {
        if (saved.idToken) params.set('id_token_hint', saved.idToken);
        if (saved.email) params.set('login_hint', saved.email);
        if (!sharing(saved)) params.set('prompt', 'consent');
      }
      await this.options.openExternal(AUTHORIZE + '?' + params.toString());
    } catch (error) {
      if (this.attempt === attempt) { this.closeAttempt(); this.message = safeMessage(error); }
    }
    return this.getState();
  }
  private respond(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
    res.end(message);
  }
  private async handleCallback(attempt: Attempt, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.attempt !== attempt || attempt.consumed) { this.respond(res, 410, '登录请求已结束。'); return; }
    if (req.method !== 'GET' || req.url?.length && req.url.length > 16000 || req.headers.host !== new URL(attempt.redirectUri).host) { this.respond(res, 400, '无效的登录回调。'); return; }
    const url = new URL(req.url || '/', attempt.redirectUri);
    if (url.pathname !== '/auth/callback') { this.respond(res, 404, 'Not found'); return; }
    const params = url.searchParams;
    if (['state', 'code', 'client_id', 'error'].some(key => params.getAll(key).length > 1) || !sameSecret(params.get('state') || '', attempt.state)) { this.respond(res, 400, '登录状态不匹配，请使用刚刚打开的登录页面。'); return; }
    attempt.consumed = true;
    if (params.has('error')) { this.message = '未完成 ChatGPT 授权，可以重新登录。'; this.respond(res, 200, this.message); this.closeAttempt(); return; }
    const returnedClient = params.get('client_id') || '';
    if ((attempt.clientId && returnedClient && returnedClient !== attempt.clientId) || (!attempt.clientId && (!returnedClient || returnedClient === 'dynamic_agent_client'))) throw fail('ChatGPT 注册信息不匹配，请重新登录。');
    const clientId = attempt.clientId || returnedClient;
    const code = params.get('code') || '';
    if (!code || code.length > 8000 || clientId.length > 300) throw fail('ChatGPT 登录回调不完整，请重新登录。');
    const valid = () => this.attempt === attempt && !attempt.controller.signal.aborted && !this.disposed;
    await this.update(current => {
      if (!current.profiles.some(p => p.id === attempt.profileId)) current.profiles.push({
        id: attempt.profileId, clientId, subject: '', label: '', email: '', idToken: '', accessToken: '', refreshToken: '', scopes: [], expiresAt: 0,
      });
      return current;
    }, valid);
    this.respond(res, 200, '已收到登录结果，请回到轻读。正在验证授权。');
    attempt.server.close();
    const data = record(await this.request(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }).toString(),
    }, attempt.controller.signal));
    const idToken = text(data.id_token); if (!idToken) throw fail('ChatGPT 未返回可验证身份，请重新登录。');
    const identity = await this.verifyIdentity(idToken, clientId, attempt.nonce, attempt.controller.signal);
    if (attempt.subject && identity.sub !== attempt.subject) throw fail('登录账号与所选连接不一致，原连接未被替换。');
    const scopes = text(data.scope, 20000).split(/\s+/).filter(Boolean);
    const accessToken = text(data.access_token), refreshToken = text(data.refresh_token);
    if (scopes.includes(DIRECT_SCOPE) && (!accessToken || data.token_type !== 'Bearer')) throw fail('ChatGPT 未返回有效的订阅授权。');
    const expires = typeof data.expires_in === 'number' && data.expires_in > 0 && data.expires_in <= 86400 ? data.expires_in : 3600;
    await this.update(current => {
      const index = current.profiles.findIndex(p => p.id === attempt.profileId);
      current.profiles[index] = { id: attempt.profileId, clientId, subject: identity.sub!,
        email: publicLabel(identity.email, ''), label: publicLabel(identity.email, publicLabel(identity.name, 'ChatGPT 连接')),
        idToken, accessToken, refreshToken, scopes, expiresAt: Date.now() + expires * 1000 };
      current.activeProfileId = attempt.profileId; return current;
    }, valid);
    this.models = []; this.modelOwner = null;
    const authorized = scopes.includes(DIRECT_SCOPE);
    this.message = authorized ? '已登录并授权使用 ChatGPT 订阅额度；正在读取可用模型。' : '已登录，但尚未授权使用订阅额度。请再次登录并允许使用你的计划。';
    if (authorized) await this.refreshModels();
    if (this.attempt === attempt) this.closeAttempt();
  }
  private closeAttempt(): void {
    const previous = this.attempt; this.attempt = undefined;
    if (previous) { clearTimeout(previous.timer); previous.controller.abort(); previous.server.close(); previous.server.closeAllConnections(); }
  }
  async cancelLogin(): Promise<ChatGPTState> {
    if (this.attempt) { ++this.epoch; this.closeAttempt(); this.message = '已取消登录。'; }
    return this.getState();
  }
  async selectProfile(id: string): Promise<ChatGPTState> {
    if (!this.vault.profiles.some(p => p.id === id)) throw fail('所选 ChatGPT 连接不存在。');
    await this.cancelLogin(); const epoch = ++this.epoch;
    await this.update(current => ({ ...current, activeProfileId: id }), () => !this.disposed && this.epoch === epoch);
    this.models = []; this.modelOwner = null; this.message = '已切换 ChatGPT 连接。';
    return this.refreshModels();
  }
  private async usableProfile(id: string): Promise<Profile> {
    const current = this.vault.profiles.find(p => p.id === id);
    if (!current || !sharing(current)) throw fail('请先登录 ChatGPT 并授权使用订阅额度。');
    if (current.accessToken && current.expiresAt > Date.now() + 60_000) return structuredClone(current);
    const inProgress = this.refreshes.get(id); if (inProgress) return inProgress;
    const refresh = this.refreshProfile(current); this.refreshes.set(id, refresh);
    try { return await refresh; } finally { if (this.refreshes.get(id) === refresh) this.refreshes.delete(id); }
  }
  private async refreshProfile(previous: Profile): Promise<Profile> {
    if (!previous.refreshToken) throw fail('ChatGPT 登录已过期，请重新登录。');
    const valid = () => !this.disposed && this.vault.profiles.some(p => p.id === previous.id && p.refreshToken === previous.refreshToken);
    try {
      const data = record(await this.request(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: previous.clientId, refresh_token: previous.refreshToken, resource: RESOURCE }).toString() }));
      const accessToken = text(data.access_token), refreshToken = text(data.refresh_token);
      if (!accessToken || !refreshToken || data.token_type !== 'Bearer') throw fail('ChatGPT 无法续期登录，请重新登录。');
      let idToken = previous.idToken;
      if (data.id_token) {
        idToken = text(data.id_token); const identity = await this.verifyIdentity(idToken, previous.clientId, undefined);
        if (identity.sub !== previous.subject) throw fail('ChatGPT 续期账号不一致，未替换原连接。');
      }
      const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : previous.scopes;
      const expires = typeof data.expires_in === 'number' && data.expires_in > 0 && data.expires_in <= 86400 ? data.expires_in : 3600;
      const next = { ...previous, idToken, accessToken, refreshToken, scopes, expiresAt: Date.now() + expires * 1000 };
      await this.update(current => ({ ...current, profiles: current.profiles.map(p => p.id === previous.id ? next : p) }), valid);
      if (!sharing(next)) throw fail('ChatGPT 订阅授权已失效，请重新登录并授权。');
      return next;
    } catch (error) {
      if (error instanceof AuthFailure && error.message === 'AUTH_RELOGIN') {
        if (valid()) await this.update(current => ({ ...current, profiles: current.profiles.map(p => p.id === previous.id ? withoutCredentials(p) : p) }), valid);
        throw fail('ChatGPT 登录已失效，请重新登录。');
      }
      throw fail(safeMessage(error));
    }
  }
  async refreshModels(): Promise<ChatGPTState> {
    const id = this.vault.activeProfileId, epoch = this.epoch;
    this.models = []; this.modelOwner = null;
    if (!id || !sharing(this.active())) return this.getState();
    try {
      const profile = await this.usableProfile(id);
      const data = record(await this.request(RESOURCE + '/models', { headers: { Authorization: 'Bearer ' + profile.accessToken } }));
      if (this.disposed || this.epoch !== epoch || this.vault.activeProfileId !== id) return this.getState();
      if (!Array.isArray(data.models) || data.models.length > 1000) throw fail('ChatGPT 模型目录格式不正确。');
      const models: ChatGPTModel[] = []; const seen = new Set<string>();
      for (const entry of data.models) {
        if (!entry || typeof entry !== 'object') continue;
        const value = entry as Record<string, unknown>; const modelId = text(value.slug, 200);
        if (value.visibility !== 'list' || !modelId || /\s/.test(modelId) || seen.has(modelId)) continue;
        if (Array.isArray(value.input_modalities) && !value.input_modalities.includes('image')) continue;
        const rawEfforts = Array.isArray(value.supported_reasoning_levels) ? value.supported_reasoning_levels : Array.isArray(value.supported_reasoning_efforts) ? value.supported_reasoning_efforts : [];
        const efforts = rawEfforts.map(e => typeof e === 'string' ? e : e && typeof e === 'object' ? text((e as Record<string, unknown>).effort ?? (e as Record<string, unknown>).reasoning_effort, 50) : '');
        const reasoningEffort = ['none', 'minimal', 'low'].find(e => efforts.includes(e));
        seen.add(modelId); models.push({ id: modelId, label: publicLabel(value.display_name, modelId), ...(reasoningEffort ? { reasoningEffort } : {}) });
      }
      this.models = models; this.modelOwner = id;
      this.message = models.length ? '已连接 ChatGPT。每次截图会整理阅读顺序，使用已授权的订阅额度。' : '账号没有返回可用于看图的模型，请检查账号权限。';
    } catch (error) { if (this.epoch === epoch && this.vault.activeProfileId === id) this.message = safeMessage(error); }
    return this.getState();
  }
  async getAccess(modelId: string, signal: AbortSignal): Promise<{ accessToken: string; model: ChatGPTModel }> {
    interrupted(signal);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(fail('操作已取消。'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([this.resolveAccess(modelId, signal), aborted]); }
    finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
  }
  private async resolveAccess(modelId: string, signal: AbortSignal): Promise<{ accessToken: string; model: ChatGPTModel }> {
    interrupted(signal); const id = this.vault.activeProfileId, epoch = this.epoch;
    if (!id || !sharing(this.active())) throw fail('请先登录 ChatGPT 并授权使用订阅额度。');
    if (this.modelOwner !== id || !this.models.length) await this.refreshModels();
    interrupted(signal);
    if (this.disposed || this.epoch !== epoch || this.vault.activeProfileId !== id) throw fail('ChatGPT 连接已切换，请重新截图。');
    const model = modelId ? this.models.find(m => m.id === modelId) : this.models[0];
    if (!model) throw fail(this.models.length ? '所选模型当前不可用，请在设置中重新选择。' : this.message);
    const profile = await this.usableProfile(id); interrupted(signal);
    if (this.disposed || this.epoch !== epoch || this.vault.activeProfileId !== id) throw fail('ChatGPT 连接已切换，请重新截图。');
    return { accessToken: profile.accessToken, model: { ...model } };
  }
  async signOut(): Promise<ChatGPTState> {
    await this.cancelLogin(); const epoch = ++this.epoch; const previous = this.active();
    for (const controller of this.requests) controller.abort();
    this.models = []; this.modelOwner = null;
    if (!previous) return this.getState();
    await this.update(current => ({ ...current, profiles: current.profiles.map(p => p.id === previous.id ? withoutCredentials(p) : p) }),
      () => !this.disposed && this.epoch === epoch);
    let revoked = false;
    if (previous.refreshToken) {
      try {
        const metadata = await this.discovery();
        await this.request(metadata.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: previous.refreshToken, token_type_hint: 'refresh_token', client_id: previous.clientId }).toString() });
        revoked = true;
      } catch { /* Local logout succeeds even when the server cannot confirm revocation. */ }
    }
    if (this.epoch === epoch) this.message = revoked || !previous.refreshToken ? '已退出 ChatGPT；后续截图不会使用该连接。' : '已退出本机连接；远程撤销未确认，可到 ChatGPT 设置断开轻读。';
    return this.getState();
  }
  dispose(): void {
    this.disposed = true; ++this.epoch; this.closeAttempt();
    for (const controller of this.requests) controller.abort();
    this.models = []; this.modelOwner = null;
  }
  async flush(): Promise<void> {
    let pending; do { pending = this.queue; await pending; } while (pending !== this.queue);
    await Promise.allSettled([...this.background]);
    await this.queue;
  }
}
