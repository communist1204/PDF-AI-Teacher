/** Official Doubao 2.0 preset speakers; not a quality ranking. */
export const DOUBAO_TTS_VOICES = [
 { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 · 中文女声' },
 { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi · 中文女声' },
 { id: 'zh_male_taocheng_uranus_bigtts', name: '陶诚 · 中文男声' },
] as const;
export const DEFAULT_DOUBAO_TTS_VOICE = DOUBAO_TTS_VOICES[0].id;
export const DEFAULT_DOUBAO_TTS_INSTRUCTIONS = '用同一位朗读者稳定自然的音色朗读教材，按语义停顿，不扮演不同角色，不增添或改动原文。';
