import { BrowserWindow, desktopCapturer, ipcMain, screen, type IpcMainInvokeEvent, type NativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capturePixelRect, type ScreenCapture, type ScreenRecognition } from '../../packages/shared/screenReading';
import { recognizeWindowsImage } from './windowsOcr';

/** Explicit one-shot screen selection. Full displays never reach the application renderer or disk. */
export class ScreenCaptureService {
  private overlays = new Map<number, { window: BrowserWindow; image: NativeImage }>();
  private selection: { id: string; png: Buffer } | null = null;
  private recognition: AbortController | null = null;
  private finish: ((result: ScreenCapture | null) => void) | null = null;
  private epoch = 0;
  private active = false;
  private disposed = false;
  constructor(private readonly parent: () => BrowserWindow | null, private readonly directory: string) {
    ipcMain.handle('screen-crop:image', event => this.overlay(event).image.toDataURL());
    ipcMain.handle('screen-crop:cancel', event => { this.overlay(event); this.cancel(); });
    ipcMain.handle('screen-crop:select', (event, value: unknown) => {
      const source = this.overlay(event);
      const rect = capturePixelRect(value, source.image.getSize());
      let crop = source.image.crop(rect);
      // Windows OCR caps dimensions at 10000. Bound memory without inflating small text.
      if (Math.max(rect.width, rect.height) > 8000) crop = crop.resize(rect.width >= rect.height ? { width: 8000 } : { height: 8000 });
      const png = crop.toPNG();
      if (png.length > 16 * 1024 * 1024) throw Error('截图过大，请分成较小区域。');
      const id = randomUUID(); this.selection = { id, png };
      this.finish?.({ id, imageDataUrl: crop.toDataURL(), ...crop.getSize() });
    });
  }
  private overlay(event: IpcMainInvokeEvent) {
    const source = this.overlays.get(event.sender.id);
    if (!source || this.disposed || event.senderFrame !== source.window.webContents.mainFrame
      || event.senderFrame.url !== pathToFileURL(join(this.directory, 'capture.html')).href) throw Error('拒绝非截图窗口操作。');
    return source;
  }
  async capture(): Promise<ScreenCapture | null> {
    if (this.disposed) throw Error('截图服务已关闭。');
    if (this.active) throw Error('已有截图正在进行，请先完成或按 Esc 取消。');
    this.cancel(); this.active = true;
    const epoch = ++this.epoch, parent = this.parent();
    parent?.hide();
    try {
      await new Promise(resolve => setTimeout(resolve, 180));
      if (epoch !== this.epoch) return null;
      const displays = screen.getAllDisplays();
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
        width: Math.min(8192, Math.max(...displays.map(d => Math.round(d.size.width * d.scaleFactor)))),
        height: Math.min(8192, Math.max(...displays.map(d => Math.round(d.size.height * d.scaleFactor)))),
      } });
      if (epoch !== this.epoch) return null;
      return await new Promise<ScreenCapture | null>((resolve, reject) => {
        const timer = setTimeout(() => this.cancel(), 120000);
        this.finish = value => {
          clearTimeout(timer); this.finish = null;
          const windows = [...this.overlays.values()]; this.overlays.clear();
          for (const item of windows) if (!item.window.isDestroyed()) item.window.destroy();
          resolve(value);
        };
        const initialize = async () => {
          for (const display of displays) {
            const source = sources.find(item => item.display_id === String(display.id));
            if (!source || source.thumbnail.isEmpty()) continue;
            const window = new BrowserWindow({ ...display.bounds, frame: false, show: false, resizable: false, movable: false, hasShadow: false, skipTaskbar: true, alwaysOnTop: true, enableLargerThanScreen: true, backgroundColor: '#182f48', webPreferences: { preload: join(this.directory, 'capture-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'screen-crop', devTools: false } });
            window.setAlwaysOnTop(true, 'screen-saver');
            window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            window.webContents.on('will-navigate', event => event.preventDefault());
            window.webContents.on('will-attach-webview', event => event.preventDefault());
            window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
            const contentsId = window.webContents.id;
            this.overlays.set(contentsId, { window, image: source.thumbnail });
            window.on('closed', () => { if (this.overlays.has(contentsId)) this.cancel(); });
            await window.loadFile(join(this.directory, 'capture.html'));
            if (epoch !== this.epoch || window.isDestroyed()) return;
          }
          if (!this.overlays.size) throw Error('无法截取当前屏幕，请确认桌面未锁定后重试。');
          const pointerDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
          for (const item of this.overlays.values()) item.window.showInactive();
          const focus = [...this.overlays.values()].find(item => item.window.getBounds().x === pointerDisplay.bounds.x && item.window.getBounds().y === pointerDisplay.bounds.y) ?? this.overlays.values().next().value;
          focus?.window.focus();
        };
        void initialize().catch(() => { reject(Error('屏幕截图未能启动，请重新尝试。')); this.cancel(); });
      });
    } finally {
      this.active = false;
      if (!this.disposed && parent && !parent.isDestroyed()) { parent.show(); parent.focus(); }
    }
  }
  async recognize(id: unknown): Promise<ScreenRecognition> {
    if (typeof id !== 'string' || !this.selection || id !== this.selection.id) throw Error('截图已过期，请重新截图。');
    if (this.recognition) throw Error('文字正在识别，请稍等或取消。');
    const selection = this.selection; this.selection = null;
    const controller = new AbortController(); this.recognition = controller;
    const started = Date.now();
    try {
      const scriptDirectory = this.directory.endsWith('.asar') ? this.directory + '.unpacked' : this.directory;
      const result = await recognizeWindowsImage(selection.png, join(scriptDirectory, 'windows-ocr.ps1'), controller.signal);
      controller.signal.throwIfAborted();
      return { id, ...result, elapsedMs: Date.now() - started };
    } finally { if (this.recognition === controller) this.recognition = null; }
  }
  cancel(): void {
    this.epoch++; this.selection = null; this.recognition?.abort(); this.recognition = null; this.finish?.(null);
  }
  dispose(): void {
    this.disposed = true; this.cancel();
    for (const channel of ['screen-crop:image', 'screen-crop:select', 'screen-crop:cancel']) ipcMain.removeHandler(channel);
  }
}
