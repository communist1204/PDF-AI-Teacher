import { test, expect } from '@playwright/test';
import { providerError } from '../../apps/server/src/errors';

// Only the provider failure is simulated. The PDF, selection, API client and audio controller are real.
for (const [code, hint] of [
  ['credit_balance_exhausted', 'API 可用余额不足'],
  ['unrecognized_limit', '尚不能确定是频率还是额度'],
]) {
  test(`朗读错误 ${code} 显示可操作提示并保留选区，不自动重试`, async ({ page }) => {
    let calls = 0;
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/config', async route => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({ response, json: { ...config, mode: 'live', models: { ...config.models, tts: 'MOCK_TTS_NOT_PAID' }, capabilities: { ...config.capabilities, tts: 'untested' }, speech: { engine: 'openai', ready: true, voice: 'marin', style: '仅模拟', instructionsSupported: true } } });
    });
    await page.route('**/api/tts', async route => {
      calls++;
      const mapped = providerError({ status: 429, code });
      await route.fulfill({ status: mapped.status, json: { error: mapped.code, message: mapped.message } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: /示例/ }).first().click();
    const text = page.locator('.textLayer span').filter({ hasText: '指数移动平均将过去' }).first();
    await expect(text).toBeVisible();
    const box = (await text.boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.selection-preview')).toContainText('指数移动平均');
    const selection = await page.locator('.selection-preview').textContent();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: '朗读所选', exact: true }).click();
    const banner = page.locator('.error-banner');
    await expect(banner).toContainText('朗读未能完成：');
    await expect(banner).toContainText(hint);
    await expect(banner).toContainText('查看 API 账单');
    await expect(page.locator('.selection-preview')).toHaveText(selection!);
    await expect(page.locator('.audio-source strong')).not.toContainText('正在朗读');
    const rect = (await banner.boundingBox())!;
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.y + rect.height).toBeLessThanOrEqual(720);
    await page.screenshot({ path: `docs/screenshots/tts-${code}-720.png`, fullPage: true });
    expect(calls).toBe(1);
    expect(pageErrors).toEqual([]);
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    await expect(banner).toHaveCount(0);
    expect(calls).toBe(1);
  });
}
