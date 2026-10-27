import { randomUUID } from 'node:crypto';
import { HttpError } from './errors';
import { MIN_SPEECH_RATE, MAX_SPEECH_RATE } from '../../../packages/shared/speechRate';

// Official protocol checked 2026-09-30. This adapter buffers PCM into a complete WAV;
// it does not claim that playback in the browser is streamed.
// https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh
// https://github.com/bytedance/agentkit-samples/blob/main/skills/byted-text-to-speech/scripts/text_to_speech.py
// Voice IDs: https://docs.byteplus.com/zh-CN/docs/byteplusvoice/tts-voice-list
export const DOUBAO_TTS_VOICES = [
  'zh_female_xiaohe_uranus_bigtts',
  'zh_female_vv_uranus_bigtts',
  'zh_male_taocheng_uranus_bigtts',
] as const;
const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const COMPLETE_CODE = 20_000_000;

export interface DoubaoTtsOptions {
  apiKey: string;
  voice: string;
  instructions: string;
  fetchImpl?: typeof fetch;
}
export interface DoubaoTtsResult { audio: Buffer; characters?: number }

const invalidResponse = () => new HttpError(502, 'doubao_tts_response', '豆包语音响应不完整或格式不正确，未播放不完整音频；请手动重试。');
const cancelled = () => new HttpError(409, 'doubao_tts_cancelled', '已取消豆包朗读请求；服务端可能已产生用量。');
const timeout = () => new HttpError(504, 'doubao_tts_timeout', '豆包语音等待超时，已取消请求；服务端可能已产生用量，请手动重试。');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Abort is bounded even if an injected transport ignores its signal. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function wave(pcm: Buffer): Buffer {
  if (pcm.length < 2 || pcm.length % 2 !== 0 || pcm.length + 44 > MAX_RESPONSE_BYTES) throw invalidResponse();
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function httpFailure(status: number): HttpError {
  if (status === 401 || status === 403) return new HttpError(502, 'doubao_tts_auth', '豆包语音鉴权或权限不足。请在本机检查 API Key、语音合成 2.0 服务和音色权限。');
  if (status === 429) return new HttpError(503, 'doubao_tts_limit', '豆包语音返回请求限制。请在官方控制台检查试用额度和并发限制；本次未自动重试。');
  return new HttpError(502, 'doubao_tts_http', '豆包语音请求未成功。请在官方控制台检查服务与额度，或稍后手动重试。');
}

/** Only explicitly configured official cloud TTS; no retries, fallback, or credential logging. */
export class DoubaoTtsProvider {
  private readonly options: DoubaoTtsOptions;
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(options: DoubaoTtsOptions) {
    if (!(DOUBAO_TTS_VOICES as readonly string[]).includes(options.voice)) throw new HttpError(400, 'doubao_tts_voice', '请选择列表中的豆包 2.0 中文音色。');
    if (options.instructions.length > 1000 || options.instructions.includes('\0')) throw new HttpError(400, 'doubao_tts_style', '豆包朗读语气请限制在 1000 字以内。');
    this.options = { ...options, apiKey: options.apiKey.trim() };
  }

  ready(): boolean {
    // Readiness means locally configured, not that account entitlement or a real call was verified.
    return !this.disposed && /^[\x21-\x7e]{1,4096}$/.test(this.options.apiKey);
  }

  async speak(text: string, speed: number, signal: AbortSignal, sectionId?: string): Promise<DoubaoTtsResult> {
    if (this.disposed) throw new HttpError(503, 'doubao_tts_closed', '豆包语音连接已关闭，请重新打开软件。');
    if (!text.trim() || text.length > 6000 || text.includes('\0')) throw new HttpError(400, 'doubao_tts_text', '请选择不超过 6000 字的有效朗读文字。');
    if (!Number.isFinite(speed) || speed < MIN_SPEECH_RATE || speed > MAX_SPEECH_RATE) throw new HttpError(400, 'doubao_tts_speed', `朗读速度应为 ${MIN_SPEECH_RATE} 到 ${MAX_SPEECH_RATE} 倍。`);
    if (sectionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(sectionId)) throw new HttpError(400, 'doubao_tts_section', '朗读段落标识无效，请重新选择原文。');
    if (signal.aborted) throw cancelled();
    if (!this.ready()) throw new HttpError(503, 'doubao_tts_missing', '请先在本机填写豆包语音 API Key，并在官方控制台确认语音合成 2.0 的试用额度；尚未发送原文。');

    const controller = new AbortController();
    const abort = () => controller.abort(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(timeout()), TIMEOUT_MS); timer.unref();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStream<Uint8Array> | null | undefined;
    try {
      const additions = {
        disable_markdown_filter: true,
        enable_latex_tn: true,
        latex_parser: 'v2',
        ...(this.options.instructions.trim() ? { context_texts: [this.options.instructions.trim()] } : {}),
        ...(sectionId ? { section_id: sectionId } : {}),
      };
      const request = (this.options.fetchImpl ?? fetch)(ENDPOINT, {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.options.apiKey,
          'X-Api-Resource-Id': 'seed-tts-2.0',
          'X-Api-Request-Id': randomUUID(),
          'X-Control-Require-Usage-Tokens-Return': '*',
        },
        body: JSON.stringify({ req_params: {
          text, speaker: this.options.voice,
          // Always synthesize at native speed. The audio controller applies live playbackRate.
          audio_params: { format: 'pcm', sample_rate: 24000, speech_rate: 0 },
          additions: JSON.stringify(additions),
        } }),
      });
      // If the transport ignores abort and resolves late, still release its response body.
      void request.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await abortable(request, controller.signal);
      body = response.body;
      if (!response.ok) throw httpFailure(response.status);
      if (!body) throw invalidResponse();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw invalidResponse();
      reader = body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const chunks: Buffer[] = [];
      let bytes = 0, audioBytes = 0, pending = '', complete = false;
      let characters: number | undefined;
      const parse = (line: string) => {
        if (!line.trim()) return;
        if (complete) throw invalidResponse();
        const frame: unknown = JSON.parse(line);
        if (!isRecord(frame) || !Number.isSafeInteger(frame.code)) throw invalidResponse();
        if (frame.code !== 0 && frame.code !== COMPLETE_CODE) {
          // The same service code can mean entitlement or concurrency failure. Do not guess
          // from, log, or expose the provider's free-form message (it may echo private input).
          throw new HttpError(502, 'doubao_tts_service', '豆包语音未完成合成。请在官方控制台检查服务、音色权限和试用额度；本次未自动重试。');
        }
        if (frame.usage !== undefined) {
          if (!isRecord(frame.usage) || !Number.isSafeInteger(frame.usage.text_words) || (frame.usage.text_words as number) < 0) throw invalidResponse();
          characters = frame.usage.text_words as number;
        }
        if (frame.data !== undefined && frame.data !== null && frame.data !== '') {
          if (typeof frame.data !== 'string' || frame.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) throw invalidResponse();
          const chunk = Buffer.from(frame.data, 'base64');
          if (chunk.toString('base64') !== frame.data) throw invalidResponse();
          audioBytes += chunk.length;
          if (audioBytes + 44 > MAX_RESPONSE_BYTES) throw invalidResponse();
          chunks.push(chunk);
        }
        if (frame.code === COMPLETE_CODE) complete = true;
      };
      for (;;) {
        const result = await abortable(reader.read(), controller.signal);
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw invalidResponse();
        pending += decoder.decode(result.value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
          parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
        }
        if (complete) {
          if (pending.trim()) throw invalidResponse();
          // The explicit terminal code ends this synthesis, even on keep-alive HTTP.
          break;
        }
      }
      pending += decoder.decode();
      if (pending.trim()) parse(pending);
      if (!complete) throw invalidResponse();
      if (controller.signal.aborted) throw controller.signal.reason;
      const audio = wave(Buffer.concat(chunks, audioBytes));
      return characters === undefined ? { audio } : { audio, characters };
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof HttpError) throw error;
      throw invalidResponse();
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort); this.active.delete(controller);
      // Cancel any unread chunks without waiting indefinitely on a misbehaving transport.
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      else if (body) void body.cancel().catch(() => {});
      controller.abort();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.active) controller.abort(cancelled());
  }
}

