import { Volume2 } from 'lucide-react';
import type { BoardEntry } from '../blackboard/Blackboard';
import type { ClassroomState } from '../classroom/ClassroomController';

export default function AnswerSpeechControls({ entry, lesson, available, onListen, onContinue }: {
  entry: BoardEntry; lesson: ClassroomState | null; available: boolean;
  onListen: () => void; onContinue: () => void;
}) {
  if (entry.plan.needsClarification || !entry.plan.steps.length) return null;
  const current = lesson?.entry?.id === entry.id ? lesson : null;
  const finished = current && entry.plan.steps.every(step => current.completedStepIds.includes(step.stepId));
  const atEnd = current?.phase === 'waiting' && current.stepIndex === entry.plan.steps.length - 1;
  const canContinue = current && !atEnd && !finished && ['waiting', 'interrupted'].includes(current.phase);
  return <div className="answer-speech">
    <div className="answer-speech-actions">
      <button className="secondary-button" disabled={!available} onClick={onListen}><Volume2 size={13}/>{current ? '从头听讲解' : '听这次讲解'}</button>
      {canContinue && <button className="text-button" disabled={!available} onClick={onContinue}>继续这次讲解</button>}
    </div>
    <small>{!available ? '声音尚未配置；文字解答和板书可独立使用。' : finished ? '这次讲解已读完，可以继续打字追问。' : current ? `第 ${current.stepIndex + 1} / ${entry.plan.steps.length} 步 · 可用底部按钮暂停、继续或停止。` : entry.mode === 'demo' ? '本机声音读固定演示教案，尚未连接 AI。' : '朗读这次解答的讲解稿；每一步停顿，随时打字追问。'}</small>
  </div>;
}
