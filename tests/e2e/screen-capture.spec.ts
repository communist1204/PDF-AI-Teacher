import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page, delayed = false) {
  await page.addInitScript(({ delayed }) => {
    const state = { captures: 0, recognizes: 0, cancels: 0, delayed, resolve: null as null | ((value: unknown) => void), fail: false };
    Object.defineProperty(window, '__screenProbe', { value: state });
    Object.defineProperty(window, 'desktopTeacher', { value: {
      getSettings: async () => ({ mode: 'demo', ttsEngine: 'none', chatModel: 'test-text', visionModel: 'test-vision', reasoningEffort: '', ttsModel: '', ttsVoice: '', ttsInstructions: '', hasApiKey: false, encryptionAvailable: true, restartRequired: false, models: [], auth: { status: 'signed_out', accounts: [] } }),
      cancelLogin: async () => {},
      screenReading: {
        capture: async () => { state.captures++; return { id: 'capture-' + state.captures, width: 1, height: 1, imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=' }; },
        recognize: async (id: string) => { state.recognizes++; if (state.fail) throw Error('本机识别测试失败'); if (state.delayed) return new Promise(resolve => { state.resolve = resolve; }); return { id, text: '截图独有的文字，不写入阅读记录。2026年继续学习。', language: 'zh-Hans-CN', elapsedMs: 280 }; },
        cancel: async () => { state.cancels++; },
      },
    } });
  }, { delayed });
  const outgoing: string[] = [];
  await page.route(/\/api\/(tts|ask|reading-assist)$/, route => { outgoing.push(route.request().url()); return route.abort(); });
  await page.goto('/');
  return outgoing;
}

test('桌面不打开PDF也能截图识字，StrictMode不重复截图且没有云请求', async ({ page }) => {
  const outgoing = await setup(page);
  await page.getByRole('button', { name: '截图识字', exact: true }).click();
  const text = page.getByRole('textbox', { name: '截图识别文字' });
  await expect(text).toHaveValue('截图独有的文字，不写入阅读记录。2026年继续学习。');
  expect(await page.evaluate(() => (window as unknown as { __screenProbe: { captures: number } }).__screenProbe.captures)).toBe(1);
  await text.fill('核对后的文字'); await expect(text).toHaveValue('核对后的文字');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('截图独有');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: '重新截图', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '重新截图', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/screen-capture-panel-720.png', fullPage: true });
  await page.getByRole('button', { name: '关闭截图识字', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '屏幕截图识字' })).toHaveCount(0); expect(outgoing).toEqual([]);
});

test('取消识别或关闭窗口后迟到文字不覆盖新截图', async ({ page }) => {
  const outgoing = await setup(page, true);
  await page.getByRole('button', { name: '截图识字', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '正在本机识别文字' })).toBeVisible();
  await page.getByRole('button', { name: '取消识别', exact: true }).click();
  await page.evaluate(() => { const probe = (window as unknown as { __screenProbe: { resolve: (value: unknown) => void; delayed: boolean } }).__screenProbe; probe.resolve({ id: 'capture-1', text: '迟到的旧文字', language: 'zh', elapsedMs: 1 }); probe.delayed = false; });
  await expect(page.getByRole('textbox', { name: '截图识别文字' })).toHaveValue('');
  await page.getByRole('button', { name: '重新截图', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '截图识别文字' })).toHaveValue(/截图独有/);
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: '屏幕截图识字' })).toHaveCount(0); expect(outgoing).toEqual([]);
});

test('OCR失败显示错误，可重截而不调用模型补猜', async ({ page }) => {
  const outgoing = await setup(page);
  await page.evaluate(() => { (window as unknown as { __screenProbe: { fail: boolean } }).__screenProbe.fail = true; });
  await page.getByRole('button', { name: '截图识字', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('本机识别测试失败');
  await page.evaluate(() => { (window as unknown as { __screenProbe: { fail: boolean } }).__screenProbe.fail = false; });
  await page.getByRole('button', { name: '重新截图', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '截图识别文字' })).toHaveValue(/截图独有/); expect(outgoing).toEqual([]);
});

test('浏览器版不显示无法使用的全屏截图入口', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('button', { name: '声音设置', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '截图识字', exact: true })).toHaveCount(0);
});
