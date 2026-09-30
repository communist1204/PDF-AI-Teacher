import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['node_modules/**', 'desktop-build/**', 'release/**', '.electron-cache/**', '.desktop-data/**', 'dist/**', '.worktrees/**', '.npm-cache/**', 'test-results/**', 'playwright-report/**', 'public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { window: 'readonly', MutationObserver: 'readonly', setTimeout: 'readonly', speechSynthesis: 'readonly', fetch: 'readonly', document: 'readonly', console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly' } }, rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } }
);
