export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) { super(message); }
}

export function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^req_[a-zA-Z0-9_-]{1,96}$/.test(value) ? value : undefined;
}

/** Never return provider error messages, bodies, URLs, authorization headers or stack traces. */
export function providerError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const details = typeof error === 'object' && error ? error as Record<string, unknown> : {};
  const requestId = safeRequestId(details.request_id);
  const status = details.status;
  const code = details.code;
  if (status === 401) return new HttpError(502, 'provider_authentication', '模型服务认证失败，请在本机检查 API Key。', requestId);
  if (status === 403) return new HttpError(502, 'provider_permission', '模型服务权限不足，请检查账号或模型权限。', requestId);
  if (status === 404) return new HttpError(502, 'provider_model', '模型不存在或当前账号不可用，请检查模型配置。', requestId);
  if (status === 429 && code === 'insufficient_quota') return new HttpError(502, 'provider_quota', '模型服务额度不足，请检查 API 账单。', requestId);
  if (status === 429) return new HttpError(503, 'provider_rate_limit', '模型服务正在限流，请稍后手动重试。', requestId);
  if (status === 400) return new HttpError(502, 'provider_capability', '模型不接受当前请求或结构化/图片/语音能力，请检查配置；未自动更换服务。', requestId);
  if (details.name === 'APIConnectionTimeoutError') return new HttpError(504, 'provider_timeout', '模型服务超时；已停止本地等待，可能已有用量。请手动重试。', requestId);
  if (details.name === 'ZodError' || details.name === 'SyntaxError') return new HttpError(502, 'invalid_model_output', '模型输出未通过结构校验，未执行板书。请缩短问题后手动重试。', requestId);
  return new HttpError(502, 'provider_connection', '模型服务连接或响应失败。请检查网络与服务配置后手动重试。', requestId);
}
