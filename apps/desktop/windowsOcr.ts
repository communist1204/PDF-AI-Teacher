import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { cleanOcrText } from '../../packages/shared/screenReading';

/** A bounded local recognizer. Screenshots travel over stdin, never shell arguments or temp files. */
export function recognizeWindowsImage(png: Buffer, script: string, signal: AbortSignal): Promise<{ text: string; language: string }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', done = false;
    const finish = (error?: Error, value?: { text: string; language: string }) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve(value!);
    };
    const abort = () => finish(Error('截图识别已取消。'));
    const timer = setTimeout(() => finish(Error('本机文字识别超时，请缩小截图范围后重试。')), 20000);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 200000) finish(Error('识别文字过多，请缩小截图范围。')); });
    child.stderr.resume();
    child.on('error', () => finish(Error('无法启动 Windows 本机文字识别。')));
    child.stdin.on('error', () => { /* Exit/error handler reports a sanitized failure. */ });
    child.on('close', code => {
      if (done) return;
      try {
        const value = JSON.parse(output.trim()) as { text?: unknown; language?: unknown; error?: string };
        if (value.error === 'OCR_LANGUAGE_UNAVAILABLE') throw Error('Windows 尚未安装可用的 OCR 语言。请在系统语言设置中添加中文文字识别功能后重试。');
        if (value.error === 'OCR_IMAGE_TOO_LARGE') throw Error('截图尺寸超出本机识别范围，请缩小选区。');
        if (code !== 0 || typeof value.text !== 'string' || typeof value.language !== 'string') throw Error('Windows 本机识别失败，请重新截取清晰文字。');
        const text = cleanOcrText(value.text);
        if (text.length > 12000) throw Error('识别文字超过 12000 字，请分成较小区域朗读。');
        finish(undefined, { text, language: value.language });
      } catch (error) { finish(error instanceof Error && /^[\u3400-\u9fffW]/.test(error.message) ? error : Error('本机识别结果无效，请重新截图。')); }
    });
    child.stdin.end(png.toString('base64'));
  });
}
