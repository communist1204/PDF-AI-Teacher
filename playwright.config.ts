import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 45000, fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4317', channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm.cmd run dev', url: 'http://127.0.0.1:4317/api/config', reuseExistingServer: false, timeout: 60000, env: { DEMO_MODE: 'true', APP_PORT: '4317' } },
  reporter: [['list'], ['html', { open: 'never' }]]
});
