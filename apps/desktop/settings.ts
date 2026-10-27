import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_DOUBAO_TTS_INSTRUCTIONS, DEFAULT_DOUBAO_TTS_VOICE, DOUBAO_TTS_VOICES } from '../../packages/shared/doubaoSpeech';
import type { ReaderPreferences, ReaderSettings } from '../../packages/shared/reader';

export const PreferencesSchema = z.object({
  provider: z.enum(['doubao', 'bing']).default('doubao'),
  allowBingCloud: z.boolean().default(false),
  voice: z.string().refine(value => DOUBAO_TTS_VOICES.some(voice => voice.id === value)),
  instructions: z.string().trim().max(1000).refine(value => !value.includes('\0')),
  rate: z.number().finite().min(0.25).max(3),
  alwaysOnTop: z.boolean(), allowCloud: z.boolean(), skipFormulas: z.boolean(),
}).strict();
export const SaveSettingsSchema = z.object({
  preferences: PreferencesSchema,
  apiKey: z.string().trim().max(500).refine(value => value === '' || /^[\x21-\x7e]+$/.test(value)).optional(),
  clearApiKey: z.boolean().optional(),
}).strict();
const PositionSchema = z.object({ x: z.number().int().min(-100000).max(100000), y: z.number().int().min(-100000).max(100000) }).strict();
const PrivateSettingsSchema = z.object({
  version: z.literal(1), preferences: PreferencesSchema,
  apiKey: z.string().max(500), migrated: z.boolean(), position: PositionSchema.nullable(),
}).strict();
export const defaultPreferences: ReaderPreferences = {
  provider: 'doubao', allowBingCloud: false,
  voice: DEFAULT_DOUBAO_TTS_VOICE, instructions: DEFAULT_DOUBAO_TTS_INSTRUCTIONS,
  rate: 1, alwaysOnTop: true, allowCloud: false, skipFormulas: true,
};
export interface Cipher { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string }
type PrivateSettings = z.infer<typeof PrivateSettingsSchema>;

/** Credentials remain inside the desktop process and encrypted on disk. */
export class SettingsVault {
  private value: PrivateSettings = { version: 1, preferences: { ...defaultPreferences }, apiKey: '', migrated: false, position: null };
  private queue: Promise<void> = Promise.resolve();
  private damaged = false;
  constructor(private readonly path: string, private readonly cipher: Cipher) {}
  privateSettings(): PrivateSettings { return structuredClone(this.value); }
  publicSettings(shortcutAvailable: boolean): ReaderSettings {
    return { preferences: { ...this.value.preferences }, hasApiKey: Boolean(this.value.apiKey), encryptionAvailable: this.cipher.available(), migrated: this.value.migrated, shortcutAvailable };
  }
  async load(legacyPath?: string): Promise<void> {
    let bytes: Buffer;
    try { bytes = await readFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.damaged = true; throw Error('无法读取本机设置，原文件未被覆盖。', { cause: error }); }
      if (legacyPath && this.cipher.available()) await this.migrate(legacyPath);
      return;
    }
    try {
      if (!this.cipher.available()) throw Error('unavailable');
      this.value = PrivateSettingsSchema.parse(JSON.parse(this.cipher.decrypt(bytes)));
    } catch { this.damaged = true; throw Error('本机设置无法解密或已损坏，请使用原 Windows 账户打开。原文件未被覆盖。'); }
  }
  private async migrate(legacyPath: string): Promise<void> {
    // Migration deliberately ignores the previous account/auth/OpenAI fields.
    let legacy: unknown;
    try { legacy = JSON.parse(this.cipher.decrypt(await readFile(legacyPath))); } catch { return; }
    const parsed = z.object({
      doubaoApiKey: z.string().trim().max(500).regex(/^[\x21-\x7e]+$/),
      preferences: z.object({ doubaoTtsVoice: z.string().optional(), doubaoTtsInstructions: z.string().optional() }).optional(),
    }).safeParse(legacy);
    if (!parsed.success) return;
    const old = parsed.data.preferences;
    const preferences = { ...defaultPreferences };
    if (old && DOUBAO_TTS_VOICES.some(voice => voice.id === old.doubaoTtsVoice)) preferences.voice = old.doubaoTtsVoice!;
    if (old?.doubaoTtsInstructions && old.doubaoTtsInstructions.length <= 1000 && !old.doubaoTtsInstructions.includes('\0')) preferences.instructions = old.doubaoTtsInstructions;
    await this.update(current => ({ ...current, preferences, apiKey: parsed.data.doubaoApiKey, migrated: true }));
  }
  private update(change: (value: PrivateSettings) => PrivateSettings): Promise<void> {
    const operation = this.queue.then(async () => {
      if (this.damaged) throw Error('设置文件损坏，已阻止覆盖。');
      if (!this.cipher.available()) throw Error('Windows 凭证加密不可用，未保存任何明文凭证。');
      const next = PrivateSettingsSchema.parse(change(structuredClone(this.value)));
      const encrypted = this.cipher.encrypt(JSON.stringify(next));
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, encrypted, { mode: 0o600 });
      await rename(temporary, this.path);
      this.value = next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async save(input: unknown): Promise<void> {
    const parsed = SaveSettingsSchema.safeParse(input);
    if (!parsed.success) throw Error('设置内容无效，请检查音色、语速和 API Key。');
    const { preferences, apiKey, clearApiKey } = parsed.data;
    await this.update(current => ({ ...current, preferences, apiKey: clearApiKey ? '' : apiKey || current.apiKey }));
  }
  savePosition(position: { x: number; y: number }): Promise<void> {
    const parsed = PositionSchema.safeParse(position);
    if (!parsed.success) return Promise.resolve();
    return this.update(current => ({ ...current, position: parsed.data }));
  }
  async flush(): Promise<void> { let pending; do { pending = this.queue; await pending; } while (pending !== this.queue); }
}
