import { useEffect, useState } from 'react';
import { Square } from 'lucide-react';
import type { AudioState } from './AudioCoordinator';
import './qwenSpeechStatus.css';

/** Measures foreground waiting only; it is not a model progress estimate. */
export default function QwenSpeechStatus({ enabled, status, operationId, stopped, onStop }: {
  enabled: boolean;
  status?: AudioState['status'];
  operationId: string;
  stopped: boolean;
  onStop: () => void;
}) {
  const waiting = enabled && status === 'buffering';
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!waiting) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [waiting, operationId]);
  if (!enabled || (!waiting && !(stopped && status === 'silent'))) return null;
  return <section className={`qwen-speech-status${waiting ? '' : ' qwen-speech-stopped'}`} aria-label="Qwen 朗读状态">
    <div className="qwen-speech-status-copy">
      <div className="qwen-speech-status-heading"><strong role="status">{waiting ? 'Qwen3 正在准备声音' : '本地播放已停止'}</strong>{waiting && <span className="qwen-wait-seconds" data-testid="qwen-wait-seconds" aria-live="off">已等待 {seconds} 秒</span>}</div>
      <p>{waiting ? '较长句子可能需要等待，声音就绪后自动播放。可随时停止，或改选更短的一句。' : '取消请求已发出，本次声音不会继续播放。需要时可点「继续朗读」。'}</p>
    </div>
    {waiting && <button className="secondary-button" onClick={onStop}><Square size={13}/>停止本次朗读</button>}
  </section>;
}
