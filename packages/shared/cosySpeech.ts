/** Project-provided references only; no user voice cloning or arbitrary file paths. */
export const COSY_TTS_VOICE_IDS = ['cosy_default', 'cosy_female_1', 'cosy_female_2', 'cosy_male_1', 'cosy_male_2', 'cosy_male_3'] as const;
export type CosyVoiceId = typeof COSY_TTS_VOICE_IDS[number];
export const DEFAULT_COSY_TTS_VOICE: CosyVoiceId = 'cosy_default';
export const COSY_TTS_VOICES: ReadonlyArray<{ id: CosyVoiceId; label: string; description: string }> = [
  { id: 'cosy_default', label: '原示例音色', description: '保留原来的官方演示参考音色。' },
  { id: 'cosy_female_1', label: '中文女声 1', description: '中文女声参考音色，可试听后选择。' },
  { id: 'cosy_female_2', label: '中文女声 2', description: '另一套中文女声参考音色，可试听后选择。' },
  { id: 'cosy_male_1', label: '中文男声 1', description: '中文男声参考音色，可试听后选择。' },
  { id: 'cosy_male_2', label: '中文男声 2', description: '另一套中文男声参考音色，可试听后选择。' },
  { id: 'cosy_male_3', label: '中文男声 3', description: '另一套中文男声参考音色，可试听后选择。' },
];
export function isCosyVoice(value: unknown): value is CosyVoiceId {
  return typeof value === 'string' && (COSY_TTS_VOICE_IDS as readonly string[]).includes(value);
}
export const COSY_TTS_MODEL = 'Fun-CosyVoice3-0.5B-2512';
export type CosySpeechStatus = 'missing' | 'idle' | 'loading' | 'ready' | 'error' | 'stopped';
