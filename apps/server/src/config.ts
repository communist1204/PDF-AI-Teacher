export interface ServerConfig {
  host: '127.0.0.1';
  port: number;
  demoMode: boolean;
  apiKey: string;
  baseUrl: string;
  chatModel: string;
  visionModel: string;
  ttsModel: string;
  ttsVoice: string;
  requestTimeoutMs: number;
  maxRequests: number;
  requestsPerMinute: number;
  cacheMaxBytes: number;
}

function integer(value: string | undefined, fallback: number, min: number, max: number) {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error('本地配置中的数字超出允许范围。');
  return parsed;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (env.APP_HOST && env.APP_HOST !== '127.0.0.1') throw new Error('此版本 APP_HOST 只允许 127.0.0.1。');
  if (env.DEMO_MODE && !['true', 'false'].includes(env.DEMO_MODE)) throw new Error('DEMO_MODE 必须为 true 或 false。');
  const baseUrl = env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('OPENAI_BASE_URL 必须为 HTTPS 服务地址或本机回环 HTTP 地址，且不能包含凭证。');
  }
  return {
    host: '127.0.0.1',
    port: integer(env.APP_PORT, 4317, 1024, 65535),
    // Starting without a private .env never enables paid network calls.
    demoMode: env.DEMO_MODE !== 'false',
    apiKey: env.OPENAI_API_KEY?.trim() || '',
    baseUrl,
    chatModel: env.CHAT_MODEL?.trim() || '',
    visionModel: env.VISION_MODEL?.trim() || '',
    ttsModel: env.TTS_MODEL?.trim() || '',
    ttsVoice: env.TTS_VOICE?.trim() || 'coral',
    requestTimeoutMs: integer(env.REQUEST_TIMEOUT_MS, 45000, 1000, 120000),
    maxRequests: integer(env.MAX_SESSION_REQUESTS, 100, 1, 1000),
    requestsPerMinute: integer(env.REQUESTS_PER_MINUTE, 30, 1, 120),
    cacheMaxBytes: integer(env.TTS_CACHE_MB, 32, 1, 128) * 1024 * 1024,
  };
}
