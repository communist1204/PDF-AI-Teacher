import { app, BrowserWindow, dialog, globalShortcut, ipcMain, safeStorage, screen, session, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SettingsVault } from './settings';
import { ScreenCaptureService } from './screenCapture';
import { SpeechSession } from './speechSession';
import { createDesktopFetch, createBingFetch } from './network';
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
  const width = Math.min(560, area.width), height = Math.min(expanded ? 650 : 138, area.height);
  window.setBounds({ width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) });
}
function requestCapture(): void {
  if (!window || window.isDestroyed()) return;
  window.restore(); window.show(); window.webContents.send('reader:capture-requested');
}
async function start(): Promise<void> {
  vault = new SettingsVault(join(app.getPath('userData'), 'private-settings.bin'), {
    available: () => safeStorage.isEncryptionAvailable(), encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(bytes),
  });
  // Test profiles never inherit credentials from a real user's previous application.
  await vault.load(process.env.SCREEN_READER_DATA_DIR ? undefined : join(app.getPath('appData'), 'PDF-AI-Teacher', 'private-settings.bin'));
  const preferences = vault.privateSettings().preferences;
  const area = screen.getPrimaryDisplay().workArea, saved = vault.privateSettings().position;
  window = new BrowserWindow({ title: '截图朗读', width: 560, height: 138, x: saved?.x ?? area.x + Math.max(0, area.width - 590), y: saved?.y ?? area.y + 70, frame: false, resizable: false, maximizable: false, show: false, alwaysOnTop: preferences.alwaysOnTop, backgroundColor: '#f3f9ff', icon: join(__dirname, 'assets/qingread.ico'), webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged, partition: 'persist:reader-ui' } });
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
  handle('reader:settings', () => vault.publicSettings(shortcutAvailable));
  handle('reader:save-settings', async value => {
    const previousProvider = vault.privateSettings().preferences.provider;
    await vault.save(value);
    const current = vault.privateSettings();
    window?.setAlwaysOnTop(current.preferences.alwaysOnTop);
    if (previousProvider !== current.preferences.provider || !speechConfigured(current.preferences, Boolean(current.apiKey))) speech.cancel();
    return vault.publicSettings(shortcutAvailable);
  });
  handle('reader:capture', () => { speech.cancel(); return capture.capture(); });
  handle('reader:recognize', id => capture.recognize(id));
  handle('reader:begin-speech', id => { const settings = vault.privateSettings(); speech.begin(id, settings.preferences, settings.apiKey); });
  handle('reader:speak', request => speech.speak(request));
  handle('reader:cancel', () => { capture.cancel(); speech.cancel(); });
  handle('reader:panel', panel => { if (panel !== null && panel !== 'settings' && panel !== 'text') throw Error('无效窗口状态。'); resize(panel !== null); });
  handle('reader:minimize', () => window?.minimize());
  handle('reader:quit', () => app.quit());
  handle('reader:help', provider => {
    const selected = provider ?? vault.privateSettings().preferences.provider;
    if (selected !== 'bing' && selected !== 'doubao') throw Error('未知声音来源。');
    return shell.openExternal(selected === 'bing' ? 'https://www.bing.com/translator' : 'https://console.volcengine.com/speech/service');
  });
  shortcutAvailable = globalShortcut.register('CommandOrControl+Shift+R', requestCapture);
  window.on('move', () => {
    clearTimeout(positionTimer);
    positionTimer = setTimeout(() => { if (window && !window.isDestroyed()) { const { x, y } = window.getBounds(); void vault.savePosition({ x, y }).catch(() => {}); } }, 400);
  });
  window.on('closed', () => { window = null; capture.dispose(); speech.cancel(); });
  await window.loadFile(html);
  window.show();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.show(); window?.focus(); });
  app.whenReady().then(start).catch(() => { dialog.showErrorBox('截图朗读无法启动', '无法读取本机设置或载入界面。请确认使用原 Windows 账户；原配置没有被覆盖。'); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true; event.preventDefault(); globalShortcut.unregisterAll(); clearTimeout(positionTimer); capture?.dispose(); speech?.cancel();
    const bounds = window && !window.isDestroyed() ? window.getBounds() : null;
    void (async () => { try { if (bounds) await vault?.savePosition({ x: bounds.x, y: bounds.y }); await vault?.flush(); } catch { /* Never replace a damaged vault during shutdown. */ } finally { app.quit(); } })();
  });
}
