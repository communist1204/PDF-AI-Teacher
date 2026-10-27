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
  const requestId = safeRequestId(details.requestID) ?? safeRequestId(details.request_id);
  const status = details.status;
  const payload = typeof details.error === 'object' && details.error ? details.error as Record<string, unknown> : {};
  const code = details.code ?? payload.code;
  const type = details.type ?? payload.type;
  if (status === 401) return new HttpError(502, 'provider_authentication', '模型服务认证失败，请在本机检查 API Key。', requestId);
  if (status === 403) return new HttpError(502, 'provider_permission', '模型服务权限不足，请检查账号或模型权限。', requestId);
  if (status === 404) return new HttpError(502, 'provider_model', '模型不存在或当前账号不可用，请检查模型配置。', requestId);
  if (status === 429) {
    // Billing limits also use HTTP 429. Classify only whitelisted codes/types;
    // never infer the cause from or expose the provider's free-form message.
    switch (code) {
      case 'credit_balance_exhausted':
        return new HttpError(502, 'provider_quota', 'API 可用余额不足。请在设置中打开「查看 API 账单」检查余额；仅创建 Key 不会增加额度。', requestId);
      case 'project_spend_limit_exceeded':
        return new HttpError(502, 'provider_quota', '这个 Key 所属项目已达到 API 支出上限。请在 API 平台检查该项目的限额；等待重试不能解除此限制。', requestId);
      case 'organization_spend_limit_exceeded':
        return new HttpError(502, 'provider_quota', '这个 Key 所属组织已达到 API 支出上限。请在 API 平台检查组织限额；等待重试不能解除此限制。', requestId);
      case 'organization_usage_limit_exceeded':
        return new HttpError(502, 'provider_quota', '这个 Key 所属组织已达到 API 用量上限。请在 API 平台查看 Limits，必要时申请提高限额。', requestId);
    }
    if (code === 'insufficient_quota' || type === 'insufficient_quota') return new HttpError(502, 'provider_quota', 'API 额度不足。请在设置中打开「查看 API 账单」，检查可用余额及项目/组织限额；ChatGPT 订阅不包含这里的 API 额度。', requestId);
    if (code === 'rate_limit_exceeded' || code === 'rate_limit' || code === 'slow_down' || type === 'rate_limit_error') return new HttpError(503, 'provider_rate_limit', 'API 请求过于频繁，请稍后手动重试。若持续出现，请在 API 平台检查该模型的速率限制。', requestId);
    return new HttpError(503, 'provider_limit_unknown', 'API 返回了请求限制（429），尚不能确定是频率还是额度。请先通过设置中的「查看 API 账单」检查余额和限额；本次未自动重试。', requestId);
  }
  if (status === 400) return new HttpError(502, 'provider_capability', '模型不接受当前请求或结构化/图片/语音能力，请检查配置；未自动更换服务。', requestId);
  if (details.name === 'APIConnectionTimeoutError') return new HttpError(504, 'provider_timeout', '模型服务超时；已停止本地等待，可能已有用量。请手动重试。', requestId);
  if (details.name === 'ZodError' || details.name === 'SyntaxError') return new HttpError(502, 'invalid_model_output', '模型输出未通过结构校验，未执行板书。请缩短问题后手动重试。', requestId);
  return new HttpError(502, 'provider_connection', '模型服务连接或响应失败。请检查网络与服务配置后手动重试。', requestId);
}
