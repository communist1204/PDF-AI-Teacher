import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
export default function ReadingCorrectionDialog({sourceText,onSave,onClose}:{sourceText:string;onSave:(text:string)=>void;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);const [text,setText]=useState(sourceText);
  useEffect(()=>{dialog.current?.showModal();},[]);
  return <dialog ref={dialog} className="selection-question-dialog" aria-label="校对朗读文本" onCancel={event=>{event.preventDefault();onClose();}}><div className="panel-heading"><h2>校对原文与公式读法</h2><button className="icon-button" aria-label="关闭朗读校对" onClick={onClose}><X size={18}/></button></div><p className="question-mode-note">请对照 PDF 修改错字或补充公式读法。此版本用于本次朗读与陪读，PDF 原文件保持原样；旧续读位置会重置。</p><label className="question-label" htmlFor="reading-correction">确认后的朗读文本</label><textarea id="reading-correction" maxLength={12000} value={text} onChange={event=>setText(event.target.value)}/><div className="question-dialog-actions"><span>例如：beta 一的 t 次方</span><button className="primary-button" disabled={!text.trim()} onClick={()=>onSave(text)}>使用校对文本</button></div></dialog>;
}
