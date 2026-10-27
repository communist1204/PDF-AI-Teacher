import { z } from 'zod';
import type { ReaderPreferences, SpeechResult } from '../../packages/shared/reader';
import { DoubaoTtsProvider, type DoubaoTtsOptions } from './providers/doubaoTts';

const GenerationSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/);
const RequestSchema = z.object({ generationId: GenerationSchema, chunkId: z.number().int().min(0).max(511), text: z.string().trim().min(1).max(6000).refine(value => !value.includes('\0')) }).strict();
type VoiceProvider = Pick<DoubaoTtsProvider, 'speak' | 'dispose'>;
type Generation = { id: string; provider: VoiceProvider; controllers: Set<AbortController>; chunks: Set<number>; characters: number };

/** A generation freezes one voice. Late responses can never enter a new reading. */
export class SpeechSession {
  private current: Generation | null = null;
  constructor(private readonly createProvider: (options: DoubaoTtsOptions) => VoiceProvider = options => new DoubaoTtsProvider(options), private readonly fetchImpl?: typeof fetch) {}
  begin(generationId: unknown, preferences: ReaderPreferences, apiKey: string): void {
    this.cancel();
    const parsed = GenerationSchema.safeParse(generationId);
    if (!parsed.success) throw Error('朗读任务标识无效，请重新截图。');
    if (!preferences.allowCloud) throw Error('请在设置中允许把主动框选的文字发给豆包朗读。');
    if (!apiKey.trim()) throw Error('请先在设置中填写豆包语音 API Key。截图识字仍可在本机使用。');
    this.current = { id: parsed.data, provider: this.createProvider({ apiKey, voice: preferences.voice, instructions: preferences.instructions, fetchImpl: this.fetchImpl }), controllers: new Set(), chunks: new Set(), characters: 0 };
  }
  async speak(input: unknown): Promise<SpeechResult> {
    const parsed = RequestSchema.safeParse(input);
    if (!parsed.success) throw Error('朗读内容无效或过长，请缩小截图范围。');
    const request = parsed.data, current = this.current;
    if (!current || current.id !== request.generationId) throw Error('朗读已取消或过期。');
    if (current.controllers.size >= 2) throw Error('正在准备后续声音，请稍等。');
    if (current.chunks.has(request.chunkId)) throw Error('该段声音已经请求过，请重新开始朗读。');
    if (current.characters + request.text.length > 12000) throw Error('一次朗读最多 12000 字，请缩小截图范围。');
    current.chunks.add(request.chunkId); current.characters += request.text.length;
    const controller = new AbortController(); current.controllers.add(controller);
    try {
      const result = await current.provider.speak(request.text, 1, controller.signal, current.id);
      if (this.current !== current || controller.signal.aborted) throw Error('朗读已取消或过期。');
      return { generationId: current.id, chunkId: request.chunkId, audio: new Uint8Array(result.audio) };
    } finally { current.controllers.delete(controller); }
  }
  cancel(): void {
    const previous = this.current; this.current = null;
    if (!previous) return;
    for (const controller of previous.controllers) controller.abort();
    previous.provider.dispose();
  }
}
