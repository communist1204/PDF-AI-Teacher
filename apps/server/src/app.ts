import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { AskRequestSchema, EnvelopeSchema, TtsRequestSchema, validatePlan, type AppConfig, type AskResponse, type Envelope, type UsageRecord } from '../../../packages/shared/protocol';
import { AudioCache } from './cache';
import { DEFAULT_TTS_STYLE, readConfig, TTS_SOURCE_FIDELITY, type ServerConfig } from './config';
import { makeDemoPlan } from './demo';
import { HttpError, providerError, safeRequestId } from './errors';
import { OpenAITeachingProvider, speechRequest, type TeachingProvider } from './provider';

type Job = { envelope: Envelope; controller: AbortController };
type Session = {
  id: string; csrf: string; touchedAt: number; generation: number; revision: number; cancelledThrough: number;
  requests: number; recentRequests: number[]; usage: UsageRecord[]; jobs: Set<Job>;
};
const SESSION_COOKIE = 'pdf_teacher_session';
const SESSION_TTL = 6 * 60 * 60 * 1000;

function equalToken(a: string, b: string) {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function cookieSession(req: Request) {
  return req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}
function setEnvelope(res: Response, envelope: Envelope) {
  res.set({ 'x-session-id': envelope.sessionId, 'x-generation-id': String(envelope.generationId), 'x-context-revision': String(envelope.contextRevision) });
}
function cancelledError() { return new HttpError(409, 'cancelled', '本次任务已取消，旧结果不会继续使用；已发生的服务用量可能仍会计费。'); }

export function createApp(options: { config?: ServerConfig; provider?: TeachingProvider; now?: () => number } = {}) {
  const config = options.config ?? readConfig();
  const now = options.now ?? Date.now;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const sessions = new Map<string, Session>();
  const cache = new AudioCache(config.cacheMaxBytes);
  const provider = options.provider ?? (!config.demoMode && config.apiKey ? new OpenAITeachingProvider(config) : undefined);
  const capabilities: AppConfig['capabilities'] = {
    text: !config.demoMode && config.apiKey && config.chatModel ? 'untested' : 'unconfigured',
    vision: !config.demoMode && config.apiKey && config.visionModel ? 'untested' : 'unconfigured',
    structuredOutput: !config.demoMode && config.apiKey && (config.chatModel || config.visionModel) ? 'untested' : 'unconfigured',
    tts: !config.demoMode && config.apiKey && config.ttsModel ? 'untested' : 'unconfigured',
    transcription: 'unsupported', realtimeAudio: 'unsupported', realtimeTools: 'unsupported', interruption: 'unsupported',
  };
  const mode: AppConfig['mode'] = config.demoMode ? 'demo' : config.apiKey && (config.chatModel || config.visionModel || config.ttsModel) ? 'live' : 'unconfigured';
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    if (!allowedHosts.has(req.headers.host ?? '')) return next(new HttpError(403, 'invalid_host', '只允许从本机应用地址访问。'));
    const origin = req.headers.origin;
    if ((origin && origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') return next(new HttpError(403, 'invalid_origin', '拒绝非本应用来源的请求。'));
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '3500kb', strict: true }));

  function expireSessions() {
    for (const [id, session] of sessions) if (session.touchedAt + SESSION_TTL < now()) {
      for (const job of session.jobs) job.controller.abort(cancelledError());
      cache.clear(id); sessions.delete(id);
    }
  }
  function sessionFor(req: Request): Session {
    expireSessions();
    const session = sessions.get(cookieSession(req) ?? '');
    if (!session) throw new HttpError(401, 'session_required', '本地会话已过期，请刷新页面。');
    session.touchedAt = now();
    return session;
  }
  function requireMutation(req: Request): Session {
    if (req.headers.origin !== `http://${req.headers.host}`) throw new HttpError(403, 'origin_required', '请求缺少本应用来源。');
    const session = sessionFor(req);
    if (!equalToken(req.header('x-csrf-token') ?? '', session.csrf)) throw new HttpError(403, 'invalid_csrf', '本地会话校验失败，请刷新页面。');
    if (req.body?.sessionId !== session.id) throw new HttpError(403, 'session_mismatch', '请求不属于当前会话。');
    return session;
  }
  function checkFresh(session: Session, envelope: Envelope) {
    // Cancellation may arrive before its request. Persist the boundary to prevent
    // a delayed request from starting a paid provider operation afterwards.
    if (envelope.generationId <= session.cancelledThrough) throw new HttpError(409, 'stale_request', '本代任务已取消，迟到请求已丢弃。');
    if (envelope.generationId < session.generation || envelope.contextRevision < session.revision) throw new HttpError(409, 'stale_request', '过期请求已丢弃。');
    if (envelope.generationId > session.generation || envelope.contextRevision > session.revision) {
      for (const job of session.jobs) job.controller.abort(cancelledError());
      session.generation = envelope.generationId;
      session.revision = envelope.contextRevision;
    }
  }
  function consumeRequest(session: Session) {
    session.recentRequests = session.recentRequests.filter(time => time > now() - 60000);
    if (session.requests >= config.maxRequests) throw new HttpError(429, 'session_limit', '已达到本应用会话请求上限。此上限不是服务商硬额度。');
    if (session.recentRequests.length >= config.requestsPerMinute) throw new HttpError(429, 'local_rate_limit', '操作过于频繁，请稍后重试。');
    session.recentRequests.push(now()); session.requests += 1;
  }
  function newUsage(session: Session, model: string, category: UsageRecord['category'], characters: number | null = null) {
    const record: UsageRecord = { requestId: randomUUID(), model, category, inputTokens: null, outputTokens: null, characters, estimatedCost: null, cancelled: false };
    session.usage.push(record);
    return record;
  }
  async function runJob<T>(session: Session, envelope: Envelope, req: Request, res: Response, usage: UsageRecord, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if ([...session.jobs].some(job => !job.controller.signal.aborted)) throw new HttpError(409, 'request_in_progress', '已有任务正在生成，请等待完成或先停止。');
    const controller = new AbortController();
    const job: Job = { envelope, controller };
    session.jobs.add(job);
    const stopForDisconnect = () => { if (!res.writableEnded) controller.abort(cancelledError()); };
    req.once('aborted', stopForDisconnect);
    res.once('close', stopForDisconnect);
    const timer = setTimeout(() => controller.abort(new HttpError(504, 'provider_timeout', '模型服务超时；已取消本地等待，可能已有用量。请手动重试。')), config.requestTimeoutMs);
    timer.unref();
    try {
      const result = await new Promise<T>((resolve, reject) => {
        const aborted = () => reject(controller.signal.reason ?? cancelledError());
        controller.signal.addEventListener('abort', aborted, { once: true });
        // Promise resolution is still observed if a provider ignores cancellation.
        Promise.resolve().then(() => action(controller.signal)).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted));
      });
      if (controller.signal.aborted || envelope.generationId !== session.generation || envelope.contextRevision !== session.revision) throw cancelledError();
      return result;
    } catch (error) {
      usage.cancelled = controller.signal.aborted;
      const mapped = providerError(error);
      usage.requestId = mapped.requestId ?? usage.requestId;
      throw mapped;
    } finally {
      clearTimeout(timer); session.jobs.delete(job);
      req.off('aborted', stopForDisconnect); res.off('close', stopForDisconnect);
    }
  }

  app.get('/api/config', (req, res) => {
    expireSessions();
    let session = sessions.get(cookieSession(req) ?? '');
    if (!session) {
      if (sessions.size >= 128) throw new HttpError(429, 'session_capacity', '本地会话数达到上限，请关闭闲置页面后重启本项目。');
      session = { id: randomUUID(), csrf: randomBytes(32).toString('hex'), touchedAt: now(), generation: 0, revision: 0, cancelledThrough: -1, requests: 0, recentRequests: [], usage: [], jobs: new Set() };
      sessions.set(session.id, session);
    }
    session.touchedAt = now();
    res.cookie(SESSION_COOKIE, session.id, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: SESSION_TTL });
    const body: AppConfig = { mode, sessionId: session.id, generationId: Math.max(session.generation, session.cancelledThrough), contextRevision: session.revision, csrfToken: session.csrf, capabilities: { ...capabilities }, models: { chat: config.chatModel, vision: config.visionModel, tts: config.ttsModel }, speech: {
      voice: config.ttsVoice,
      style: !config.ttsInstructionsSupported ? '使用模型默认语气' : config.ttsInstructions === [DEFAULT_TTS_STYLE, TTS_SOURCE_FIDELITY].join('\n') ? '自然温和，按语义停顿' : '本机自定义语气',
      instructionsSupported: config.ttsInstructionsSupported,
    }, maxRequests: config.maxRequests };
    res.json(body);
  });

  app.post('/api/ask', async (req, res) => {
    const session = requireMutation(req);
    const parsed = AskRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_request', '提问内容、选区或上下文格式不正确，或超出长度限制。');
    const request = parsed.data;
    if (request.context.sources.some(source => source.documentId !== request.context.documentId) || new Set(request.context.sources.map(source => source.sourceId)).size !== request.context.sources.length) throw new HttpError(400, 'context_mismatch', '本次上下文必须来自同一本书，且来源不能重复。');
    if (request.context.sources.reduce((sum, source) => sum + source.sourceText.length, 0) > 24000) throw new HttpError(400, 'context_too_large', '选区上下文超过 24000 字，请缩小选区；没有静默裁剪。');
    if (request.context.imageDataUrl) {
      const start = Buffer.from(request.context.imageDataUrl.slice('data:image/png;base64,'.length, 'data:image/png;base64,'.length + 16), 'base64');
      if (start.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new HttpError(400, 'invalid_image', '截图不是有效的 PNG 图片。');
    }
    checkFresh(session, request);
    setEnvelope(res, request);
    if (config.demoMode) {
      consumeRequest(session);
      const usage = newUsage(session, 'DEMO_FIXTURE', 'text');
      const answer: AskResponse = { sessionId: request.sessionId, generationId: request.generationId, contextRevision: request.contextRevision, mode: 'demo', plan: validatePlan(makeDemoPlan(request), request.context, request.contextRevision), usage };
      res.json(answer); return;
    }
    const model = request.context.imageDataUrl ? config.visionModel : config.chatModel;
    if (!config.apiKey || !model || !provider) throw new HttpError(503, 'not_configured', request.context.imageDataUrl ? '视觉模型或 API Key 未配置。截图保留在本机，未假装识别。' : '文字模型或 API Key 未配置。请在本机 .env 中配置后重启。');
    consumeRequest(session);
    const usage = newUsage(session, model, 'text');
    const result = await runJob(session, request, req, res, usage, signal => provider.ask(request, model, signal));
    usage.requestId = safeRequestId(result.requestId) ?? usage.requestId;
    usage.inputTokens = Number.isFinite(result.inputTokens) ? result.inputTokens! : null;
    usage.outputTokens = Number.isFinite(result.outputTokens) ? result.outputTokens! : null;
    let plan;
    try { plan = validatePlan(result.plan, request.context, request.contextRevision); }
    catch {
      capabilities.structuredOutput = 'error';
      // Safe text degradation: never execute or render a partially valid board.
      plan = { schemaVersion: '1' as const, contextRevision: request.contextRevision, answer: '模型返回的教案未通过结构或来源校验，已安全降级为这条提示，未执行任何板书。请缩短问题后手动重试。', needsClarification: false, clarificationQuestion: null, steps: [], checkQuestion: null };
      res.json({ sessionId: request.sessionId, generationId: request.generationId, contextRevision: request.contextRevision, mode: 'live', plan, usage, warning: 'invalid_model_output' });
      return;
    }
    capabilities[request.context.imageDataUrl ? 'vision' : 'text'] = 'supported';
    capabilities.structuredOutput = 'supported';
    const answer: AskResponse = { sessionId: request.sessionId, generationId: request.generationId, contextRevision: request.contextRevision, mode: 'live', plan, usage };
    res.json(answer);
  });

  app.post('/api/tts', async (req, res) => {
    const session = requireMutation(req);
    const parsed = TtsRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_request', '朗读文本不能为空或超过 1600 字，语速范围为 0.5 到 2。');
    const request = parsed.data;
    checkFresh(session, request);
    setEnvelope(res, request);
    if (config.demoMode) throw new HttpError(409, 'demo_tts', '演示模式未调用付费 TTS。请使用明确标注的浏览器演示语音，或在本机配置真实 TTS。');
    if (!config.apiKey || !config.ttsModel || !provider) throw new HttpError(503, 'not_configured', 'TTS 模型或 API Key 未配置；未自动切换语音服务。');
    const cacheKey = cache.key(session.id, [config.baseUrl, speechRequest(config, request.text, request.speed)]);
    const cached = cache.get(cacheKey);
    if (cached) { res.set('x-audio-cache', 'hit').type('audio/mpeg').send(cached); return; }
    consumeRequest(session);
    const usage = newUsage(session, config.ttsModel, 'tts', request.text.length);
    const result = await runJob(session, request, req, res, usage, signal => provider.speak(request.text, request.speed, signal));
    if (!result.audio.length || result.audio.length > 8 * 1024 * 1024) throw new HttpError(502, 'invalid_audio', '语音返回为空或超出大小限制，未播放。');
    usage.requestId = safeRequestId(result.requestId) ?? usage.requestId;
    cache.set(session.id, cacheKey, result.audio);
    capabilities.tts = 'supported';
    res.set({ 'x-audio-cache': 'miss', 'x-request-id': usage.requestId }).type('audio/mpeg').send(result.audio);
  });

  app.post('/api/cancel', (req, res) => {
    const session = requireMutation(req);
    const parsed = EnvelopeSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_request', '取消请求格式不正确。');
    const envelope = parsed.data;
    session.cancelledThrough = Math.max(session.cancelledThrough, envelope.generationId);
    let cancelled = 0;
    for (const job of session.jobs) if (job.envelope.generationId <= envelope.generationId && !job.controller.signal.aborted) { job.controller.abort(cancelledError()); cancelled += 1; }
    setEnvelope(res, envelope);
    res.json({ ...envelope, cancelled, upstreamCancellation: 'requested', note: '本地已发出取消；不能保证服务商撤销已发生的费用。' });
  });
  app.post('/api/cache/clear', (req, res) => {
    const session = requireMutation(req);
    cache.clear(session.id);
    res.json({ cleared: true, cache: cache.stats(session.id) });
  });
  app.get('/api/usage', (req, res) => {
    const session = sessionFor(req);
    res.json({ records: session.usage, requestCount: session.requests, maxRequests: config.maxRequests, cache: cache.stats(session.id), estimatedCost: null });
  });
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'unknown_endpoint', '此接口未实现；M2/M3 语音能力仍待后续开发。')));

  const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    const details = typeof error === 'object' && error ? error as Record<string, unknown> : {};
    const safe = error instanceof HttpError ? error : details.type === 'entity.too.large' ? new HttpError(413, 'payload_too_large', '请求过大，请缩小选区或截图。') : details.type === 'entity.parse.failed' ? new HttpError(400, 'invalid_json', '请求格式不是有效 JSON。') : new HttpError(500, 'internal_error', '本地服务处理失败，请重试；未输出敏感诊断内容。');
    if (res.headersSent || res.destroyed) return;
    const envelope = EnvelopeSchema.safeParse(req.body);
    if (envelope.success) setEnvelope(res, envelope.data);
    res.status(safe.status).json({ ...(envelope.success ? envelope.data : {}), error: safe.code, message: safe.message, requestId: safe.requestId ?? randomUUID() });
  };
  app.use(errorHandler);
  return app;
}
