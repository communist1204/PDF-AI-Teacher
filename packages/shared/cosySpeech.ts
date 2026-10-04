/** Project-provided references only; no user voice cloning or arbitrary file paths. */
export const COSY_TTS_VOICE_IDS = ['local_longanyang', 'local_longanhuan_v3', 'local_longfei_v3', 'local_longxiaochun_v3', 'local_longxiaoxia_v3', 'local_longanyun_v3'] as const;
export type CosyVoiceId = typeof COSY_TTS_VOICE_IDS[number];
export const DEFAULT_COSY_TTS_VOICE: CosyVoiceId = 'local_longanyang';
const LOCAL_REFERENCE_DESCRIPTION = '本机 CosyVoice 3 0.5B 根据官方公开样音近似生成，并非云端原版，音色与语气可能有差异。';
export const COSY_TTS_VOICES: ReadonlyArray<{ id: CosyVoiceId; label: string; description: string }> = [
  { id: 'local_longanyang', label: '龙安洋·本地参考', description: LOCAL_REFERENCE_DESCRIPTION },
  { id: 'local_longanhuan_v3', label: '龙安欢·本地参考', description: LOCAL_REFERENCE_DESCRIPTION },
  { id: 'local_longfei_v3', label: '龙飞·本地参考', description: LOCAL_REFERENCE_DESCRIPTION },
  { id: 'local_longxiaochun_v3', label: '龙小淳·本地参考', description: LOCAL_REFERENCE_DESCRIPTION },
  { id: 'local_longxiaoxia_v3', label: '龙小夏·本地参考', description: LOCAL_REFERENCE_DESCRIPTION },
  { id: 'local_longanyun_v3', label: '龙安昀·本地参考', description: LOCAL_REFERENCE_DESCRIPTION },
];
export function isCosyVoice(value: unknown): value is CosyVoiceId {
  return typeof value === 'string' && (COSY_TTS_VOICE_IDS as readonly string[]).includes(value);
}
export const COSY_TTS_MODEL = 'Fun-CosyVoice3-0.5B-2512';
export type CosySpeechStatus = 'missing' | 'idle' | 'loading' | 'ready' | 'error' | 'stopped';
