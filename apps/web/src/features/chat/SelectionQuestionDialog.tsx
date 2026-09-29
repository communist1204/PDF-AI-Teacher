import { useEffect, useRef } from 'react';
import { ArrowUp, X } from 'lucide-react';
import type { PdfTarget } from '../../../../../packages/shared/protocol';

type Props = {
  target: PdfTarget;
  question: string;
  selectedBoardText?: string;
  demo: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSend: () => void;
};

export default function SelectionQuestionDialog({ target, question, selectedBoardText, demo, onChange, onClose, onSend }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
  }, []);
  return <dialog ref={dialog} className="selection-question-dialog" aria-labelledby="selection-question-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="panel-heading"><div><span className="eyebrow">PDF 第 {target.pageIndex + 1} 页 · {selectedBoardText ? '板书追问' : target.imageDataUrl ? '框选区域' : '所选原文'}</span><h2 id="selection-question-title">这次想问什么？</h2></div><button className="icon-button" aria-label="关闭选区提问" onClick={onClose}><X size={19}/></button></div>
    {target.imageDataUrl ? <img className="question-source-image" src={target.imageDataUrl} alt="本次提问的框选区域"/> : <blockquote className="question-source-text">{target.sourceText}</blockquote>}
    {selectedBoardText&&<div className="question-board-source"><strong>同时引用的板书步骤</strong><blockquote className="question-source-text">{selectedBoardText}</blockquote></div>}
    <label className="question-label" htmlFor="selection-question">本次选区问题</label>
    <textarea ref={input} id="selection-question" value={question} maxLength={2000} placeholder="例如：我没看懂第二个等号，能从上一步慢慢推导吗？" onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && question.trim()) { event.preventDefault(); onSend(); } }}/>
    <div className="question-suggestions">{['这一步为什么成立？', '解释每个符号的含义', '用一个小数字举例'].map(value => <button key={value} onClick={() => { onChange(value); input.current?.focus(); }}>{value}</button>)}</div>
    <p className="question-mode-note">{demo ? '演示模式：会记录你的问题，但仍展示固定样例教案。连接模型后才会针对原文回答。' : '发送后会将此选区、问题和最近的问答传给已配置的模型。'}</p>
    <div className="question-dialog-actions"><span>问题每次都可修改 · Ctrl+Enter 发送</span><button className="primary-button" disabled={!question.trim()} onClick={onSend}><ArrowUp size={15}/>发送选区问题</button></div>
  </dialog>;
}
