import { expect, test, type Page } from '@playwright/test';
import type { DesktopSettings } from '../../packages/shared/desktop';

type DesktopHarness = { calls: Array<{ method: string; value?: unknown }>; state: DesktopSettings; finishLogin: () => void; failLogin: (message: string) => void };
const initial: DesktopSettings = {
  mode: 'demo', chatModel: 'gpt-6-astra', visionModel: 'gpt-6-astra', reasoningEffort: 'xhigh',
  ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'marin', ttsInstructions: '温和自然，按句意停顿。',
  hasApiKey: false, encryptionAvailable: true, auth: { status: 'signed_out', accounts: [] }, models: [], restartRequired: false,
};
async function setup(page: Page, signedIn = false) {
  await page.addInitScript(({ seed, signedIn }) => {
    const state: DesktopSettings = structuredClone(seed);
    if (signedIn) {
      state.mode = 'chatgpt'; state.auth = { status: 'signed_in', email: 'reader@example.test', activeAccountId: 'account-one', accounts: [{ id: 'account-one', label: '账号一', status: 'signed_in' }, { id: 'account-two', label: '账号二', status: 'signed_in' }] };
      state.models = [{ id: 'gpt-6-astra', name: '接口模拟 Astra' }, { id: 'mock-theory-second', name: '接口模拟第二模型' }];
    }
    const harness: DesktopHarness = { calls: [], state, finishLogin: () => {}, failLogin: () => {} };
    Object.defineProperty(window, '__desktopHarness', { value: harness });
    let resolveLogin: ((value: DesktopSettings) => void) | undefined;
    const record = (method: string, value?: unknown) => harness.calls.push({ method, value });
    Object.defineProperty(window, 'desktopTeacher', { value: {
      getSettings: async () => structuredClone(state),
      login: async (accountId?: string) => {
        record('login', accountId);
        return new Promise<DesktopSettings>((resolve, reject) => {
          harness.failLogin = message => reject(new Error(message));
          resolveLogin = resolve;
          harness.finishLogin = () => {
            state.mode = 'chatgpt'; state.restartRequired = true;
            state.auth = { status: 'signed_in', email: 'reader@example.test', activeAccountId: 'account-one', accounts: [{ id: 'account-one', label: '账号一', status: 'signed_in' }] };
            state.models = [{ id: 'gpt-6-astra', name: '接口模拟 Astra' }, { id: 'mock-theory-second', name: '接口模拟第二模型' }];
            resolveLogin?.(structuredClone(state));
          };
        });
      },
      cancelLogin: async () => { record('cancelLogin'); resolveLogin?.(structuredClone(state)); resolveLogin = undefined; },
      selectAccount: async (accountId: string) => { record('selectAccount', accountId); state.auth.activeAccountId = accountId; state.restartRequired = true; return structuredClone(state); },
      logout: async () => { record('logout'); state.auth.status = 'signed_out'; state.mode = 'demo'; state.restartRequired = true; return structuredClone(state); },
      saveSettings: async (input: Record<string, unknown>) => {
        record('saveSettings', input);
        const { apiKey, clearApiKey, ...preferences } = input;
        Object.assign(state, preferences); if (apiKey) state.hasApiKey = true; if (clearApiKey) state.hasApiKey = false;
        state.restartRequired = true; return structuredClone(state);
      },
      restart: async () => { record('restart'); },
      openAccountPage: async (page: string) => { record('openAccountPage', page); },
      createShortcut: async () => { record('createShortcut'); return { path: 'mock-desktop-link.lnk' }; },
    } });
  }, { seed: initial, signedIn });
  await page.goto('/');
}
async function calls(page: Page) { return page.evaluate(() => (window as unknown as { __desktopHarness: DesktopHarness }).__desktopHarness.calls); }
async function finishLogin(page: Page) { await page.evaluate(() => (window as unknown as { __desktopHarness: DesktopHarness }).__desktopHarness.finishLogin()); }

test('桌面官方登录可取消，成功后仅显式应用才重启，并保存当前选定模型', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '登录 ChatGPT', exact: true }).click();
  const panel = page.getByRole('region', { name: '桌面账号与模型设置' });
  await expect(panel).toContainText('系统浏览器');
  await expect(page.getByRole('dialog')).not.toContainText('API Key 只在后端');
  await page.screenshot({path:'test-results/desktop-settings-login.png',fullPage:true});
  await page.getByRole('button', { name: '使用 ChatGPT 登录', exact: true }).click();
  await expect(panel).toContainText('正在连接官方登录服务');
  await page.getByRole('button', { name: '取消登录', exact: true }).click();
  await expect(panel).toContainText('已取消本次登录');
  expect((await calls(page)).filter(call => call.method === 'restart')).toHaveLength(0);
  await page.getByRole('button', { name: '使用 ChatGPT 登录', exact: true }).click(); await finishLogin(page);
  await expect(panel).toContainText('ChatGPT 已登录');
  await expect(panel).toContainText('reader@example.test');
  await expect(page.getByRole('button', { name: 'ChatGPT 账号设置 · 待应用' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '文字解题模型' }).locator('option')).toHaveText(['接口模拟 Astra · gpt-6-astra', '接口模拟第二模型 · mock-theory-second']);
  await page.getByRole('combobox', { name: '文字解题模型' }).selectOption('mock-theory-second');
  await page.setViewportSize({width:1280,height:720});
  await page.getByRole('button', { name: '应用并重启', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({path:'test-results/desktop-settings-720.png',fullPage:true});
  expect((await calls(page)).filter(call => call.method === 'restart')).toHaveLength(0);
  await page.getByRole('button', { name: '应用并重启', exact: true }).click();
  await expect.poll(async () => (await calls(page)).filter(call => call.method === 'restart').length).toBe(1);
  const history = await calls(page); expect(history.at(-2)).toMatchObject({ method: 'saveSettings', value: { chatModel: 'mock-theory-second' } }); expect(history.at(-1)?.method).toBe('restart');
});

test('自然朗读 API 凭证独立保存且不回显、不写入网页存储，不自动重启', async ({ page }) => {
  await setup(page, true); await page.getByRole('button', { name: 'ChatGPT 账号设置', exact: true }).click();
  await page.getByRole('combobox', { name: '朗读方式' }).selectOption('openai');
  await page.locator('.desktop-advanced summary').click();
  await expect(page.locator('.desktop-speech-fields')).toContainText('ChatGPT 登录不包含本应用的 TTS 授权');
  const key = page.getByRole('textbox', { name: 'OpenAI API Key' });
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill('mock-key-only-not-a-secret'); await page.getByRole('combobox', { name: '朗读音色' }).selectOption('cedar');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(key).toHaveValue(''); await expect(page.locator('.desktop-advanced')).toContainText('本机已保存 API Key；不会回显');
  expect((await calls(page)).find(call => call.method === 'saveSettings')).toMatchObject({ value: { mode: 'chatgpt', apiKey: 'mock-key-only-not-a-secret', ttsVoice: 'cedar' } });
  expect((await calls(page)).some(call => call.method === 'restart')).toBe(false);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })); expect(storage).not.toContain('mock-key-only-not-a-secret');
  await page.getByRole('button', { name: '打开官方 API Key 页面' }).click();
  expect((await calls(page)).at(-1)).toMatchObject({ method: 'openAccountPage', value: 'api-keys' });
  await page.getByRole('checkbox', { name: '删除本机保存的 API Key（保存后生效）' }).check(); await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('.desktop-advanced')).toContainText('尚未保存 API Key');
  expect((await calls(page)).filter(call => call.method === 'saveSettings').at(-1)).toMatchObject({ value: { clearApiKey: true } });
});

test('账号切换和退出保留显式应用步骤，支持创建软件快捷方式', async ({ page }) => {
  await setup(page, true); await page.getByRole('button', { name: 'ChatGPT 账号设置', exact: true }).click();
  await page.getByRole('combobox', { name: '本机 ChatGPT 账号' }).selectOption('account-two');
  await expect(page.locator('.desktop-settings')).toContainText('账号已切换');
  expect((await calls(page)).at(-1)).toMatchObject({ method: 'selectAccount', value: 'account-two' });
  await page.getByRole('button', { name: '创建桌面快捷方式' }).click(); await expect(page.locator('.desktop-settings')).toContainText('桌面快捷方式已创建');
  await page.getByRole('button', { name: '退出当前账号', exact: true }).click();
  await expect(page.locator('.desktop-settings')).toContainText('已退出当前账号');
  await expect(page.getByRole('combobox', { name: '使用方式', exact: true })).toHaveValue('demo');
  expect((await calls(page)).some(call => call.method === 'restart')).toBe(false);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.locator('.desktop-pending-banner')).toContainText('等待应用');
});


test('720p 登录连接失败直接显示在按钮旁，恢复可重试且不虚报浏览器已经打开', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await setup(page);
  await page.getByRole('button', { name: '登录 ChatGPT', exact: true }).click();
  const account = page.locator('.desktop-account-card');
  const login = account.getByRole('button', { name: '使用 ChatGPT 登录', exact: true });
  await login.click();
  const waiting = account.getByRole('status');
  await expect(waiting).toContainText('正在连接官方登录服务');
  await expect(waiting).toContainText('授权页面打开后');
  await expect(waiting).toBeInViewport({ ratio: 1 });
  await expect(account.getByRole('button', { name: '取消登录', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { __desktopHarness: DesktopHarness }).__desktopHarness.failLogin('登录服务暂不可用（HTTP 403）。请稍后重试。'));
  const failure = account.getByRole('alert');
  await expect(failure).toContainText('HTTP 403');
  await expect(failure).toBeInViewport({ ratio: 1 });
  await expect(login).toBeEnabled();
  await expect(account.getByRole('status')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/desktop-login-failure-720.png', fullPage: true });
  await login.click();
  await expect(failure).toHaveCount(0);
  await expect(waiting).toContainText('正在连接官方登录服务');
  await finishLogin(page);
  await expect(account.getByRole('status')).toContainText('账号已登录');
  await expect(account.getByRole('status')).toBeInViewport({ ratio: 1 });
  const history = await calls(page);
  expect(history.filter(call => call.method === 'login')).toHaveLength(2);
  expect(history.filter(call => call.method === 'restart')).toHaveLength(0);
});
