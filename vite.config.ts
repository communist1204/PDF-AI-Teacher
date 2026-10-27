import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => ({ base: './', plugins: [react(), {
  name: 'development-refresh-policy',
  transformIndexHtml(html) { return command === 'serve' ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : html; },
}], server: { watch: { ignored: ['**/release/**', '**/desktop-build/**', '**/.worktrees/**', '**/test-results/**'] } }, build: { outDir: 'dist' } }));
