import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import type { ScreenCapture, ScreenReadingBridge } from '../../../../../packages/shared/screenReading';
import './screenReading.css';

type Props = { bridge: ScreenReadingBridge; onClose: () => void };
/** Local-only capture/OCR panel. It does not call any model or speech endpoint. */
export default function ScreenCapturePanel({ bridge, onClose }: Props) {
  const [phase, setPhase] = useState<'idle' | 'capture' | 'recognizing'>('idle');
  const [capture, setCapture] = useState<ScreenCapture | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [timing, setTiming] = useState('');
  const epoch = useRef(0);
  const startRef = useRef<() => Promise<void>>(async () => {});
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const cancel = () => { ++epoch.current; setPhase('idle'); void bridge.cancel().catch(() => {}); };
  const start = async () => {
    const token = ++epoch.current; setCapture(null); setText(''); setError(''); setTiming(''); setPhase('capture');
    try {
      const image = await bridge.capture();
      if (token !== epoch.current) return;
      if (!image) { setPhase('idle'); return; }
      setCapture(image); setPhase('recognizing');
      const result = await bridge.recognize(image.id);
      if (token !== epoch.current || result.id !== image.id) return;
      setText(result.text); setTiming(`本机识别 ${(result.elapsedMs / 1000).toFixed(1)} 秒 · ${result.language}`); setPhase('idle');
      if (!result.text.trim()) setError('没有识别到文字，请重新框选清晰、较大的正文区域。');
    } catch (cause) {
      if (token !== epoch.current) return;
      setError(cause instanceof Error ? cause.message : '截图识别未完成，请重试。'); setPhase('idle');
    }
  };
  startRef.current = start;
  useEffect(() => {
    // Defer the native side effect so React's development probe can clean up before capture.
    const timer = setTimeout(() => void startRef.current(), 0);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', key);
    return () => { clearTimeout(timer); ++epoch.current; void bridge.cancel().catch(() => {}); window.removeEventListener('keydown', key); };
  }, [bridge]);
  return <div className="modal-backdrop"><section className="screen-reading-panel" role="dialog" aria-modal="true" aria-label="屏幕截图识字">
    <div className="panel-heading"><div><h2>屏幕截图识字</h2><span>任意屏幕区域 · 本机 OCR</span></div><button className="icon-button" aria-label="关闭截图识字" onClick={onClose}><X size={20}/></button></div>
    <p className="screen-reading-privacy">截图和文字只在本机处理，不上传到识别模型，也不写入 PDF 学习记录。此入口目前只识别文字，尚未连接语音播放。</p>
    <p role="status" className="screen-reading-status">{phase === 'capture' ? '请拖动框选文字，松开后识别。Esc / 右键取消。' : phase === 'recognizing' ? '正在本机识别文字…' : timing || '可以重新截图，识别其他软件、网页或图片里的文字。'}</p>
    {error && <p role="alert" className="screen-reading-error">{error}</p>}
    {capture && <div className="screen-reading-content"><div><span>本次截图</span><img src={capture.imageDataUrl} alt="本次框选的屏幕区域"/></div><label>识别文字（可修改）<textarea aria-label="截图识别文字" value={text} maxLength={12000} disabled={phase !== 'idle'} onChange={event => setText(event.target.value)}/></label></div>}
    <div className="screen-reading-controls"><button className="secondary-button" disabled={phase !== 'idle'} onClick={() => void start()}><Camera size={16}/>重新截图</button>{phase !== 'idle' && <button className="secondary-button" onClick={cancel}>取消识别</button>}</div>
    <p className="screen-reading-note">支持清晰的中英文印刷文字；多栏、模糊文字可能识别不准，可缩小范围或修改。关闭窗口后丢弃本次截图和文字。</p>
  </section></div>;
}
