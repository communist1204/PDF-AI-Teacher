// Isolated packaged desktop configuration test. Dummy keys only; never starts TTS.
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const profile = resolve('test-results', `doubao-settings-profile-${Date.now()}`);
const env = { ...process.env, PDF_TEACHER_DATA_DIR: profile, PDF_TEACHER_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const keys = ['fake-doubao-first-not-a-credential', 'fake-doubao-replacement-not-a-credential'];
const errors = [], speechRequests = [];
let application;
async function openSettings() {
  application = await electron.launch({ executablePath: resolve('release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe'), env, timeout: 45000 });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/tts', route => { speechRequests.push(route.request().url()); return route.abort(); });
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: '声音设置', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '朗读方式', exact: true })).toBeVisible();
  return page;
}
async function close() { await application.close(); application = undefined; }
async function checkPrivateStorage(page) {
  const settings = await page.evaluate(() => window.desktopTeacher.getSettings());
  const browser = await page.evaluate(() => JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage }, text: document.body.innerText }));
  const encrypted = await readFile(resolve(profile, 'private-settings.bin'));
  for (const key of keys) {
    expect(JSON.stringify(settings)).not.toContain(key);
    expect(browser).not.toContain(key);
    expect(encrypted.includes(Buffer.from(key))).toBe(false);
  }
  return settings;
}
try {
  let page = await openSettings();
  const initial = await page.evaluate(() => window.desktopTeacher.getSettings());
  expect(initial.mode).toBe('demo'); expect(initial.ttsEngine).toBe('none'); expect(initial.encryptionAvailable).toBe(true);
  await page.getByRole('combobox', { name: '朗读方式', exact: true }).selectOption('doubao');
  await page.getByRole('combobox', { name: '豆包中文音色', exact: true }).selectOption('zh_male_taocheng_uranus_bigtts');
  await page.getByRole('textbox', { name: '豆包朗读语气', exact: true }).fill('温和自然，按语义停顿。');
  for (const key of keys) {
    const input = page.getByRole('textbox', { name: '豆包语音 API Key', exact: true });
    await input.fill(key); await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(input).toHaveValue(''); await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
    const saved = await checkPrivateStorage(page);
    expect(saved).toMatchObject({ hasDoubaoApiKey: true, hasApiKey: false, ttsEngine: 'doubao', mode: initial.mode, chatModel: initial.chatModel, visionModel: initial.visionModel, reasoningEffort: initial.reasoningEffort });
  }
  await close(); page = await openSettings();
  await expect(page.getByRole('combobox', { name: '朗读方式', exact: true })).toHaveValue('doubao');
  await expect(page.getByRole('combobox', { name: '豆包中文音色', exact: true })).toHaveValue('zh_male_taocheng_uranus_bigtts');
  await expect(page.getByRole('textbox', { name: '豆包朗读语气', exact: true })).toHaveValue('温和自然，按语义停顿。');
  await expect(page.getByRole('textbox', { name: '豆包语音 API Key', exact: true })).toHaveValue('');
  expect((await checkPrivateStorage(page)).hasDoubaoApiKey).toBe(true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720));
  await page.locator('.desktop-speech-fields legend').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/doubao-restored-desktop-720.png', fullPage: true });
  await page.getByRole('button', { name: '应用并重启', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/doubao-restored-actions-720.png', fullPage: true });
  await page.getByRole('combobox', { name: '朗读方式', exact: true }).selectOption('cosy');
  expect(await page.getByRole('combobox', { name: 'CosyVoice 中文音色', exact: true }).locator('option').count()).toBe(6);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  expect((await checkPrivateStorage(page)).hasDoubaoApiKey).toBe(true);
  await page.getByRole('combobox', { name: '朗读方式', exact: true }).selectOption('doubao');
  await page.getByRole('checkbox', { name: '删除本机保存的豆包 API Key（保存后生效）', exact: true }).check();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  expect((await checkPrivateStorage(page)).hasDoubaoApiKey).toBe(false);
  expect(speechRequests).toEqual([]); expect(errors).toEqual([]);
  const result = { date: new Date().toISOString(), kind: 'packaged-desktop-dummy-keys', encryptionAvailable: true, addAndReplaceKey: true, plaintextAbsentFromVaultPublicSettingsAndBrowserStorage: true, restartPreservesDoubaoVoiceAndInstruction: true, cosySixVoicesRetained: true, switchPreservesKey: true, explicitDelete: true, professionalPreferencesUnchanged: true, speechRequests: speechRequests.length, pageErrors: errors, realDoubaoApi: '未测；仅隔离配置与假 Key，不调用真实语音服务', userProfileAccessed: false };
  await writeFile('docs/doubao-settings-verification.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await application?.close(); }
