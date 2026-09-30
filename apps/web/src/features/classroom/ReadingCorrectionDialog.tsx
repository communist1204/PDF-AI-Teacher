import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { splitSentences, requiresFormulaConfirmation } from '../voice/sentences';
export type ReadingRecognition = { readingText: string; uncertain: boolean; warnings: string[] };
export default function ReadingCorrectionDialog({sourceText,onSave,onClose,onRecognize,onConfigure,recognitionModel,imageOnly=false}:{imageOnly?:boolean;sourceText:string;onSave:(text:string,play?:boolean)=>void;onClose:()=>void;onRecognize?:(text:string,signal:AbortSignal)=>Promise<ReadingRecognition>;onConfigure?:()=>void;recognitionModel?:string}){
  const dialog=useRef<HTMLDialogElement>(null);const [text,setText]=useState(sourceText);
  const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [uncertain,setUncertain]=useState(false);const [recognized,setRecognized]=useState(false);
  const task=useRef<AbortController|null>(null);const initial=useRef({sourceText,onRecognize,imageOnly});
  useEffect(()=>{dialog.current?.showModal();return()=>task.current?.abort();},[]);
  const recognize=async(input:string,recognizer=onRecognize)=>{
    if(!recognizer||task.current)return;
    const controller=new AbortController();task.current=controller;setBusy(true);setMessage('正在识别所选原文与公式，整理成自然的中文读法…');setRecognized(false);
    try{
      const result=await recognizer(input,controller.signal);
      if(controller.signal.aborted)return;
      setText(result.readingText);setUncertain(result.uncertain);setRecognized(true);
      setMessage(result.uncertain?'有内容暂时看不清：'+result.warnings.join('；')+'。请缩小选区或重新框选清晰的公式后再试。':'读法已自动整理，可以直接使用并朗读。AI 识别可能有误，可对照原页检查。');
    }catch(error){if(!controller.signal.aborted)setMessage((error as Error).message);}
    finally{if(task.current===controller){task.current=null;setBusy(false);}}
  };
  // Start once for an unresolved original selection, never for every edit or render.
  useEffect(()=>{
    let active=true;
    queueMicrotask(()=>{if(active&&(initial.current.imageOnly||requiresFormulaConfirmation(initial.current.sourceText)))void recognize(initial.current.sourceText,initial.current.onRecognize);});
    return()=>{active=false;};
  },[]);
  const needsReview=requiresFormulaConfirmation(text);
  const speech=splitSentences(text).map(sentence=>sentence.speechText).join('\n');
  const canSave=!!text.trim()&&!needsReview&&!uncertain&&!busy;
  return <dialog ref={dialog} className="selection-question-dialog reading-correction-dialog" aria-label="校对朗读文本" onCancel={event=>{event.preventDefault();onClose();}}>
    <div className="panel-heading"><h2>原文与公式读法</h2><button className="icon-button" aria-label="关闭朗读校对" onClick={onClose}><X size={18}/></button></div>
    <p className="question-mode-note">常见公式会自动转换。遇到提取乱码或复杂公式，AI 可结合原页选区识别并生成中文读法；无需逐个手改。只发送所选文字与选区截图，使用当前解题账号的额度，PDF 原文件保持原样。</p>
    <div className="reading-assist-actions"><button className="secondary-button" disabled={!onRecognize||busy} onClick={()=>void recognize(text)}>{busy?'正在自动识别…':'AI 自动识别读法'}</button>{onRecognize?<small>识别模型：{recognitionModel}</small>:<span>连接解题模型后可自动识别。<button className="text-button" onClick={onConfigure}>配置 GPT</button></span>}</div>
    {message&&<p className="reading-assist-message" role="status">{message}</p>}
    <label className="question-label" htmlFor="reading-correction">确认后的朗读文本</label><textarea id="reading-correction" maxLength={12000} disabled={busy} value={text} onChange={event=>{setText(event.target.value);setUncertain(false);setRecognized(false);}}/>
    <div className="speech-preview"><strong id="speech-preview-label">实际朗读内容预览</strong><pre aria-labelledby="speech-preview-label" data-testid="speech-preview">{speech||'输入一段文字后，这里显示将发送给语音引擎的读法。'}</pre></div>
    {needsReview&&!busy&&<p className="math-review-warning" role="status">有公式尚未转换，或读法过长。可点「AI 自动识别读法」，结合原页识别；预览中的原始命令不会直接发给语音引擎。</p>}
    <div className="question-dialog-actions"><span>{recognized?'AI 生成的朗读稿，不替代原文':'例如：贝塔，下标一，的 t 次方'}</span><button className="secondary-button" disabled={!canSave} onClick={()=>onSave(text)}>使用校对文本</button><button className="primary-button" disabled={!canSave} onClick={()=>onSave(text,true)}>使用并朗读</button></div>
  </dialog>;
}
