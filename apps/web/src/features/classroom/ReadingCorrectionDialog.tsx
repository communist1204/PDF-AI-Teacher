import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { splitSentences, requiresFormulaConfirmation } from '../voice/sentences';
export default function ReadingCorrectionDialog({sourceText,onSave,onClose}:{sourceText:string;onSave:(text:string)=>void;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);const [text,setText]=useState(sourceText);
  useEffect(()=>{dialog.current?.showModal();},[]);
  const needsReview=requiresFormulaConfirmation(text);
  const speech=splitSentences(text).map(sentence=>sentence.speechText).join('\n');
  return <dialog ref={dialog} className="selection-question-dialog reading-correction-dialog" aria-label="校对朗读文本" onCancel={event=>{event.preventDefault();onClose();}}>
    <div className="panel-heading"><h2>校对原文与公式读法</h2><button className="icon-button" aria-label="关闭朗读校对" onClick={onClose}><X size={18}/></button></div>
    <p className="question-mode-note">请对照 PDF 修改错字或补充公式读法。此版本用于本次朗读与陪读，PDF 原文件保持原样；旧续读位置会重置。公式转换只按符号读法，不代替理论解释。</p>
    <label className="question-label" htmlFor="reading-correction">确认后的朗读文本</label><textarea id="reading-correction" maxLength={12000} value={text} onChange={event=>setText(event.target.value)}/>
    <div className="speech-preview"><strong id="speech-preview-label">实际朗读内容预览</strong><pre aria-labelledby="speech-preview-label" data-testid="speech-preview">{speech||'输入一段文字后，这里显示将发送给语音引擎的读法。'}</pre></div>
    {needsReview&&<p className="math-review-warning" role="status">有公式尚未转换，或读法过长。请把不确定部分改成中文读法，或缩短选段；预览中的原始命令不会直接发给语音引擎。</p>}
    <div className="question-dialog-actions"><span>例如：贝塔，下标一，的 t 次方</span><button className="primary-button" disabled={!text.trim()||needsReview} onClick={()=>onSave(text)}>使用校对文本</button></div>
  </dialog>;
}
