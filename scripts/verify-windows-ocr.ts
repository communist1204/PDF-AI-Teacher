import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { recognizeWindowsImage } from '../apps/desktop/windowsOcr';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 420 }, deviceScaleFactor: 1 });
  await page.setContent('<html lang="zh-CN"><body style="margin:40px;background:white;color:black;font:30px/1.8 Microsoft YaHei,sans-serif"><div id="sample">截图朗读测试。神经网络可以学习数据中的规律。<br>2026年，我们一起学习。<br>Deep learning helps us understand patterns.</div></body></html>');
  const png = await page.locator('#sample').screenshot();
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/windows-ocr-sample.png', png);
  const start = Date.now();
  const result = await recognizeWindowsImage(png, resolve('apps/desktop/windows-ocr.ps1'), new AbortController().signal);
  expect(result.text).toContain('神经网络可以学习数据中的规律');
  expect(result.text).toContain('2026'); expect(result.text).toContain('Deep learning');
  const record = { kind: 'real-local-windows-ocr', checkedAt: new Date().toISOString(), elapsedMs: Date.now() - start, ...result, input: 'self-authored Chinese and English print fixture', cloudRequests: 0 };
  await writeFile('docs/windows-ocr-verification.json', JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record, null, 2));
} finally { await browser.close(); }
