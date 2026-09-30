import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { watch: { ignored: ['**/release/**', '**/desktop-build/**', '**/local-tts-runtime/**','**/qwen-tts-runtime/**', '**/.model-cache/**', '**/.worktrees/**', '**/test-results/**', '**/docs/audio/**'] } }, build: { outDir: 'dist' } });
