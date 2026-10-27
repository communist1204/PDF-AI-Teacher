import { HttpError } from './errors';

export const BING_TRANSLATOR_PAGE = 'https://cn.bing.com/translator?edgepdftranslator=1&from=auto-detect&FORM=TTVEPT';
const HOSTS = new Set(['www.bing.com', 'cn.bing.com']);
const MAX_PAGE = 1024 * 1024;
const MAX_AUDIO = 4 * 1024 * 1024;
const TIMEOUT = 30000;
type PageSession = { origin: string; ig: string; iid: string; key: number; token: string; expires: number; sequence: number };
export interface BingTtsOptions { fetchImpl: typeof fetch; timeoutMs?: number }

// The public PDF translator page currently uses Xiaoxiao at -20%. This is an
// experimental website integration, not a supported Azure API or unlimited quota.
const fail = (code: string, message: string) => new HttpError(502, code, message);
const invalid = () => fail('bing_response', '微软翻译朗读暂未返回有效声音，请稍后手动重试。');
const cancelled = () => fail('bing_cancelled', '已取消微软翻译朗读。');
function checkStatus(response: Response) {
  if (response.status === 401 || response.status === 403) throw fail('bing_denied', '微软翻译朗读拒绝了请求，已停止；可切回豆包或稍后手动重试。');
  if (response.status === 429) throw fail('bing_limit', '微软翻译朗读正在限流，请稍后手动重试；不会自动反复请求。');
  if (!response.ok) throw invalid();
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { void operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function bytes(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (!response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))) {
    void response.body?.cancel().catch(() => {}); throw invalid();
  }
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let count = 0;
  try {
    for (;;) {
      const item = await bounded(reader.read(), signal);
      if (item.done) break;
      count += item.value.byteLength;
      if (count > limit) throw invalid();
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, count);
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function xml(text: string): string {
  return text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]!);
}
function publicPageUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password || url.pathname !== '/translator') throw invalid();
  return url;
}

export class BingTtsProvider {
  private current: PageSession | undefined;
  private pending: Promise<PageSession> | undefined;
  private active = new Set<AbortController>();
  private disposed = false;
  constructor(private options: BingTtsOptions) {}

  private async request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const operation = this.options.fetchImpl(url, { ...init, signal, redirect: 'manual', credentials: 'include', cache: 'no-store' });
    void operation.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    return bounded(operation, signal);
  }
  private async loadPage(signal: AbortSignal): Promise<PageSession> {
    let url = publicPageUrl(BING_TRANSLATOR_PAGE);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await this.request(url.href, {}, signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw invalid();
        url = publicPageUrl(new URL(location, url).href); continue;
      }
      try { checkStatus(response); } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
      const html = (await bytes(response, MAX_PAGE, signal)).toString('utf8');
      // Parse only bounded data literals; never evaluate page JavaScript.
      const data = /params_AbusePreventionHelper\s*=\s*(\[[^\r\n;]{1,8192}\])/.exec(html);
      const ig = /\bIG:\s*"([A-Fa-f0-9]{32})"/.exec(html)?.[1];
      const tag = /<[^>]{0,2048}\bid=["']rich_tta["'][^>]{0,2048}>/.exec(html)?.[0] ?? '';
      const iid = /\bdata-iid=["']([A-Za-z0-9_.-]{1,100})["']/.exec(tag)?.[1];
      if (!data || !ig || !iid) throw fail('bing_page_changed', '微软翻译页面暂不可用或已变化，未发送朗读文字；请稍后重试或切回豆包。');
      const fields: unknown = JSON.parse(data[1]);
      if (!Array.isArray(fields) || fields.length !== 3 || !Number.isSafeInteger(fields[0]) || fields[0] <= 0
        || typeof fields[1] !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(fields[1])
        || !Number.isFinite(fields[2]) || fields[2] < 60000) throw invalid();
      return { origin: (response.url ? publicPageUrl(response.url) : url).origin, ig, iid, key: fields[0], token: fields[1], expires: Date.now() + Math.min(fields[2], 3600000) - 30000, sequence: 0 };
    }
    throw invalid();
  }
  private async page(signal: AbortSignal): Promise<PageSession> {
    if (this.current && this.current.expires > Date.now()) return this.current;
    if (!this.pending) {
      const pending = this.loadPage(signal).then(value => { if (!this.disposed) this.current = value; return value; });
      this.pending = pending;
      void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
    }
    return bounded(this.pending, signal);
  }
  async speak(text: string, _speed: number, signal: AbortSignal): Promise<{ audio: Buffer; mimeType: 'audio/mpeg' }> {
    if (this.disposed || signal.aborted) throw cancelled();
    // eslint-disable-next-line no-control-regex
    if (!text.trim() || text.length > 3000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw fail('bing_text', '微软翻译朗读每段最多 3000 字，请缩小范围。');
    const controller = new AbortController();
    const abort = () => controller.abort(cancelled());
    signal.addEventListener('abort', abort, { once: true }); this.active.add(controller);
    if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(fail('bing_timeout', '微软翻译朗读等待超时，已停止；请稍后手动重试。')), this.options.timeoutMs ?? TIMEOUT);
    timer.unref();
    try {
      const page = await this.page(controller.signal);
      controller.signal.throwIfAborted();
      const url = new URL('/tfettts', page.origin);
      url.search = new URLSearchParams({ isVertical: '1', IG: page.ig, IID: page.iid, SFX: String(++page.sequence) }).toString();
      const ssml = '<speak version="1.0" xml:lang="zh-CN"><voice xml:lang="zh-CN" xml:gender="Female" name="zh-CN-XiaoxiaoNeural"><prosody rate="-20.00%">' + xml(text) + '</prosody></voice></speak>';
      const response = await this.request(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Origin: page.origin, Referer: page.origin + '/translator' },
        body: new URLSearchParams({ ssml, token: page.token, key: String(page.key) }).toString(),
      }, controller.signal);
      try { checkStatus(response); } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
      const kind = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(kind ?? '')) {
        void response.body?.cancel().catch(() => {}); throw invalid();
      }
      const audio = await bytes(response, MAX_AUDIO, controller.signal);
      if (audio.length < 32 || !(audio.subarray(0, 3).toString() === 'ID3' || (audio[0] === 255 && (audio[1] & 224) === 224))) throw invalid();
      controller.signal.throwIfAborted();
      return { audio, mimeType: 'audio/mpeg' };
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof HttpError) throw error;
      throw invalid();
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); this.active.delete(controller); controller.abort(); }
  }
  dispose() { this.disposed = true; this.current = undefined; for (const controller of this.active) controller.abort(cancelled()); }
}
