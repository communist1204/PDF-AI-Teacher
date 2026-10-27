import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsVault, defaultPreferences, type Cipher } from '../../apps/desktop/settings';

const directories: string[] = [];
// Test cipher is intentionally a mock, not evidence of Windows encryption.
const cipher: Cipher = { available: () => true, encrypt: text => Buffer.from(Buffer.from(text).map(byte => byte ^ 0x7b)), decrypt: bytes => Buffer.from(bytes.map(byte => byte ^ 0x7b)).toString() };
async function setup() { const directory = await mkdtemp(join(tmpdir(), 'reader-vault-')); directories.push(directory); const path = join(directory, 'private.bin'); return { directory, path, vault: new SettingsVault(path, cipher) }; }
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
describe('Reader settings vault (mock cipher)', () => {
  it('starts without consent or a key and never exposes credentials through public settings', async () => {
    const { vault, path } = await setup(); await vault.load();
    expect(vault.publicSettings(true)).toMatchObject({ hasApiKey: false, preferences: { allowCloud: false }, migrated: false });
    await vault.save({ preferences: { ...defaultPreferences, rate: 0.25 }, apiKey: 'test-private-key' });
    expect(JSON.stringify(vault.publicSettings(true))).not.toContain('test-private-key');
    expect((await readFile(path)).toString()).not.toContain('test-private-key');
    const reopened = new SettingsVault(path, cipher); await reopened.load();
    expect(reopened.privateSettings().apiKey).toBe('test-private-key');
    expect(reopened.publicSettings(false)).toMatchObject({ shortcutAvailable: false, preferences: { rate: 0.25 } });
  });
  it('preserves a saved key for empty input and clears only when explicitly requested', async () => {
    const { vault } = await setup(); await vault.save({ preferences: defaultPreferences, apiKey: 'test-secret' });
    await vault.save({ preferences: defaultPreferences, apiKey: '' }); expect(vault.publicSettings(true).hasApiKey).toBe(true);
    await vault.save({ preferences: defaultPreferences, clearApiKey: true }); expect(vault.publicSettings(true).hasApiKey).toBe(false);
  });
  it('serializes concurrent position and preference writes without losing either', async () => {
    const { vault } = await setup();
    await Promise.all([vault.save({ preferences: { ...defaultPreferences, rate: 3 }, apiKey: 'test-key' }), vault.savePosition({ x: -800, y: 20 })]);
    expect(vault.privateSettings()).toMatchObject({ preferences: { rate: 3 }, position: { x: -800, y: 20 }, apiKey: 'test-key' });
  });
  it('rejects malformed settings, unknown voices and invalid speed without persisting', async () => {
    const { vault } = await setup();
    for (const preferences of [{ ...defaultPreferences, rate: 4 }, { ...defaultPreferences, voice: 'untrusted' }, { ...defaultPreferences, instructions: '\0' }]) await expect(vault.save({ preferences, apiKey: 'test' })).rejects.toThrow('无效');
    await expect(vault.save({ preferences: defaultPreferences, apiKey: 'has\nnewline' })).rejects.toThrow('无效');
    expect(vault.publicSettings(true).hasApiKey).toBe(false);
  });
  it('refuses plaintext fallback when encryption is unavailable', async () => {
    const { path } = await setup(); const vault = new SettingsVault(path, { ...cipher, available: () => false });
    await expect(vault.save({ preferences: defaultPreferences, apiKey: 'test' })).rejects.toThrow('加密');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not overwrite a damaged vault after a failed load', async () => {
    const { vault, path } = await setup(); await writeFile(path, 'broken');
    await expect(vault.load()).rejects.toThrow('损坏');
    await expect(vault.save({ preferences: defaultPreferences })).rejects.toThrow('覆盖');
    await expect(vault.savePosition({ x: 1, y: 2 })).rejects.toThrow('覆盖');
    expect(await readFile(path, 'utf8')).toBe('broken');
  });
  it('migrates only Doubao fields, resets consent and leaves the old vault unchanged', async () => {
    const { vault, directory } = await setup(); const legacy = join(directory, 'old.bin');
    const old = cipher.encrypt(JSON.stringify({ doubaoApiKey: 'test-doubao-key', apiKey: 'never-migrate-openai-key', auth: { token: 'never-migrate-auth' }, preferences: { doubaoTtsVoice: 'zh_male_taocheng_uranus_bigtts', doubaoTtsInstructions: '自然地念。', allowCloud: true } }));
    await writeFile(legacy, old); await vault.load(legacy);
    expect(vault.privateSettings()).toMatchObject({ migrated: true, apiKey: 'test-doubao-key', preferences: { voice: 'zh_male_taocheng_uranus_bigtts', instructions: '自然地念。', allowCloud: false } });
    expect(JSON.stringify(vault.privateSettings())).not.toMatch(/never-migrate/);
    expect(await readFile(legacy)).toEqual(old);
  });
  it('ignores invalid legacy files and never imports unknown voice IDs', async () => {
    const { vault, directory } = await setup(); const legacy = join(directory, 'old.bin');
    await writeFile(legacy, cipher.encrypt(JSON.stringify({ doubaoApiKey: 'test', preferences: { doubaoTtsVoice: 'unknown' } })));
    await vault.load(legacy); expect(vault.privateSettings().preferences.voice).toBe(defaultPreferences.voice);
    const other = new SettingsVault(join(directory, 'new.bin'), cipher); await writeFile(legacy, 'broken'); await other.load(legacy); expect(other.publicSettings(true).hasApiKey).toBe(false);
  });
});

it('reads the previous preference format without granting permission to a new recipient', async () => {
  const { vault, path } = await setup();
  const old = { ...defaultPreferences, allowCloud: true } as Partial<typeof defaultPreferences>;
  delete old.provider; delete old.allowBingCloud;
  await writeFile(path, cipher.encrypt(JSON.stringify({ version: 1, preferences: old, apiKey: 'retained-doubao-key', migrated: false, position: null })));
  await vault.load();
  expect(vault.privateSettings()).toMatchObject({ apiKey: 'retained-doubao-key', preferences: { provider: 'doubao', allowCloud: true, allowBingCloud: false } });
  await vault.save({ preferences: { ...defaultPreferences, provider: 'bing', allowBingCloud: true } });
  expect(vault.privateSettings().apiKey).toBe('retained-doubao-key');
});

it('stores vision keys separately and old settings never grant image permission', async () => {
  const { vault, path } = await setup();
  const old = { ...defaultPreferences } as Partial<typeof defaultPreferences>;
  delete old.recognitionMode; delete old.allowVisionCloud;
  await writeFile(path, cipher.encrypt(JSON.stringify({ version: 1, preferences: old, apiKey: 'old-speech-only', migrated: false, position: null })));
  await vault.load();
  expect(vault.publicSettings(true)).toMatchObject({ hasVisionKey: false, preferences: { recognitionMode: 'local', allowVisionCloud: false } });
  await vault.save({ preferences: { ...defaultPreferences, recognitionMode: 'smart', allowVisionCloud: true }, visionApiKey: 'mock-private-vision' });
  expect(vault.privateSettings()).toMatchObject({ apiKey: 'old-speech-only', visionApiKey: 'mock-private-vision' });
  expect(JSON.stringify(vault.publicSettings(true))).not.toContain('mock-private-vision');
  expect((await readFile(path)).toString()).not.toContain('mock-private-vision');
  const reopened = new SettingsVault(path, cipher); await reopened.load();
  expect(reopened.publicSettings(true).hasVisionKey).toBe(true);
  await reopened.save({ preferences: defaultPreferences, visionApiKey: '' });
  expect(reopened.publicSettings(true).hasVisionKey).toBe(true);
  await reopened.save({ preferences: defaultPreferences, clearVisionApiKey: true });
  expect(reopened.privateSettings()).toMatchObject({ apiKey: 'old-speech-only', visionApiKey: '' });
});
