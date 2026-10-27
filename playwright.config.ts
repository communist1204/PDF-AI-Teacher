import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 45000, fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4320', channel: 'msedge', headless: true, viewport: { width: 560, height: 650 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm.cmd run preview', url: 'http://127.0.0.1:4320', reuseExistingServer: false, timeout: 60000 },
  reporter: [['list'], ['html', { open: 'never' }]]
});
