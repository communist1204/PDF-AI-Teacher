import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { readConfig } from './config';
import { LocalTtsProvider } from './localTts';

const config = readConfig();
const runtimePath = resolve(process.cwd(), 'local-tts-runtime');
const localTts = config.ttsEngine === 'local' ? new LocalTtsProvider({ workerPath: resolve(runtimePath, 'local-tts-worker.cjs'), runtimePath, modelDir: resolve(runtimePath, 'model'), voice: config.localTtsVoice ?? 'zf_001', threads: 2 }) : undefined;
const app = createApp({ config, localTts });
const server = createServer(app);
const root = fileURLToPath(new URL('../../../', import.meta.url));
let closeDevServer: (() => Promise<void>) | undefined;
if (process.argv.includes('--production')) {
  const dist = resolve(root, 'dist');
  app.use(express.static(dist, { dotfiles: 'deny' }));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
  closeDevServer = () => vite.close();
}
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用；请检查本项目是否已启动，或修改本项目 APP_PORT。` : '本地服务启动失败。请检查项目配置与权限。');
  process.exitCode = 1;
  void closeDevServer?.();
});
server.listen(config.port, config.host, () => {
  console.log(`PDF-AI-Teacher: http://${config.host}:${config.port}`);
  console.log(config.demoMode ? '演示模式：不调用模型 API；浏览器演示语音不代表真实 TTS 已验证。' : '真实接口模式：仅用户主动请求时调用已配置服务，可能产生 API 费用。');
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.locals.dispose();
  await closeDevServer?.();
  server.close();
  server.closeIdleConnections();
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
