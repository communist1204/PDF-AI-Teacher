/** Kokoro v1.1-zh speaker ids in the bundled sherpa-onnx model. */
export const LOCAL_TTS_VOICES: ReadonlyArray<{ name: string; id: string; sid: number }> = [
  { name: '中文女声 001', id: 'zf_001', sid: 3 },
  { name: '中文女声 002', id: 'zf_002', sid: 4 },
  { name: '中文女声 003', id: 'zf_003', sid: 5 },
  { name: '中文男声 010', id: 'zm_010', sid: 59 },
  { name: '中文男声 011', id: 'zm_011', sid: 60 },
  { name: '中文男声 012', id: 'zm_012', sid: 61 },
];
export const DEFAULT_LOCAL_TTS_VOICE = 'zf_001';
/** Built-in Chinese speakers available in the Qwen3 CustomVoice model. */
export const QWEN_TTS_VOICES: ReadonlyArray<{ name: string; id: string }> = [
  { name: 'Serena · 中文女声', id: 'serena' },
  { name: 'Vivian · 中文女声', id: 'vivian' },
  { name: 'Uncle Fu · 中文男声', id: 'uncle_fu' },
];
export const DEFAULT_QWEN_TTS_VOICE = 'serena';
export const DEFAULT_QWEN_TTS_INSTRUCTIONS = '用温和自然的中文陪读语气，按语义停顿，不增添或改动原文。';
export type SpeechEngine = 'local' | 'qwen' | 'openai' | 'system';
export function isLocalSpeechEngine(engine?: SpeechEngine): boolean {
  return engine === 'local' || engine === 'qwen';
}
