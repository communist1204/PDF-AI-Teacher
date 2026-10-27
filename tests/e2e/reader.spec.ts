import { expect, test, type Page } from '@playwright/test';

async function mockDesktop(page: Page, options = { hasKey: true, delayedOcr: false }) {
  await page.addInitScript(({ hasKey, delayedOcr }) => {
    const calls = { speak: 0, cancelled: 0, saves: 0, playing: false };
    const preferences = { provider: 'doubao' as 'doubao' | 'bing', allowBingCloud: false, voice: 'zh_female_xiaohe_uranus_bigtts', instructions: '温和自然地读。', rate: 1, alwaysOnTop: true, allowCloud: true, skipFormulas: true };
    const settings = { preferences, hasApiKey: hasKey, encryptionAvailable: true, migrated: false, shortcutAvailable: true };
    // Structurally valid silent WAV. Playback is mocked; malformed bytes would trigger a real decode error.
    const wave = new Uint8Array(48044), header = new DataView(wave.buffer);
    const tag = (offset: number, text: string) => [...text].forEach((value, i) => wave[offset + i] = value.charCodeAt(0));
    tag(0, 'RIFF'); header.setUint32(4, wave.length - 8, true); tag(8, 'WAVEfmt ');
    header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
    header.setUint32(24, 24000, true); header.setUint32(28, 48000, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true);
    tag(36, 'data'); header.setUint32(40, wave.length - 44, true);
    Object.assign(window, { readerTest: { calls, settings } });
    HTMLMediaElement.prototype.play = function () { calls.playing = true; Object.assign(window, { readerTestAudio: this }); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () { calls.playing = false; };
    HTMLMediaElement.prototype.load = function () {};
    window.reader = {
      getSettings: async () => settings,
      saveSettings: async value => { calls.saves++; settings.preferences = value.preferences; if (value.apiKey) settings.hasApiKey = true; if (value.clearApiKey) settings.hasApiKey = false; return settings; },
      capture: async () => ({ id: 'capture-1', imageDataUrl: '', width: 100, height: 100 }),
      recognize: async id => {
        if (delayedOcr) await new Promise<void>(resolve => Object.assign(window, { finishTestOcr: resolve }));
        return { id, text: '2026年，我们开始阅读这\n一段文字。\nx=2\n下一句仍然是普通正文。', language: 'zh-Hans', elapsedMs: 12 };
      },
      beginSpeech: async () => {},
      speak: async request => { calls.speak++; return { ...request, audio: wave }; },
      cancel: async () => { calls.cancelled++; }, setPanel: async () => {}, minimize: async () => {}, quit: async () => {}, openHelp: async () => {}, onCaptureRequested: () => () => {},
    };
  }, options);
}

test('browser preview does not fabricate capture or a voice connection', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '截图朗读', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('界面预览');
  await page.getByRole('button', { name: '声音设置', exact: true }).click();
  await expect(page.getByLabel('朗读音色')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存设置' })).toBeDisabled();
});

test('capture reads cleaned prose, pauses, changes speed in place, and can stop', async ({ page }) => {
  await mockDesktop(page); await page.goto('/');
  await page.getByRole('button', { name: '截图朗读', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('正在朗读');
  const calls = await page.evaluate(() => (window as unknown as { readerTest: { calls: { speak: number } } }).readerTest.calls.speak);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已暂停');
  await page.getByLabel('朗读速度').selectOption('2.5');
  await expect.poll(() => page.evaluate(() => (window as unknown as { readerTestAudio: HTMLAudioElement }).readerTestAudio.playbackRate)).toBe(2.5);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('正在朗读');
  expect(await page.evaluate(() => (window as unknown as { readerTest: { calls: { speak: number } } }).readerTest.calls.speak)).toBe(calls);
  await page.getByRole('button', { name: '查看识别文字' }).click();
  await page.getByText('实际朗读内容', { exact: true }).click();
  await expect(page.locator('.speech-preview p')).toContainText('二零二六年');
  await expect(page.locator('.speech-preview p')).not.toContainText('x=2');
  await page.getByRole('button', { name: '停止朗读' }).click();
  await expect(page.getByRole('status')).toContainText('已停止');
});

test('voice settings retain latest toolbar rate; revoking cloud permission stops local sound', async ({ page }) => {
  await mockDesktop(page); await page.goto('/');
  await page.getByRole('button', { name: '截图朗读', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('正在朗读');
  await page.getByRole('button', { name: '声音设置', exact: true }).click();
  await page.getByLabel('朗读速度').selectOption('3');
  await page.getByLabel('朗读音色').selectOption('zh_male_taocheng_uranus_bigtts');
  await page.getByLabel('允许将我主动截图', { exact: false }).uncheck();
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('已保存。设置不会自动请求声音。')).toBeVisible();
  await expect(page.getByLabel('朗读速度')).toHaveValue('3');
  const result = await page.evaluate(() => (window as unknown as { readerTest: { calls: { playing: boolean }; settings: { preferences: { rate: number; allowCloud: boolean } } } }).readerTest);
  expect(result.calls.playing).toBe(false); expect(result.settings.preferences).toMatchObject({ rate: 3, allowCloud: false });
});

test('missing key still allows local OCR and never requests speech', async ({ page }) => {
  await mockDesktop(page, { hasKey: false, delayedOcr: false }); await page.goto('/');
  await page.getByRole('button', { name: '截图朗读', exact: true }).click();
  await expect(page.getByRole('heading', { name: '声音与设置' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { readerTest: { calls: { speak: number } } }).readerTest.calls.speak)).toBe(0);
  await page.getByRole('button', { name: '查看识别文字' }).click();
  await expect(page.getByLabel('识别文字', { exact: true })).toHaveValue(/2026年/);
});

test('stopping OCR prevents its late result from starting sound or replacing the preview', async ({ page }) => {
  await mockDesktop(page, { hasKey: true, delayedOcr: true }); await page.goto('/');
  await page.getByRole('button', { name: '截图朗读', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('正在本机识别');
  await page.getByRole('button', { name: '停止朗读' }).click();
  await page.evaluate(() => (window as unknown as { finishTestOcr(): void }).finishTestOcr());
  await expect(page.getByRole('status')).toContainText('已停止');
  expect(await page.evaluate(() => (window as unknown as { readerTest: { calls: { speak: number } } }).readerTest.calls.speak)).toBe(0);
});

test('Bing has separate consent, needs no key and can audition without losing Doubao settings', async ({ page }) => {
  await mockDesktop(page, { hasKey: false, delayedOcr: false }); await page.goto('/');
  await page.getByRole('button', { name: '声音设置', exact: true }).click();
  await page.getByLabel('朗读来源').selectOption('bing');
  await expect(page.getByLabel('豆包语音 API Key')).toBeHidden();
  await expect(page.getByLabel('朗读音色')).toHaveValue('xiaoxiao');
  await page.getByRole('button', { name: '保存并试听这段声音' }).click();
  await expect(page.getByText('请先勾选当前声音的联网朗读许可；豆包还需要 API Key。')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { readerTest: { calls: { speak: number } } }).readerTest.calls.speak)).toBe(0);
  await page.getByLabel('允许将我主动截图', { exact: false }).check();
  await page.getByRole('button', { name: '保存并试听这段声音' }).click();
  await expect(page.getByRole('status').first()).toContainText('正在朗读');
  await page.getByLabel('朗读速度').selectOption('2');
  await expect.poll(() => page.evaluate(() => (window as unknown as { readerTestAudio: HTMLAudioElement }).readerTestAudio.playbackRate)).toBe(2);
  await page.getByLabel('允许将我主动截图', { exact: false }).uncheck();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeDisabled();
  await page.getByLabel('朗读来源').selectOption('doubao');
  await expect(page.getByLabel('朗读音色')).toHaveValue('zh_female_xiaohe_uranus_bigtts');
});

test('stopping while audition settings save is pending prevents late speech and locks competing changes', async ({ page }) => {
  await mockDesktop(page); await page.goto('/');
  await page.getByRole('button', { name: '声音设置', exact: true }).click();
  await page.getByLabel('朗读来源').selectOption('bing');
  await page.getByLabel('允许将我主动截图', { exact: false }).check();
  await page.evaluate(() => {
    const original = window.reader!.saveSettings;
    window.reader!.saveSettings = async value => {
      await new Promise<void>(resolve => Object.assign(window, { finishSettingsSave: resolve }));
      return original(value);
    };
  });
  await page.getByRole('button', { name: '保存并试听这段声音' }).click();
  await expect(page.getByLabel('朗读速度')).toBeDisabled();
  await expect(page.getByRole('button', { name: '截图朗读', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '停止朗读', exact: true }).click();
  await page.evaluate(() => (window as unknown as { finishSettingsSave(): void }).finishSettingsSave());
  await expect(page.getByText('已取消本次试听。设置仍已保存。')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { readerTest: { calls: { speak: number } } }).readerTest.calls.speak)).toBe(0);
  await expect(page.getByLabel('朗读速度')).toBeEnabled();
});

test('switching directly from Doubao to Bing can save and audition on the first click', async ({ page }) => {
  await mockDesktop(page); await page.goto('/');
  await page.getByRole('button', { name: '声音设置', exact: true }).click();
  await page.getByLabel('朗读来源').selectOption('bing');
  await page.getByLabel('允许将我主动截图', { exact: false }).check();
  await page.getByRole('button', { name: '保存并试听这段声音' }).click();
  await expect(page.getByRole('status').first()).toContainText('正在朗读');
  expect(await page.evaluate(() => (window as unknown as { readerTest: { settings: { preferences: { provider: string } }; calls: { speak: number } } }).readerTest)).toMatchObject({ settings: { preferences: { provider: 'bing' } }, calls: { speak: expect.any(Number) } });
  expect(await page.evaluate(() => (window as unknown as { readerTest: { calls: { speak: number } } }).readerTest.calls.speak)).toBeGreaterThan(0);
});
