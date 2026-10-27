import { BrowserWindow, desktopCapturer, ipcMain, screen, type Display, type IpcMainInvokeEvent, type NativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capturePixelRect, type ScreenCapture, type ScreenRecognition } from '../../packages/shared/screenReading';
import { recognizeWindowsImage } from './windowsOcr';

type Overlay = { window: BrowserWindow; displayId: number; image: NativeImage | null; frameId: number; ready?: (ok: boolean) => void };

/** Warm only blank local windows. Screen pixels are acquired exclusively on explicit capture. */
export class ScreenCaptureService {
  private overlays = new Map<number, Overlay>();
  private warming: Promise<void> | null = null;
  private selection: { id: string; png: Buffer } | null = null;
  private recognition: AbortController | null = null;
  private finish: ((result: ScreenCapture | null) => void) | null = null;
  private epoch = 0;
  private active = false;
  private disposed = false;
  constructor(private readonly parent: () => BrowserWindow | null, private readonly directory: string) {
    ipcMain.handle('screen-crop:ready', (event, frameId: unknown) => {
      const source = this.overlay(event);
      if (source.frameId === frameId && frameId === this.epoch && source.image) source.ready?.(true);
    });
    ipcMain.handle('screen-crop:cancel', (event, frameId: unknown) => {
      const source = this.overlay(event);
      if (source.frameId === frameId && frameId === this.epoch) this.cancel();
    });
    ipcMain.handle('screen-crop:select', (event, frameId: unknown, value: unknown) => {
      const source = this.overlay(event);
      if (!this.active || !source.image || frameId !== this.epoch || source.frameId !== frameId) throw Error('截图已过期，请重新框选。');
      const rect = capturePixelRect(value, source.image.getSize());
      let crop = source.image.crop(rect);
      if (Math.max(rect.width, rect.height) > 8000) crop = crop.resize(rect.width >= rect.height ? { width: 8000 } : { height: 8000 });
      const png = crop.toPNG();
      if (png.length > 16 * 1024 * 1024) throw Error('截图过大，请分成较小区域。');
      const id = randomUUID(); this.selection = { id, png };
      this.finish?.({ id, imageDataUrl: 'data:image/png;base64,' + png.toString('base64'), ...crop.getSize() });
    });
  }
  private overlay(event: IpcMainInvokeEvent) {
    const source = this.overlays.get(event.sender.id);
    if (!source || this.disposed || event.senderFrame !== source.window.webContents.mainFrame
      || event.senderFrame.url !== pathToFileURL(join(this.directory, 'capture.html')).href) throw Error('拒绝非截图窗口操作。');
    return source;
  }
  warmup(displays = screen.getAllDisplays()): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.warming) return this.warming;
    const operation = this.prepareWindows(displays);
    this.warming = operation;
    void operation.finally(() => { if (this.warming === operation) this.warming = null; }).catch(() => {});
    return operation;
  }
  private async prepareWindows(displays: Display[]) {
    for (const [id, item] of this.overlays) {
      if (!displays.some(display => display.id === item.displayId) || item.window.isDestroyed()) {
        this.overlays.delete(id); item.ready?.(false);
        if (!item.window.isDestroyed()) item.window.destroy();
      }
    }
    const results = await Promise.allSettled(displays.map(async display => {
      const existing = [...this.overlays.values()].find(item => item.displayId === display.id);
      if (existing) { existing.window.setBounds(display.bounds); return; }
      const window = new BrowserWindow({ ...display.bounds, frame: false, show: false, resizable: false, movable: false, hasShadow: false, skipTaskbar: true, alwaysOnTop: true, enableLargerThanScreen: true, backgroundColor: '#f3f9ff', webPreferences: { preload: join(this.directory, 'capture-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'screen-crop', devTools: false, backgroundThrottling: false } });
      window.setAlwaysOnTop(true, 'screen-saver');
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'data:'].some(protocol => details.url.startsWith(protocol)) }));
      const contentsId = window.webContents.id;
      const item: Overlay = { window, displayId: display.id, image: null, frameId: 0 };
      this.overlays.set(contentsId, item);
      window.on('closed', () => {
        if (this.overlays.delete(contentsId)) { item.ready?.(false); if (this.active) this.cancel(); }
      });
      try { await window.loadFile(join(this.directory, 'capture.html')); }
      catch (error) { this.overlays.delete(contentsId); if (!window.isDestroyed()) window.destroy(); throw error; }
    }));
    if (results.some(result => result.status === 'rejected')) throw Error('截图窗口载入失败，请重新尝试。');
  }
  private releaseFrames() {
    for (const item of this.overlays.values()) {
      item.ready?.(false); item.ready = undefined; item.image = null; item.frameId = 0;
      if (!item.window.isDestroyed()) {
        item.window.hide();
        item.window.webContents.send('screen-crop:frame', null);
      }
    }
  }
  private prepareFrame(item: Overlay, frameId: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => item.ready?.(false), 5000);
      item.ready = ok => { clearTimeout(timer); item.ready = undefined; resolve(ok); };
      item.frameId = frameId;
      item.window.webContents.send('screen-crop:frame', { frameId, imageDataUrl: item.image!.toDataURL() });
    });
  }
  async capture(): Promise<ScreenCapture | null> {
    if (this.disposed) throw Error('截图服务已关闭。');
    if (this.active) throw Error('已有截图正在进行，请先完成或按 Esc 取消。');
    this.cancel(); this.active = true;
    const epoch = ++this.epoch, parent = this.parent();
    try {
      if (this.warming) await this.warming;
      if (epoch !== this.epoch) return null;
      const displays = screen.getAllDisplays();
      await this.warmup(displays);
      if (epoch !== this.epoch) return null;
      parent?.hide();
      // Give Windows a few compositor frames to remove only our toolbar.
      await new Promise(resolve => setTimeout(resolve, 60));
      if (epoch !== this.epoch) return null;
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
        width: Math.min(8192, Math.max(...displays.map(d => Math.round(d.size.width * d.scaleFactor)))),
        height: Math.min(8192, Math.max(...displays.map(d => Math.round(d.size.height * d.scaleFactor)))),
      } });
      if (epoch !== this.epoch) return null;
      const frames = [...this.overlays.values()].filter(item => {
        const source = sources.find(source => source.display_id === String(item.displayId));
        item.image = source && !source.thumbnail.isEmpty() ? source.thumbnail : null;
        return Boolean(item.image);
      });
      if (!frames.length) throw Error('无法截取当前屏幕，请确认桌面未锁定后重试。');
      const ready = await Promise.all(frames.map(item => this.prepareFrame(item, epoch)));
      if (epoch !== this.epoch) return null;
      if (ready.some(value => !value)) throw Error('屏幕图片准备超时，请重新尝试。');
      return await new Promise<ScreenCapture | null>(resolve => {
        const timer = setTimeout(() => this.cancel(), 120000);
        this.finish = value => { clearTimeout(timer); this.finish = null; this.releaseFrames(); resolve(value); };
        const pointerDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        for (const item of frames) item.window.showInactive();
        (frames.find(item => item.displayId === pointerDisplay.id) ?? frames[0]).window.focus();
      });
    } finally {
      this.releaseFrames(); this.active = false;
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
    this.epoch++; this.selection = null; this.recognition?.abort(); this.recognition = null;
    this.finish?.(null); this.releaseFrames();
  }
  dispose(): void {
    this.disposed = true; this.cancel();
    const items = [...this.overlays.values()]; this.overlays.clear();
    for (const item of items) if (!item.window.isDestroyed()) item.window.destroy();
    for (const channel of ['screen-crop:ready', 'screen-crop:select', 'screen-crop:cancel']) ipcMain.removeHandler(channel);
  }
}
