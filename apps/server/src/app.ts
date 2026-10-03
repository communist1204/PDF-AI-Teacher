import { CosyTtsProvider } from './cosyTts';
import { COSY_TTS_MODEL, DEFAULT_COSY_TTS_VOICE } from '../../../packages/shared/cosySpeech';
import { DoubaoTtsProvider } from './doubaoTts';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { MAX_SPEECH_RATE, MIN_SPEECH_RATE } from '../../../packages/shared/speechRate';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { AskRequestSchema, EnvelopeSchema, TtsRequestSchema, TranscriptionRequestSchema, TranscriptionResponseSchema, validatePlan, type AppConfig, type AskResponse, type Envelope, type UsageRecord } from '../../../packages/shared/protocol';
import { REALTIME_IDLE_SECONDS, REALTIME_MAX_SESSION_SECONDS, RealtimeConnectRequestSchema, RealtimeConnectionRequestSchema, type RealtimeConnectResponse } from '../../../packages/shared/realtime';
import { OpenAIRealtimeProvider, RealtimeConnections, realtimeCapability, type RealtimeProvider } from './realtime';
import { validateRecording } from './recording';
import { ReadingAssistRequestSchema, ReadingAssistResponseSchema, validateReadingAssist } from '../../../packages/shared/readingAssist';
import { AudioCache } from './cache';
import { normalizeSpeechEngine } from '../../../packages/shared/localSpeech';
import { DEFAULT_TTS_STYLE, readConfig, TTS_SOURCE_FIDELITY, type ServerConfig } from './config';
import { makeDemoPlan } from './demo';
import { HttpError, providerError, safeRequestId } from './errors';
import { ChatGptTeachingProvider, OpenAITeachingProvider, speechRequest, type ChatGptCredentials, type TeachingProvider } from './provider';

type RetiredSpeechProvider = { ready(): boolean; speak(text: string, speed: number, signal: AbortSignal): Promise<{ audio: Buffer }>; dispose(): void };
type Job = { envelope: Envelope; controller: AbortController };
// Teaching and source speech have independent cancellation scopes; authentication and budgets remain shared.
type TaskLane = { generation: number; revision: number; cancelledThrough: number; jobs: Set<Job> };
function createTaskLane(): TaskLane { return { generation: 0, revision: 0, cancelledThrough: -1, jobs: new Set() }; }
type Session = TaskLane & {
  id: string; csrf: string; touchedAt: number; speech: TaskLane;
  transcribedGenerations: Set<number>; requests: number; recentRequests: number[]; usage: UsageRecord[];
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

export function createApp(options: { config?: ServerConfig; provider?: TeachingProvider; localTts?: RetiredSpeechProvider; cosyTts?: Pick<CosyTtsProvider, 'ready' | 'status' | 'speak' | 'dispose'>; doubaoTts?: Pick<DoubaoTtsProvider, 'ready' | 'speak' | 'dispose'>; qwenTts?: RetiredSpeechProvider; realtimeProvider?: RealtimeProvider; chatGptAuth?: ChatGptCredentials; fetch?: typeof fetch; now?: () => number } = {}) {
  const config = options.config ?? readConfig();
  const now = options.now ?? Date.now;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const sessions = new Map<string, Session>();
  const cache = new AudioCache(config.cacheMaxBytes);
  const speechEngine = normalizeSpeechEngine(config.ttsEngine);
  const usingCosyTts = speechEngine === 'cosy';
  const cosyProvider = options.cosyTts ?? (usingCosyTts ? new CosyTtsProvider({runtimeDir:config.cosyRuntimeDir,workerPath:config.cosyWorkerPath}) : undefined);
  const usingDoubaoTts = speechEngine === 'doubao';
  const doubaoProvider = options.doubaoTts ?? (usingDoubaoTts ? new DoubaoTtsProvider({apiKey:config.doubaoApiKey??'',voice:config.doubaoTtsVoice??'zh_female_xiaohe_uranus_bigtts',instructions:config.doubaoTtsInstructions??'',fetchImpl:options.fetch}) : undefined);
  const doubaoReady = usingDoubaoTts && !!doubaoProvider?.ready();
  const ttsModel = usingCosyTts ? COSY_TTS_MODEL : usingDoubaoTts ? 'Doubao-Seed-TTS-2.0' : speechEngine === 'openai' ? config.ttsModel : '';
  const usingChatGpt = config.authMode === 'chatgpt';
  const teachingConfigured = !config.demoMode && (usingChatGpt ? Boolean(options.chatGptAuth) : Boolean(config.apiKey));
  const provider = options.provider ?? (!config.demoMode && usingChatGpt && options.chatGptAuth ? new ChatGptTeachingProvider(config, options.chatGptAuth, options.fetch) : !config.demoMode && config.apiKey && !usingChatGpt ? new OpenAITeachingProvider(config, undefined, options.fetch) : undefined);
  const realtimeState = realtimeCapability(config);
  const realtimeProvider = options.realtimeProvider ?? (realtimeState === 'untested' ? new OpenAIRealtimeProvider(config, undefined, options.fetch) : undefined);
  const realtimeConnections = new RealtimeConnections(realtimeProvider, now);
  const capabilities: AppConfig['capabilities'] = {
    text: teachingConfigured && config.chatModel ? 'untested' : 'unconfigured',
    vision: teachingConfigured && config.visionModel ? 'untested' : 'unconfigured',
    structuredOutput: teachingConfigured && (config.chatModel || config.visionModel) ? 'untested' : 'unconfigured',
    tts: usingCosyTts ? (cosyProvider?.ready() ? 'untested' : 'unconfigured') : usingDoubaoTts ? (doubaoReady ? 'untested' : 'unconfigured') : speechEngine === 'openai' && !config.demoMode && config.apiKey && config.ttsModel ? 'untested' : 'unconfigured',
    transcription: !config.demoMode && config.apiKey && config.transcriptionModel ? 'untested' : 'unconfigured', realtimeAudio: realtimeState, realtimeTools: realtimeState, interruption: realtimeState,
  };
  const mode: AppConfig['mode'] = config.demoMode ? 'demo' : (teachingConfigured && (config.chatModel || config.visionModel)) || (config.apiKey && ((speechEngine === 'openai' && config.ttsModel) || config.transcriptionModel || config.realtimeModel)) ? 'live' : 'unconfigured';
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    if (!allowedHosts.has(req.headers.host ?? '')) return next(new HttpError(403, 'invalid_host', '只允许从本机应用地址访问。'));
    const origin = req.headers.origin;
    if ((origin && origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') return next(new HttpError(403, 'invalid_origin', '拒绝非本应用来源的请求。'));
    const taskLane = req.header('x-task-lane');
    if (taskLane !== undefined && (taskLane !== 'speech' || req.method !== 'POST' || !['/api/tts', '/api/cancel'].includes(req.path))) return next(new HttpError(400, 'invalid_task_lane', '独立朗读通道仅用于生成或取消语音。'));
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/realtime', express.json({ limit: '80kb', strict: true }));
  app.use('/api/transcribe', express.json({ limit: '5600kb', strict: true }));
  app.use(express.json({ limit: '3500kb', strict: true }));

  function expireSessions() {
    realtimeConnections.expire();
    for (const [id, session] of sessions) if (session.touchedAt + SESSION_TTL < now()) {
      for (const lane of [session, session.speech]) for (const job of lane.jobs) job.controller.abort(cancelledError());
      void realtimeConnections.disconnect(id);
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
  function taskLaneFor(req: Request, session: Session): TaskLane {
    return req.header('x-task-lane') === 'speech' ? session.speech : session;
  }
  function requireIdle(lane: TaskLane) {
    if ([...lane.jobs].some(job => !job.controller.signal.aborted)) throw new HttpError(409, 'request_in_progress', '此通道已有任务正在生成，请等待完成或先停止。');
  }
  function checkFresh(lane: TaskLane, envelope: Envelope) {
    // Cancellation may arrive before its request. Persist the boundary to prevent
    // a delayed request from starting a paid provider operation afterwards.
    if (envelope.generationId <= lane.cancelledThrough) throw new HttpError(409, 'stale_request', '本代任务已取消，迟到请求已丢弃。');
    if (envelope.generationId < lane.generation || envelope.contextRevision < lane.revision) throw new HttpError(409, 'stale_request', '过期请求已丢弃。');
    if (envelope.generationId > lane.generation || envelope.contextRevision > lane.revision) {
      for (const job of lane.jobs) job.controller.abort(cancelledError());
      lane.generation = envelope.generationId;
      lane.revision = envelope.contextRevision;
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
  async function runJob<T>(session: Session, envelope: Envelope, req: Request, res: Response, usage: UsageRecord, action: (signal: AbortSignal) => Promise<T>, timeoutMs = config.requestTimeoutMs, lane: TaskLane = session): Promise<T> {
    requireIdle(lane);
    const controller = new AbortController();
    const job: Job = { envelope, controller };
    lane.jobs.add(job);
    const stopForDisconnect = () => { if (!res.writableEnded) controller.abort(cancelledError()); };
    req.once('aborted', stopForDisconnect);
    res.once('close', stopForDisconnect);
    const timer = setTimeout(() => controller.abort(new HttpError(504, 'provider_timeout', '模型服务超时；已取消本地等待，可能已有用量。请手动重试。')), timeoutMs);
    timer.unref();
    try {
      const result = await new Promise<T>((resolve, reject) => {
        const aborted = () => reject(controller.signal.reason ?? cancelledError());
        controller.signal.addEventListener('abort', aborted, { once: true });
        // Promise resolution is still observed if a provider ignores cancellation.
        Promise.resolve().then(() => action(controller.signal)).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted));
      });
      if (controller.signal.aborted || envelope.generationId !== lane.generation || envelope.contextRevision !== lane.revision) throw cancelledError();
      return result;
    } catch (error) {
      usage.cancelled = controller.signal.aborted;
      const mapped = providerError(error);
      usage.requestId = mapped.requestId ?? usage.requestId;
      throw mapped;
    } finally {
      clearTimeout(timer); lane.jobs.delete(job);
      req.off('aborted', stopForDisconnect); res.off('close', stopForDisconnect);
    }
  }

  app.get('/api/config', (req, res) => {
    expireSessions();
    if (usingCosyTts) capabilities.tts = !cosyProvider?.ready() ? 'unconfigured' : cosyProvider.status() === 'error' ? 'error' : capabilities.tts === 'supported' ? 'supported' : 'untested';
    let session = sessions.get(cookieSession(req) ?? '');
    if (!session) {
      if (sessions.size >= 128) throw new HttpError(429, 'session_capacity', '本地会话数达到上限，请关闭闲置页面后重启本项目。');
      session = { id: randomUUID(), csrf: randomBytes(32).toString('hex'), touchedAt: now(), ...createTaskLane(), speech: createTaskLane(), transcribedGenerations: new Set(), requests: 0, recentRequests: [], usage: [] };
      sessions.set(session.id, session);
    }
    session.touchedAt = now();
    res.cookie(SESSION_COOKIE, session.id, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: SESSION_TTL });
    const body: AppConfig = { authMode: usingChatGpt ? 'chatgpt' : 'api_key', mode, sessionId: session.id, generationId: Math.max(session.generation, session.cancelledThrough), contextRevision: session.revision, csrfToken: session.csrf, capabilities: { ...capabilities }, models: { chat: config.chatModel, vision: config.visionModel, tts: ttsModel, transcription: config.transcriptionModel, realtime: config.realtimeModel }, realtime: { provider: 'openai-realtime', voice: config.realtimeVoice, maxSessionSeconds: REALTIME_MAX_SESSION_SECONDS, idleSeconds: REALTIME_IDLE_SECONDS, inputTranscriptionModel: config.realtimeTranscriptionModel }, teaching: { chatReasoningEffort: config.chatReasoningEffort, visionReasoningEffort: config.visionReasoningEffort, maxOutputTokens: config.teachingMaxOutputTokens, timeoutMs: config.teachingTimeoutMs }, speech: {
      engine: speechEngine, ready: speechEngine === 'openai' && capabilities.tts !== 'unconfigured', voice: config.ttsVoice,
      style: !config.ttsInstructionsSupported ? '使用模型默认语气' : config.ttsInstructions === [DEFAULT_TTS_STYLE, TTS_SOURCE_FIDELITY].join('\n') ? '自然温和，按语义停顿' : '本机自定义语气',
      instructionsSupported: config.ttsInstructionsSupported,
    }, maxRequests: config.maxRequests };
    if(usingDoubaoTts) body.speech={engine:'doubao',ready:doubaoReady,voice:config.doubaoTtsVoice??'',style:'豆包中文朗读；额度与权限需在官方控制台确认',instructionsSupported:true};
    if (usingCosyTts) body.speech = { engine: 'cosy', ready: !!cosyProvider?.ready(), status: cosyProvider?.status() ?? 'missing', streaming: true, device: 'cuda', voice: config.cosyTtsVoice ?? DEFAULT_COSY_TTS_VOICE, style: '本地 CosyVoice 3 · 可选参考音色 · 首次使用加载模型', instructionsSupported: false };
    if (speechEngine === 'none') body.speech = { engine: 'none', ready: false, voice: '', style: '朗读已关闭，请选择并配置可用语音', instructionsSupported: false };
    res.json({ ...body, speechSession: { generationId: Math.max(session.speech.generation, session.speech.cancelledThrough), contextRevision: session.speech.revision } });
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
    if (usingChatGpt && (!options.chatGptAuth || !model || !provider)) throw new HttpError(503, 'chatgpt_not_configured', '请在桌面设置中登录 ChatGPT、选择可用模型并应用设置；未使用演示回答替代。');
    if (!teachingConfigured || !model || !provider) throw new HttpError(503, 'not_configured', request.context.imageDataUrl ? '视觉模型或 API Key 未配置。截图保留在本机，未假装识别。' : '文字模型或 API Key 未配置。请在本机 .env 中配置后重启。');
    requireIdle(session);
    consumeRequest(session);
    const usage = newUsage(session, model, 'text');
    const result = await runJob(session, request, req, res, usage, signal => provider.ask(request, model, signal), config.teachingTimeoutMs);
    usage.requestId = safeRequestId(result.requestId) ?? usage.requestId;
    usage.inputTokens = Number.isFinite(result.inputTokens) ? result.inputTokens! : null;
    usage.outputTokens = Number.isFinite(result.outputTokens) ? result.outputTokens! : null;
    if (result.incompleteReason) {
      capabilities.structuredOutput = 'error';
      throw new HttpError(502, 'incomplete_model_output', result.incompleteReason === 'max_output_tokens'
        ? '本次回答达到输出上限，推理过程也计入该上限；未显示不完整教案。请缩小问题，或在本机提高 TEACHING_MAX_OUTPUT_TOKENS 后手动重试。未自动切换模型；本次可能已有用量。'
        : '模型未完成本次回答，未显示不完整教案。请核对服务状态后手动重试；未自动切换模型，本次可能已有用量。', safeRequestId(result.requestId));
    }
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

  app.post('/api/reading-assist', async (req, res) => {
    const session = requireMutation(req);
    const parsed = ReadingAssistRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_request', '朗读整理的选区或上下文格式不正确，或超出长度限制。');
    const request = parsed.data;
    if (request.context.sources.some(source => source.documentId !== request.context.documentId) || new Set(request.context.sources.map(source => source.sourceId)).size !== request.context.sources.length) throw new HttpError(400, 'context_mismatch', '本次朗读选区必须来自同一本书，且来源不能重复。');
    if (request.context.sources.reduce((sum, source) => sum + source.sourceText.length, 0) > 24000) throw new HttpError(400, 'context_too_large', '朗读选区超过 24000 字，请缩小选区；没有静默裁剪。');
    if (!request.context.imageDataUrl && request.context.sources.every(source => !source.sourceText.trim())) throw new HttpError(400, 'empty_reading_source', '没有可整理的原文或框选图片。');
    if (request.context.imageDataUrl) {
      const start = Buffer.from(request.context.imageDataUrl.slice('data:image/png;base64,'.length, 'data:image/png;base64,'.length + 16), 'base64');
      if (start.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new HttpError(400, 'invalid_image', '截图不是有效的 PNG 图片。');
    }
    checkFresh(session, request);
    setEnvelope(res, request);
    if (config.demoMode) throw new HttpError(409, 'demo_reading_assist', '演示模式不调用模型整理朗读稿，也不提供模拟识别；请登录 ChatGPT 或配置文字模型。');
    const model = request.context.imageDataUrl ? config.visionModel : config.chatModel;
    if (usingChatGpt && (!options.chatGptAuth || !model || !provider)) throw new HttpError(503, 'chatgpt_not_configured', '请在桌面设置中登录 ChatGPT、选择可用模型并应用设置；没有使用演示稿替代。');
    if (!teachingConfigured || !model || !provider) throw new HttpError(503, 'not_configured', request.context.imageDataUrl ? '视觉模型或 API Key 未配置，未识别截图。' : '文字模型或 API Key 未配置；可在桌面设置中登录 ChatGPT 或在本机配置 API。');
    if (!provider.readingAssist) throw new HttpError(503, 'reading_assist_unsupported', '当前模型适配器尚不支持朗读稿整理，未改用解题回答或其他服务。');
    // A duplicate does not spend the local request budget or create a fictitious usage row.
    requireIdle(session);
    consumeRequest(session);
    const usage = newUsage(session, model, 'text');
    const result = await runJob(session, request, req, res, usage, signal => provider.readingAssist!(request, model, signal), config.teachingTimeoutMs);
    usage.requestId = safeRequestId(result.requestId) ?? usage.requestId;
    usage.inputTokens = Number.isSafeInteger(result.inputTokens) && result.inputTokens! >= 0 ? result.inputTokens! : null;
    usage.outputTokens = Number.isSafeInteger(result.outputTokens) && result.outputTokens! >= 0 ? result.outputTokens! : null;
    if (result.incompleteReason) {
      capabilities.structuredOutput = 'error';
      throw new HttpError(502, 'incomplete_model_output', result.incompleteReason === 'max_output_tokens'
        ? '朗读稿达到模型输出上限，未使用截断结果；请缩小选区后重试，本次可能已有用量。'
        : '模型未完成朗读稿整理，未使用不完整结果；请手动重试，本次可能已有用量。', safeRequestId(result.requestId));
    }
    let draft;
    try { draft = validateReadingAssist(result.draft, request); }
    catch {
      capabilities.structuredOutput = 'error';
      throw new HttpError(502, 'invalid_reading_output', '模型朗读稿未通过结构、长度或上下文校验，未开始朗读；请缩小选区后重试。', safeRequestId(result.requestId));
    }
    capabilities[request.context.imageDataUrl ? 'vision' : 'text'] = 'supported';
    capabilities.structuredOutput = 'supported';
    const answer = ReadingAssistResponseSchema.parse({ sessionId: request.sessionId, generationId: request.generationId, ...draft, usage });
    res.json(answer);
  });
  app.post('/api/tts', async (req, res) => {
    const session = requireMutation(req);
    const lane = taskLaneFor(req, session);
    const parsed = TtsRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_request', `请选择有效音色；朗读文本不能为空或超过 1600 字，语速范围为 ${MIN_SPEECH_RATE} 到 ${MAX_SPEECH_RATE}。`);
    const request = parsed.data;
    if (request.cosyVoice !== undefined && !usingCosyTts) throw new HttpError(400, 'cosy_voice_engine', 'CosyVoice 音色试听仅支持当前已配置的 CosyVoice 朗读方式，请先切换并应用设置。');
    const cosyVoice = request.cosyVoice ?? config.cosyTtsVoice ?? DEFAULT_COSY_TTS_VOICE;
    checkFresh(lane, request);
    setEnvelope(res, request);
    if (speechEngine === 'none') throw new HttpError(503, 'speech_not_configured', '朗读未配置。Qwen、Kokoro 和系统声音已移除，请在设置中选择并配置可用语音；未自动切换服务。');
    if (!usingCosyTts && !usingDoubaoTts && config.demoMode) throw new HttpError(409, 'demo_tts', '演示模式未调用 OpenAI TTS。请在本机完成相应接口配置后再朗读。');
    if (usingCosyTts && !cosyProvider?.ready()) throw new HttpError(503, 'cosy_not_installed', 'CosyVoice 3 本地环境未安装完整，请完成本项目语音安装后重试；没有切换到云语音。');
    if (usingDoubaoTts && !doubaoReady) throw new HttpError(503, 'doubao_not_configured', '豆包语音尚未配置。请在声音设置中填写本机豆包 API Key，并先到官方控制台确认试用额度；没有改用其他服务。');
    if (!usingCosyTts && !usingDoubaoTts && (!config.apiKey || !config.ttsModel || !provider)) throw new HttpError(503, 'not_configured', usingChatGpt ? 'ChatGPT 登录用于解题。OpenAI 朗读还需要独立语音 API Key；未自动切换语音服务。' : 'TTS 模型或 API Key 未配置；未自动切换语音服务。');
    const contentType = usingDoubaoTts ? 'audio/wav' : 'audio/mpeg';
    const cacheKey = cache.key(session.id, usingCosyTts ? ['cosy', ttsModel, cosyVoice, request.text] : usingDoubaoTts ? ['doubao',ttsModel,config.doubaoTtsVoice,config.doubaoTtsInstructions,request.text] : [config.baseUrl, speechRequest(config, request.text, request.speed)]);
    const cached = cache.get(cacheKey);
    if (cached) { res.set('x-audio-cache', 'hit').type(contentType).send(cached); return; }
    requireIdle(lane);
    consumeRequest(session);
    const usage = newUsage(session, ttsModel, 'tts', usingDoubaoTts ? null : request.text.length);
    if (usingCosyTts) usage.local = true;
    const streaming = usingCosyTts && req.header('x-audio-stream') === '1';
    let streamedBytes = 0;
    try {
      const result = await runJob(session, request, req, res, usage, signal => {
        const onAudio = streaming ? (audio: Buffer) => {
          if (signal.aborted || res.destroyed || request.generationId !== lane.generation || request.contextRevision !== lane.revision) return;
          streamedBytes += audio.length;
          if (streamedBytes > 8 * 1024 * 1024) throw new HttpError(502, 'invalid_audio', '本地语音超出大小限制，已停止播放。');
          if (!res.headersSent) res.set({ 'x-audio-streaming': '1', 'x-audio-cache': 'miss', 'x-request-id': usage.requestId }).type(contentType);
          res.write(audio);
        } : undefined;
        return usingCosyTts ? cosyProvider!.speak(request.text, request.speed, signal, onAudio, cosyVoice) : usingDoubaoTts ? doubaoProvider!.speak(request.text,request.speed,signal,session.id+(lane === session ? '-' : '-speech-')+request.contextRevision+'-'+request.generationId) : provider!.speak(request.text, request.speed, signal);
      }, usingCosyTts ? 310000 : usingDoubaoTts ? 125000 : config.requestTimeoutMs, lane);
      if (!result.audio.length || result.audio.length > 8 * 1024 * 1024) throw new HttpError(502, 'invalid_audio', '语音返回为空或超出大小限制，未播放。');
      if (streaming && streamedBytes > 0 && streamedBytes !== result.audio.length) throw new HttpError(502, 'invalid_audio', '本地语音流不完整，未缓存。');
      usage.requestId = safeRequestId('requestId' in result ? result.requestId : undefined) ?? usage.requestId;
      if (usingDoubaoTts) usage.characters = 'characters' in result && typeof result.characters === 'number' ? result.characters : null;
      if (usingCosyTts && 'metrics' in result && result.metrics) usage.audioSeconds = result.metrics.audioSeconds;
      cache.set(session.id, cacheKey, result.audio);
      capabilities.tts = 'supported';
      if (streaming && streamedBytes > 0) res.end();
      else res.set({ 'x-audio-cache': 'miss', 'x-request-id': usage.requestId }).type(contentType).send(result.audio);
    } catch (error) {
      // A partial MPEG stream cannot be followed by JSON or reported as a successful end.
      if (res.headersSent) { res.destroy(); return; }
      throw error;
    }
  });

  app.post('/api/transcribe', async (req, res) => {
    const session = requireMutation(req);
    const parsed = TranscriptionRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_recording', '录音格式无效；请录制 0.3 到 60 秒、4 MB 以内的语音。');
    const request = parsed.data;
    const audio = validateRecording(request.audioBase64, request.mimeType);
    checkFresh(session, request);
    setEnvelope(res, request);
    if (config.demoMode) throw new HttpError(409, 'demo_transcription', '演示模式不上传录音，也不提供模拟转写。请直接输入文字，或在本机配置转写模型。');
    if (!config.apiKey || !config.transcriptionModel || !provider) throw new HttpError(503, 'not_configured', '转写模型或 API Key 未配置；请在本机 .env 设置 TRANSCRIPTION_MODEL 后重启，或直接输入文字。');
    // One recording per generation. A repeat cannot start another paid transcription.
    if (session.transcribedGenerations.has(request.generationId)) throw new HttpError(409, 'duplicate_transcription', '这段录音已经提交，请重新录音后再试。');
    consumeRequest(session);
    session.transcribedGenerations.add(request.generationId);
    const usage = newUsage(session, config.transcriptionModel, 'transcription');
    usage.audioSeconds = null;
    try {
      const result = await runJob(session, request, req, res, usage, signal => provider.transcribe(audio, request.mimeType, signal));
      usage.requestId = safeRequestId(result.requestId) ?? usage.requestId;
      usage.inputTokens = Number.isFinite(result.inputTokens) ? result.inputTokens! : null;
      usage.outputTokens = Number.isFinite(result.outputTokens) ? result.outputTokens! : null;
      usage.audioSeconds = Number.isFinite(result.audioSeconds) ? result.audioSeconds! : null;
      const response = TranscriptionResponseSchema.safeParse({ sessionId: request.sessionId, generationId: request.generationId, contextRevision: request.contextRevision, mode: 'live', text: result.text });
      if (!response.success) throw new HttpError(502, 'empty_transcription', '没有得到有效的转写文字，或文字超过 2000 字。请靠近麦克风、缩短问题后重录，或直接输入文字。');
      capabilities.transcription = 'supported';
      res.json({ ...response.data, usage });
    } catch (error) {
      if (!(error instanceof HttpError) || !['cancelled', 'stale_request'].includes(error.code)) capabilities.transcription = 'error';
      throw error;
    } finally {
      audio.fill(0);
    }
  });

  app.post('/api/realtime/connect', async (req, res) => {
    const session = requireMutation(req);
    const parsed = RealtimeConnectRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_request', '实时连接请求格式不正确，SDP 不得超过 64 KiB。');
    const request = parsed.data;
    setEnvelope(res, request);
    if (config.demoMode) throw new HttpError(409, 'demo_realtime', '演示模式不连接实时服务，不上传麦克风，也不模拟真人对话。');
    if (realtimeState === 'unsupported') throw new HttpError(503, 'realtime_unsupported', '当前服务地址、实时转写模型或声音不支持本应用的官方 WebRTC 适配；文字和录音转写仍可使用。');
    if (realtimeState === 'unconfigured' || !realtimeProvider) throw new HttpError(503, 'not_configured', '请在本机 .env 配置 API Key、REALTIME_MODEL 和 REALTIME_TRANSCRIPTION_MODEL 后重启；模型权限及费用需自行核对。');
    // Reject a duplicate before it can abort an in-progress exchange or consume a paid request.
    if (realtimeConnections.has(session.id)) throw new HttpError(409, 'realtime_in_progress', '此页面已有实时连接或正在连接，请先关闭。');
    checkFresh(session, request);
    consumeRequest(session);
    const usage = newUsage(session, config.realtimeModel, 'realtime');
    usage.audioSeconds = null; usage.connectionSeconds = null;
    const lease = realtimeConnections.reserve(session.id, usage);
    try {
      const result = await runJob(session, request, req, res, usage, signal => realtimeConnections.exchange(lease, request.sdp, signal));
      // SDP success alone does not verify audio, tools, VAD, or actual interruption.
      const response: RealtimeConnectResponse = { sessionId: request.sessionId, generationId: request.generationId, contextRevision: request.contextRevision, ...result };
      res.json(response);
    } catch (error) {
      await realtimeConnections.release(lease);
      throw error;
    }
  });
  app.post('/api/realtime/heartbeat', (req, res) => {
    const session = requireMutation(req);
    const parsed = RealtimeConnectionRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_request', '实时连接续约格式不正确。');
    setEnvelope(res, parsed.data);
    // Connection ownership is independent of response generations and cancellation boundaries.
    res.json({ ...parsed.data, ...realtimeConnections.heartbeat(session.id, parsed.data.connectionId) });
  });
  app.post('/api/realtime/disconnect', async (req, res) => {
    const session = requireMutation(req);
    const parsed = RealtimeConnectionRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_request', '实时连接关闭格式不正确。');
    setEnvelope(res, parsed.data);
    const upstreamCancellation = await realtimeConnections.disconnect(session.id, parsed.data.connectionId);
    res.json({ ...parsed.data, active: false, upstreamCancellation });
  });

  app.post('/api/cancel', (req, res) => {
    const session = requireMutation(req);
    const lane = taskLaneFor(req, session);
    const parsed = EnvelopeSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_request', '取消请求格式不正确。');
    const envelope = parsed.data;
    lane.cancelledThrough = Math.max(lane.cancelledThrough, envelope.generationId);
    let cancelled = 0;
    for (const job of lane.jobs) if (job.envelope.generationId <= envelope.generationId && !job.controller.signal.aborted) { job.controller.abort(cancelledError()); cancelled += 1; }
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
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'unknown_endpoint', '此接口未实现，请刷新页面并检查应用版本。')));

  const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    const details = typeof error === 'object' && error ? error as Record<string, unknown> : {};
    const safe = error instanceof HttpError ? error : details.type === 'entity.too.large' ? new HttpError(413, 'payload_too_large', '请求过大，请缩小选区、截图或录音。') : details.type === 'entity.parse.failed' ? new HttpError(400, 'invalid_json', '请求格式不是有效 JSON。') : new HttpError(500, 'internal_error', '本地服务处理失败，请重试；未输出敏感诊断内容。');
    if (res.headersSent || res.destroyed) return;
    const envelope = EnvelopeSchema.safeParse(req.body);
    if (envelope.success) setEnvelope(res, envelope.data);
    res.status(safe.status).json({ ...(envelope.success ? envelope.data : {}), error: safe.code, message: safe.message, requestId: safe.requestId ?? randomUUID() });
  };
  app.use(errorHandler);
  let disposing: Promise<void> | undefined;
  app.locals.dispose = () => {
    disposing ??= (async () => {
      const activeIds = [...sessions.keys()];
      for (const session of sessions.values()) {
        for (const lane of [session, session.speech]) for (const job of lane.jobs) job.controller.abort(cancelledError());
        cache.clear(session.id);
      }
      sessions.clear();
      doubaoProvider?.dispose();
      cosyProvider?.dispose();
      await Promise.allSettled(activeIds.map(id => realtimeConnections.disconnect(id)));
    })();
    return disposing;
  };
  return app;
}
