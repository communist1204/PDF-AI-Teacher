import { useEffect, useState } from 'react';
import type { AskRequest } from '../../../../../packages/shared/protocol';

type Props = {
  task: { startedAt: number; model: string; status: 'pending' | 'failed' | 'cancelled'; error?: string; submission: Pick<AskRequest, 'question' | 'context'> };
  onCancel: () => void;
  onRetry: () => void;
};

export default function QuestionStatus({ task, onCancel, onRetry }: Props) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (task.status !== 'pending') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task.status]);
  const source = task.submission.context.sources[0];
  const target = `PDF 第 ${source.pageIndex + 1} 页${task.submission.context.imageDataUrl ? ' · 截图' : ' · 所选原文'}`;
  if (task.status === 'pending') return <div className="thinking question-task" role="status">
    <strong><span className="green-dot"/>正在等待解答 · 已等待 {Math.max(0, Math.floor((now-task.startedAt)/1000))} 秒</strong>
    <span>本题已锁定 {target}</span>
    <span>模型：{task.model}。可以继续选文朗读，回答完成后会显示在这里和黑板上。</span>
    <button type="button" onClick={onCancel}>取消解答</button>
  </div>;
  return <div className="message assistant question-task question-task-failed" role="status">
    <strong>{task.status === 'failed' ? '这次解答未完成' : '已取消这次解答'}</strong>
    <span>{target} · {task.submission.question}</span>
    {task.error && <p>{task.error}</p>}
    <span>重试将使用这次发送时的原文、截图和问题。</span>
    <button className="secondary-button" type="button" onClick={onRetry}>重试这次提问</button>
  </div>;
}
