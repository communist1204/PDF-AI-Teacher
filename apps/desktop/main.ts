import { app, BrowserWindow, dialog, globalShortcut, ipcMain, safeStorage, screen, session, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SettingsVault } from './settings';
import { ScreenCaptureService } from './screenCapture';
import { SpeechSession } from './speechSession';
import { createDesktopFetch, createBingFetch } from './network';
import { ChatGPTAccountService } from './chatgpt/accounts';
import { ReadingCache } from './readingCache';
import { recognizeWithChatGPT, recognizeWithOpenAI } from './providers/openaiVision';
import { BingTtsProvider } from './providers/bingTts';
import { speechConfigured } from '../../packages/shared/reader';

app.setName('QingRead');
app.setAppUserModelId('QingRead.Desktop');
// An explicit launch-time profile override makes local verification isolated from real credentials.
if (process.env.SCREEN_READER_DATA_DIR) app.setPath('userData', process.env.SCREEN_READER_DATA_DIR);
else app.setPath('userData', join(app.getPath('appData'), 'ScreenReader'));

let window: BrowserWindow | null = null;
let vault: SettingsVault;
let capture: ScreenCaptureService;
let speech: SpeechSession;
let chatgpt: ChatGPTAccountService;
const readingCache = new ReadingCache();
let shortcutAvailable = false;
let positionTimer: ReturnType<typeof setTimeout> | undefined;
let quitting = false;
const html = join(__dirname, 'dist/index.html');
const uiUrl = pathToFileURL(html).href;
function trusted(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiUrl) throw Error('拒绝来自非朗读窗口的操作。');
}
function handle(channel: string, action: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => { trusted(event); return action(...args); });
}
function resize(expanded: boolean): void {
  if (!window) return;
  const bounds = window.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(560, area.width), height = Math.min(expanded ? 686 : 174, area.height);
  window.setBounds({ width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) });
}
function requestCapture(): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send('reader:capture-requested');
}
async function start(): Promise<void> {
  vault = new SettingsVault(join(app.getPath('userData'), 'private-settings.bin'), {
    available: () => safeStorage.isEncryptionAvailable(), encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(bytes),
  });
  // Test profiles never inherit credentials from a real user's previous application.
  await vault.load(process.env.SCREEN_READER_DATA_DIR ? undefined : join(app.getPath('appData'), 'PDF-AI-Teacher', 'private-settings.bin'));
  const preferences = vault.privateSettings().preferences;
  const area = screen.getPrimaryDisplay().workArea, saved = vault.privateSettings().position;
  window = new BrowserWindow({ title: '截图朗读', width: 560, height: 174, x: saved?.x ?? area.x + Math.max(0, area.width - 590), y: saved?.y ?? area.y + 70, frame: false, resizable: false, maximizable: false, show: false, alwaysOnTop: preferences.alwaysOnTop, backgroundColor: '#f3f9ff', icon: join(__dirname, 'assets/qingread.ico'), webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged, partition: 'persist:reader-ui' } });
  resize(false);
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  // Only the main process can perform network calls; the renderer has no network capability.
  contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'data:', 'blob:'].some(protocol => details.url.startsWith(protocol)) }));
  const network = session.fromPartition('reader-network');
  network.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const bingNetwork = session.fromPartition('reader-bing-network');
  bingNetwork.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  speech = new SpeechSession(undefined, createDesktopFetch(network), () => new BingTtsProvider({ fetchImpl: createBingFetch(bingNetwork) }));
  capture = new ScreenCaptureService(() => window, __dirname);
  chatgpt = new ChatGPTAccountService({
    path: join(app.getPath('userData'), 'chatgpt-account.bin'),
    cipher: { available: () => safeStorage.isEncryptionAvailable(), encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(bytes) },
    fetchImpl: createDesktopFetch(network), openExternal: url => shell.openExternal(url),
  });
  try { await chatgpt.load(); } catch { /* Keep local OCR and saved speech usable; the auth vault refuses writes. */ }
  const changingAccount = () => { capture.cancel(); speech.cancel(); readingCache.clear(); };
  handle('reader:chatgpt-state', () => chatgpt.getState());
  handle('reader:chatgpt-login', id => {
    if (id !== undefined && (typeof id !== 'string' || id.length > 200)) throw Error('账号选择无效。');
    changingAccount(); return chatgpt.beginLogin(id as string | undefined);
  });
  handle('reader:chatgpt-cancel-login', () => chatgpt.cancelLogin());
  handle('reader:chatgpt-select', id => {
    if (typeof id !== 'string' || id.length > 200) throw Error('账号选择无效。');
    changingAccount(); return chatgpt.selectProfile(id);
  });
  handle('reader:chatgpt-logout', () => { changingAccount(); return chatgpt.signOut(); });
  handle('reader:chatgpt-models', () => chatgpt.refreshModels());
  handle('reader:settings', () => vault.publicSettings(shortcutAvailable));
  handle('reader:save-settings', async value => {
    const previous = vault.privateSettings();
    const previousProvider = previous.preferences.provider;
    await vault.save(value);
    const current = vault.privateSettings();
    window?.setAlwaysOnTop(current.preferences.alwaysOnTop);
    if (previous.preferences.recognitionMode !== current.preferences.recognitionMode || previous.preferences.chatgptModel !== current.preferences.chatgptModel || previous.preferences.skipFormulas !== current.preferences.skipFormulas || (previous.preferences.allowVisionCloud && !current.preferences.allowVisionCloud) || previous.visionApiKey !== current.visionApiKey) { capture.cancel(); readingCache.clear(); }
    if (previousProvider !== current.preferences.provider || !speechConfigured(current.preferences, Boolean(current.apiKey))) speech.cancel();
    return vault.publicSettings(shortcutAvailable);
  });
  handle('reader:capture', () => { speech.cancel(); return capture.capture(); });
  handle('reader:recognize', id => {
    const settings = vault.privateSettings();
    if (settings.preferences.recognitionMode === 'local') return capture.recognize(id);
    if (settings.preferences.recognitionMode === 'chatgpt') {
      if (!settings.preferences.allowVisionCloud) throw Error('请在设置中允许把主动框选的图片交给 ChatGPT 整理。');
      return capture.recognize(id, async (png, signal) => {
        const { accessToken, model } = await chatgpt.getAccess(settings.preferences.chatgptModel, signal);
        signal.throwIfAborted();
        const key = readingCache.key(png, chatgpt.getState().activeProfileId ?? '', model.id, settings.preferences.skipFormulas);
        const cached = readingCache.get(key); if (cached) return cached;
        const result = await recognizeWithChatGPT(png, { accessToken, model, allowed: true, skipFormulas: settings.preferences.skipFormulas, fetchImpl: createDesktopFetch(network) }, signal);
        readingCache.put(key, result, signal); return result;
      });
    }
    if (!settings.preferences.allowVisionCloud || !settings.visionApiKey) throw Error('智能看图尚未配置：请填写 OpenAI API Key，并单独允许发送框选图片。');
    return capture.recognize(id, (png, signal) => recognizeWithOpenAI(png, { apiKey: settings.visionApiKey, allowed: settings.preferences.allowVisionCloud, skipFormulas: settings.preferences.skipFormulas, fetchImpl: createDesktopFetch(network) }, signal));
  });
  handle('reader:begin-speech', id => { const settings = vault.privateSettings(); speech.begin(id, settings.preferences, settings.apiKey); });
  handle('reader:speak', request => speech.speak(request));
  handle('reader:cancel', () => { capture.cancel(); speech.cancel(); });
  handle('reader:panel', panel => { if (panel !== null && panel !== 'settings' && panel !== 'text') throw Error('无效窗口状态。'); resize(panel !== null); });
  handle('reader:minimize', () => window?.minimize());
  handle('reader:quit', () => app.quit());
  handle('reader:help', provider => {
    const selected = provider ?? vault.privateSettings().preferences.provider;
    if (selected !== 'bing' && selected !== 'doubao' && selected !== 'openai' && selected !== 'chatgpt-usage') throw Error('未知声音来源。');
    return shell.openExternal(selected === 'chatgpt-usage' ? 'https://chatgpt.com/settings/usage' : selected === 'openai' ? 'https://platform.openai.com/api-keys' : selected === 'bing' ? 'https://www.bing.com/translator' : 'https://console.volcengine.com/speech/service');
  });
  shortcutAvailable = globalShortcut.register('CommandOrControl+Shift+R', requestCapture);
  window.on('move', () => {
    clearTimeout(positionTimer);
    positionTimer = setTimeout(() => { if (window && !window.isDestroyed()) { const { x, y } = window.getBounds(); void vault.savePosition({ x, y }).catch(() => {}); } }, 400);
  });
  window.on('closed', () => { window = null; capture.dispose(); speech.cancel(); chatgpt.dispose(); readingCache.clear(); });
  await window.loadFile(html);
  window.show();
  void capture.warmup().catch(() => {});
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.show(); window?.focus(); });
  app.whenReady().then(start).catch(() => { dialog.showErrorBox('截图朗读无法启动', '无法读取本机设置或载入界面。请确认使用原 Windows 账户；原配置没有被覆盖。'); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true; event.preventDefault(); globalShortcut.unregisterAll(); clearTimeout(positionTimer); capture?.dispose(); speech?.cancel(); chatgpt?.dispose(); readingCache.clear();
    const bounds = window && !window.isDestroyed() ? window.getBounds() : null;
    void (async () => { try { if (bounds) await vault?.savePosition({ x: bounds.x, y: bounds.y }); await vault?.flush(); await chatgpt?.flush(); } catch { /* Never replace a damaged vault during shutdown. */ } finally { app.quit(); } })();
  });
}
