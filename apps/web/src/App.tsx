import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { BookOpen, Settings2, LockKeyhole, ArrowUp, Play, Pause, Square, SkipBack, SkipForward, Volume2, X, Bookmark, PanelRightClose, MessageCircle, RefreshCw, NotebookPen } from 'lucide-react';
import type { AppConfig, DocumentRecord, PdfTarget, TeachingStep, UsageRecord, Envelope } from '../../../packages/shared/protocol';
import { apiClient, getConfig } from './services/api';
import { SessionGuard, snapshot } from './state/session';
import { PdfReader } from './features/pdf/PdfReader';
import SelectionQuestionDialog from './features/chat/SelectionQuestionDialog';
import Blackboard, { type BoardEntry } from './features/blackboard/Blackboard';
import { AudioCoordinator, requiresFormulaConfirmation, type AudioState } from './features/voice/AudioCoordinator';

import { ClassroomController, type ClassroomState, type LessonMode, type LessonUnit } from './features/classroom/ClassroomController';
import ClassroomControls from './features/classroom/ClassroomControls';
import ReadingCorrectionDialog from './features/classroom/ReadingCorrectionDialog';
import LearningRecordsPanel from './features/settings/LearningRecordsPanel';
import VoiceQuestionInput from './features/voice/VoiceQuestionInput';
import { textVersion } from './features/voice/sentences';
import type { LearningRecord } from '../../../packages/shared/learning';
import { loadRecord, saveRecord } from './features/library/storage';
import { readRecovery, writeRecovery, clearRecovery } from './features/library/recovery';

type Message = { id: string; role: 'user' | 'assistant'; text: string; demo?: boolean };
export default function App() {
  const [config,setConfig]=useState<AppConfig|null>(null);
  const [documentRecord,setDocument]=useState<DocumentRecord|null>(null);
  const [target,setTarget]=useState<PdfTarget|null>(null);
  const [locked,setLocked]=useState<PdfTarget|null>(null);
  const [pageIndex,setPageIndex]=useState(0);
  const [follow,setFollow]=useState(false);
  const [question,setQuestion]=useState('');
  const [questionDialog,setQuestionDialog]=useState(false);
  const [correctionOpen,setCorrectionOpen]=useState(false);
  const [correction,setCorrection]=useState<{sourceId:string;text:string}|null>(null);
  const [voiceRevision,setVoiceRevision]=useState(0);
  const [lesson,setLesson]=useState<ClassroomState|null>(null);
  const [lessonMode,setLessonMode]=useState<LessonMode>('read-explain');
  const [lessonUnit,setLessonUnit]=useState<LessonUnit>('paragraph');
  const [autoResume,setAutoResume]=useState(false);
  const [activeEntryId,setActiveEntryId]=useState<string|null>(null);
  const [boardHidden,setBoardHidden]=useState(false);
  const [recordReady,setRecordReady]=useState<string|null>(null);
  const [persistenceEnabled,setPersistenceEnabled]=useState(true);
  const [storageNotice,setStorageNotice]=useState('');
  const replacingRecord=useRef<string|null>(null);
  const [recordReplacing,setRecordReplacing]=useState(false);
  const classroom=useRef<ClassroomController|null>(null);
  const askRef=useRef<(text:string,target?:PdfTarget,envelope?:Envelope)=>Promise<BoardEntry|null>>(async()=>null);
  const persistLatest=useRef<LearningRecord|null>(null);
  const autosaveTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const pendingSave=useRef<Promise<void>>(Promise.resolve());
  const savedIdentity=useRef('');
  const [clearSelectionRevision,setClearSelectionRevision]=useState(0);
  const [messages,setMessages]=useState<Message[]>([]);
  const [entries,setEntries]=useState<BoardEntry[]>([]);
  const [boardTarget,setBoardTarget]=useState<{text:string;target:PdfTarget}|null>(null);
  const [activeStep,setActiveStep]=useState(0);
  const [dark,setDark]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [settings,setSettings]=useState(false);
  const [chatVisible,setChatVisible]=useState(true);
  const [audioState,setAudioState]=useState<AudioState|null>(null);
  const [rate,setRate]=useState(1);
  const [volume,setVolume]=useState(0.8);
  const [usage,setUsage]=useState<UsageRecord[]>([]);
  const [usageSummary,setUsageSummary]=useState<{requestCount:number;maxRequests:number;cache:{entries:number;bytes:number;maxBytes:number}}|null>(null);
  const [note,setNote]=useState('');
  const [formulaConfirmed,setFormulaConfirmed]=useState(false);
  const [columns,setColumns]=useState([40,34]);
  const workspace=useRef<HTMLElement>(null);
  const [navigation,setNavigation]=useState<{pageIndex:number;rect?:[number,number,number,number];nonce:number}>();
  const guard=useRef(new SessionGuard('initial'));
  const request=useRef<AbortController|null>(null);
  const audio=useRef<AudioCoordinator|null>(null);
  const configRef=useRef<AppConfig|null>(null);
  const followRef=useRef(false);const currentPage=useRef(0);
  const contextRef=useRef<PdfTarget|null>(null);
  const latestDocument=useRef<string|null>(null);
  const lastTargetId=useRef<string|null>(null);

  const connect=useCallback(async()=>{try{const next=await getConfig();setConfig(next);configRef.current=next;guard.current=new SessionGuard(next.sessionId,next.generationId,next.contextRevision);setError('');}catch(e){setError((e as Error).message);}},[]);
  useEffect(()=>{void connect();},[connect]);
  useEffect(()=>{
    if(!config)return;
    const client=apiClient(config);
    const controller=new AudioCoordinator({requestSpeech:client.speech,onChange:setAudioState,onError:message=>{classroom.current?.interrupt();setError(message);},onComplete:event=>classroom.current?.onComplete(event)});
    audio.current=controller;setAudioState(controller.getSnapshot());
    return ()=>{controller.dispose();audio.current=null;};
  },[config]);
  useEffect(()=>{
    if(!settings||!config)return;
    const controller=new AbortController();
    void fetch('/api/usage',{signal:controller.signal}).then(response=>{if(!response.ok)throw new Error('用量暂时无法读取，请重新打开设置。');return response.json();}).then(data=>{setUsage(data.records);setUsageSummary(data);}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>controller.abort();
  },[settings,config]);
  const cancel=useCallback((change=false,keepLesson=false,keepInput=false)=>{
    if(!keepLesson)classroom.current?.interrupt();
    if(!keepInput)setVoiceRevision(value=>value+1);
    const previous=guard.current.current();request.current?.abort();request.current=null;audio.current?.interrupt();
    guard.current.next(change);setBusy(false);
    if(configRef.current)void apiClient(configRef.current).cancel(previous);
  },[]);
  useEffect(()=>{
    if(!config)return;
    const controller=new ClassroomController({
      audio:()=>audio.current,
      begin:()=>{cancel(false,true);return {envelope:guard.current.current(),mode:config.mode==='demo'?'demo':'live'};},
      generate:(source,envelope)=>askRef.current('请围绕本段进行一次简短教学：解释必要符号和原理，按需给出推导与小例子，最后留一个检查问题。',source,envelope),
      showStep:(entry,index)=>flushSync(()=>{setBoardHidden(false);setActiveEntryId(entry.id);setActiveStep(index);}),
      onChange:setLesson,onError:setError,
    });
    classroom.current=controller;setLesson(controller.getSnapshot());
    return()=>{controller.reset();classroom.current=null;};
  },[config,cancel]);
  const clearSelection=useCallback(()=>{
    cancel(true);
    setTarget(null);setLocked(null);setBoardTarget(null);contextRef.current=null;lastTargetId.current=null;
    setNavigation(undefined);setFormulaConfirmed(false);setQuestionDialog(false);setCorrectionOpen(false);setCorrection(null);setError('');
    setClearSelectionRevision(value=>value+1);
  },[cancel]);
  useEffect(()=>{
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||event.isComposing)return;
      if(settings){event.preventDefault();setSettings(false);return;}
      // The native dialog handles Escape, preserving the selection and draft.
      if(questionDialog||correctionOpen)return;
      if(documentRecord||target||locked||boardTarget){event.preventDefault();clearSelection();}
    };
    window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);
  },[settings,questionDialog,correctionOpen,documentRecord,target,locked,boardTarget,clearSelection]);
  useEffect(()=>{
    const offline=()=>{cancel();setError('网络已断开，声音已停止。阅读书签仍保留，请连接后手动继续。');};
    window.addEventListener('offline',offline);return()=>window.removeEventListener('offline',offline);
  },[cancel]);
  const queueSave=useCallback((record:LearningRecord)=>{
    pendingSave.current=pendingSave.current.catch(()=>{}).then(async()=>{await saveRecord(record);try{clearRecovery(record);}catch{/* The committed IndexedDB record remains authoritative. */}});
    return pendingSave.current;
  },[]);
  const suspendSaving=async(documentId:string)=>{
    if(replacingRecord.current)throw new Error('学习记录正在导入或删除，请等待完成。');
    if(latestDocument.current&&latestDocument.current!==documentId)throw new Error('当前 PDF 已变化，请在对应书籍中重试。');
    replacingRecord.current=documentId;setRecordReplacing(true);
    if(autosaveTimer.current)clearTimeout(autosaveTimer.current);
    autosaveTimer.current=null;persistLatest.current=null;savedIdentity.current='';setPersistenceEnabled(false);
    await pendingSave.current.catch(()=>{});
    return ()=>{replacingRecord.current=null;setRecordReplacing(false);};
  };
  const handleDocument=useCallback((value:DocumentRecord|null)=>{
    if(value?.documentId===latestDocument.current)return;
    if(persistLatest.current)void queueSave(persistLatest.current).catch(error=>setError(error.message));
    clearSelection();classroom.current?.reset();audio.current?.reset();setRecordReady(null);savedIdentity.current='';setBoardHidden(false);setActiveStep(0);setActiveEntryId(null);latestDocument.current=value?.documentId??null;lastTargetId.current=null;
    setDocument(value);setTarget(null);setLocked(null);contextRef.current=null;setBoardTarget(null);setEntries([]);setMessages([]);setQuestion('');setPageIndex(0);currentPage.current=0;setError('');
    if(value){try{setNote(localStorage.getItem(`pdf-teacher-note:${value.documentId}`)??'');}catch{setNote('');}}else setNote('');
  },[clearSelection,queueSave]);
  const handleTarget=useCallback((value:PdfTarget|null)=>{
    if(value?.sourceId===lastTargetId.current)return;
    lastTargetId.current=value?.sourceId??null;
    if(value){cancel(true);classroom.current?.reset();audio.current?.reset();setCorrection(null);setBoardTarget(null);contextRef.current=value;}
    setTarget(value);setFormulaConfirmed(false);
  },[cancel]);
  const handlePage=useCallback((page:number)=>{
    const previous=currentPage.current;currentPage.current=page;setPageIndex(page);
    if(followRef.current&&previous!==page){clearSelection();audio.current?.reset();}
  },[clearSelection]);
  const effective=boardTarget?.target??target??locked;
  const ask=async(text=question,overrideTarget?:PdfTarget,providedEnvelope?:Envelope):Promise<BoardEntry|null>=>{
    const source=overrideTarget??effective;
    if(!text.trim())return null;
    if(!config){setError('请先连接本地服务。');return null;}
    if(!source){setError('你想了解哪一段？请在 PDF 中选中文字或框选一个公式。');return null;}
    if(config.mode==='unconfigured'){setError('真实模型未配置。请在本机 .env 配置，或启用 DEMO_MODE=true。');return null;}
    if(!providedEnvelope)cancel();setError('');
    const envelope=providedEnvelope??guard.current.current();
    const context=snapshot(source,overrideTarget?null:boardTarget?.text??null);
    contextRef.current=structuredClone(source);setLocked(structuredClone(source));
    const controller=new AbortController();request.current=controller;setBusy(true);
    const submitted=text.trim();if(!overrideTarget)setQuestion('');
    const history=messages.slice(-6).map(m=>({role:m.role,text:m.text.slice(0,4000)}));
    setMessages(prev=>[...prev,{id:crypto.randomUUID(),role:'user',text:submitted}]);
    try{
      const result=await apiClient(config).ask({...envelope,question:submitted,context,history},controller.signal);
      if(!guard.current.accepts(result))return null;
      const entry={id:crypto.randomUUID(),plan:result.plan,context,mode:result.mode};
      setMessages(prev=>[...prev,{id:entry.id,role:'assistant',text:result.plan.needsClarification?[result.plan.answer,result.plan.clarificationQuestion].filter(Boolean).join('\n'):result.plan.answer,demo:result.mode==='demo'}]);
      setEntries(prev=>[...prev,entry]);setBoardHidden(false);setActiveEntryId(entry.id);setActiveStep(0);setUsage(prev=>[...prev,result.usage]);
      if(!providedEnvelope&&autoResume&&classroom.current?.getSnapshot().phase==='interrupted')void classroom.current.continue();
      return entry;
    }catch(e){if(!controller.signal.aborted&&guard.current.accepts(envelope))setError((e as Error).message);}
    finally{if(guard.current.accepts(envelope)){setBusy(false);request.current=null;}}
    return null;
  };
  useEffect(()=>{askRef.current=ask;});
  const readingTarget=effective&&correction?.sourceId===effective.sourceId?{...effective,sourceId:effective.sourceId.slice(0,135)+':corrected:'+textVersion(correction.text),blockId:effective.blockId.slice(0,135)+':corrected:'+textVersion(correction.text),sourceText:correction.text}:effective;
  const read=async()=>{
    if(!effective?.sourceText.trim()){setError('请先选择可核对的原文。图片区域没有可靠转写，不能逐字朗读。');return;}
    if(requiresFormulaConfirmation(effective.sourceText)&&!formulaConfirmed){setError('选区含有需要核对的公式。请对照原页核对并勾选确认后再朗读。');return;}
    if(!config||config.mode==='unconfigured'){setError('TTS 未配置。可在 .env 开启演示模式体验浏览器合成语音。');return;}
    cancel();setError('');setLocked(structuredClone(effective));
    classroom.current?.reset();audio.current?.load(readingTarget!,guard.current.current(),config.mode==='demo'?'demo':'live');
    audio.current?.setRate(rate);audio.current?.setVolume(volume);
    try{await audio.current?.play();}catch(e){setError((e as Error).message);}
  };
  const resume=async()=>{setError('');try{if(classroom.current?.getSnapshot().phase==='interrupted'){await classroom.current.continue();return;}if(audioState?.status!=='paused'){cancel();audio.current?.rebind(guard.current.current());}await audio.current?.resume();}catch(e){setError((e as Error).message);}};
  const resumeOriginal=async()=>{
    if(!config||!audio.current?.getBookmark())return;
    cancel();classroom.current?.reset();setError('');
    await audio.current.resumeSource(guard.current.current(),config.mode==='demo'?'demo':'live');
  };
  const selectBoard=(step:TeachingStep,entry:BoardEntry)=>{cancel(true);setFormulaConfirmed(false);const source=entry.context.sources.find(s=>step.sourceIds.includes(s.sourceId))??entry.context.sources[0];setBoardTarget({text:`${step.title}\n${step.explanationMarkdown}\n${step.boardBlocks.map(b=>b.type==='math'?b.latex:b.type==='text'?b.markdown:b.type==='callout'?b.text:JSON.stringify('rows' in b?b.rows:b)).join('\n')}`,target:source});setQuestion(`请解释“${step.title}”这一步。`);};
  const startLesson=async()=>{
    if(!readingTarget?.sourceText.trim()||!config||config.mode==='unconfigured'){setError('请先选择原文，并连接可用的演示或 API 服务。');return;}
    if(requiresFormulaConfirmation(readingTarget.sourceText)&&!formulaConfirmed){setError('请先核对公式，或使用校对朗读文本。');return;}
    setError('');setLocked(structuredClone(readingTarget));audio.current?.setRate(rate);audio.current?.setVolume(volume);
    try{await classroom.current?.start(readingTarget,lessonMode,lessonUnit);}catch(error){setError((error as Error).message);}
  };
  const speakStep=(_step:TeachingStep,entry:BoardEntry,index:number)=>{
    if(!config||config.mode==='unconfigured'){setError('请先配置语音模型或启用演示模式。');return;}
    cancel();classroom.current?.restore(entry,index,[]);void classroom.current?.continue();
  };
  const applyRecord=useCallback((record:LearningRecord)=>{
    if(latestDocument.current!==record.document.documentId)return;
    clearSelection();audio.current?.reset();setTarget(record.target);setLocked(null);lastTargetId.current=record.target?.sourceId??null;contextRef.current=record.target;
    setBoardTarget(null);setBoardHidden(false);setCorrection(null);setMessages(record.messages);setEntries(record.entries);setActiveStep(record.activeStep);setActiveEntryId(record.activeEntryId??record.entries.at(-1)?.id??null);
    setNote(record.note);setLessonMode(record.preferences.mode);setLessonUnit(record.preferences.unit);setAutoResume(record.preferences.autoResume);
    setNavigation({pageIndex:record.pageIndex,rect:record.target?.pageIndex===record.pageIndex?record.target.rect??undefined:undefined,nonce:Date.now()});
    currentPage.current=record.pageIndex;setPageIndex(record.pageIndex);
    if(record.readingBookmark)audio.current?.restoreBookmark(record.readingBookmark,guard.current.current(),configRef.current?.mode==='demo'?'demo':'live');
    if(record.teachingProgress){
      const progress=record.teachingProgress;const entry=record.entries.find(value=>value.id===progress.entryId);
      classroom.current?.restoreProgress(progress,entry??null);
    }else classroom.current?.reset();
    setStorageNotice('已恢复本书记录。声音保持停止，核对后可手动继续。');
  },[clearSelection]);
  useEffect(()=>{
    if(!documentRecord||!config)return;
    let valid=true;const documentId=documentRecord.documentId;const loadRevision=guard.current.current().contextRevision;setPersistenceEnabled(true);setStorageNotice('正在读取本书记录…');
    let recovery:LearningRecord|null=null;try{recovery=readRecovery(documentRecord);}catch(error){setError((error as Error).message);setPersistenceEnabled(false);}
    void loadRecord(documentRecord).then(saved=>{const record=recovery&&(!saved||recovery.updatedAt>=saved.updatedAt)?recovery:saved;if(!valid||latestDocument.current!==documentId)return;if(record&&guard.current.current().contextRevision!==loadRevision){setPersistenceEnabled(false);setStorageNotice('发现旧记录，但你已经开始新操作；为避免覆盖，自动保存暂停。重新打开同一本 PDF 可恢复。');}else if(record)applyRecord(record);else setStorageNotice('本书学习记录会自动保存在当前浏览器。');setRecordReady(documentId);}).catch(error=>{if(valid){if(recovery)applyRecord(recovery);setError(error.message);setStorageNotice('存储不可用，当前内容仍在内存，可手动导出。');setRecordReady(documentId);setPersistenceEnabled(false);}});
    return()=>{valid=false;};
  },[documentRecord,config,applyRecord]);
  const buildRecord=():LearningRecord|null=>{
    if(!documentRecord)return null;
    const progress=lesson&&lesson.phase!=='idle'&&lesson.phase!=='complete'?{entryId:lesson.entry?.id??null,stepIndex:lesson.stepIndex,completedStepIds:lesson.completedStepIds,interrupted:lesson.phase==='interrupted',units:lesson.units,unitIndex:lesson.unitIndex,mode:lesson.mode,phase:lesson.phase==='interrupted'?lesson.interruptedPhase:lesson.phase}:null;
    return {format:'pdf-ai-teacher.learning',version:1,document:documentRecord,pageIndex,target:target??locked,messages,entries,activeStep,activeEntryId,note,readingBookmark:audio.current?.getBookmark()??null,teachingProgress:progress,preferences:{mode:lessonMode,unit:lessonUnit,autoResume},updatedAt:new Date().toISOString()};
  };
  useEffect(()=>{
    if(recordReady!==documentRecord?.documentId||!persistenceEnabled){persistLatest.current=null;return;}
    const record=buildRecord();persistLatest.current=record;if(!record)return;
    const identity=JSON.stringify({...record,updatedAt:''});if(identity===savedIdentity.current)return;
    try{writeRecovery(record);}catch(error){setError((error as Error).message);setStorageNotice('恢复快照未保存，正在尝试主库；请等保存结束再关闭或先导出。');}
    autosaveTimer.current=setTimeout(()=>{savedIdentity.current=identity;void queueSave(record).catch(error=>{savedIdentity.current='';setPersistenceEnabled(false);setError(error.message);setStorageNotice('自动保存失败，当前内容仍在内存，请导出后清理空间。');});},180);
    return()=>{if(autosaveTimer.current)clearTimeout(autosaveTimer.current);};
  });
  useEffect(()=>{const flush=()=>{if(persistLatest.current){try{writeRecovery(persistLatest.current);}catch{/* The UI already reports journal failures. */}void queueSave(persistLatest.current).catch(()=>{});}};window.addEventListener('pagehide',flush);return()=>window.removeEventListener('pagehide',flush);},[queueSave]);
  const deleteCurrentRecord=(documentId:string)=>{
    if(latestDocument.current!==documentId)return;
    setPersistenceEnabled(false);persistLatest.current=null;clearSelection();classroom.current?.reset();audio.current?.reset();
    setMessages([]);setEntries([]);setActiveStep(0);setNote('');setTarget(null);setLocked(null);setBoardTarget(null);setActiveEntryId(null);setCorrection(null);setClearSelectionRevision(value=>value+1);
    if(documentRecord){try{localStorage.removeItem('pdf-teacher-note:'+documentRecord.documentId);}catch{/* IndexedDB record is already deleted. */}}
    setStorageNotice('本书记录已删除，自动保存暂停。');
  };
  const resizeColumn=(index:number,startX:number)=>{
    const width=workspace.current?.getBoundingClientRect().width??1000;
    const start=[...columns];
    const move=(event:PointerEvent)=>{const delta=(event.clientX-startX)/width*100;setColumns(index===0?[Math.max(28,Math.min(48,start[0]+delta)),start[1]]:[start[0],Math.max(25,Math.min(43,start[1]+delta))]);};
    const done=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',done);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',done,{once:true});
  };
  const currentSentence=audioState?.sentences[audioState.sentenceIndex];
  const outputLabel={silent:'待机',buffering:'准备声音',speaking:'正在朗读',paused:'已暂停'};
  const saveNote=(value:string)=>{setNote(value);if(persistenceEnabled&&recordReady===documentRecord?.documentId){const current=buildRecord();if(current){const next={...current,note:value};persistLatest.current=next;try{writeRecovery(next);}catch(error){setError((error as Error).message);}}}if(documentRecord){try{localStorage.setItem(`pdf-teacher-note:${documentRecord.documentId}`,value);}catch{setError('本地笔记存储失败，请复制保留内容。');}}};
  return <div className="app-shell">
    <header className="app-header"><div className="brand"><span className="brand-mark"><BookOpen size={23}/></span><div><strong>PDF AI Teacher</strong><span>你的陪读学习工作台</span></div></div><div className="document-title"><span className="small-label">正在阅读</span><strong>{documentRecord?.fileName??'从一本书，一个问题开始'}</strong>{documentRecord&&<span>PDF {pageIndex+1} / {documentRecord.pageCount}</span>}</div><div className="header-actions"><span className={`mode-badge ${config?.mode==='live'?'live':''}`}><i/>{config?.mode==='demo'?'演示模式 · AI 未连接':config?.mode==='live'?'API 模式 · 能力待验':'模型未配置'}</span><button className="icon-button" title="设置与用量" aria-label="设置与用量" disabled={!!documentRecord&&recordReady!==documentRecord.documentId} onClick={()=>setSettings(true)}><Settings2 size={19}/></button></div></header>
    <div className="session-toolbar"><div className="session-label"><span className="green-dot"/>学习空间 <span className="divider">/</span><span>M2 · 课堂陪读</span>{documentRecord&&!persistenceEnabled&&<button className="text-button" onClick={()=>setSettings(true)}>自动保存已暂停 · 查看原因</button>}</div><div className="toolbar-actions"><span className="locked-indicator"><LockKeyhole size={13}/>{locked?`讲解锁定 · PDF 第 ${locked.pageIndex+1} 页`:'等待选择学习目标'}</span><button className="text-button" onClick={()=>{const next=!follow;setFollow(next);followRef.current=next;cancel(true);if(next){clearSelection();audio.current?.reset();}}}>{follow?'跟随当前页 ✓':'切换为跟随当前页'}</button><button className="icon-button" aria-label="展开或折叠对话" onClick={()=>setChatVisible(!chatVisible)}><PanelRightClose size={17}/></button></div></div>
    {error&&<div className="error-banner" role="alert"><span>{error}</span><div>{!config&&<button onClick={()=>void connect()}><RefreshCw size={14}/>重新连接</button>}<button aria-label="关闭提示" onClick={()=>setError('')}><X size={16}/></button></div></div>}
    <main inert={!!documentRecord&&recordReady!==documentRecord.documentId} aria-busy={!!documentRecord&&recordReady!==documentRecord.documentId} ref={workspace} style={chatVisible?{gridTemplateColumns:`minmax(300px,${columns[0]}fr) minmax(310px,${columns[1]}fr) minmax(270px,${100-columns[0]-columns[1]}fr)`}:undefined} className={`workspace ${!chatVisible?'chat-collapsed':''}`}>
      <section className="reader-panel panel" aria-label="PDF 阅读区"><PdfReader clearSelectionRevision={clearSelectionRevision} onClearSelection={clearSelection} onDocument={handleDocument} onTarget={handleTarget} onPage={handlePage} onError={setError} navigation={navigation} readingText={audioState?.channel==='source'&&audioState.status==='speaking'&&audioState.cursor?.pageIndex===pageIndex&&audioState.cursor?.documentId===documentRecord?.documentId?currentSentence?.sourceText:undefined}/><div className="selection-tray"><div className="selection-title"><span className="eyebrow">{boardTarget?'已选板书步骤':effective?.imageDataUrl?'公式区域预览':effective?'原文选区预览':'你的阅读目标'}</span>{effective&&<span>PDF {effective.pageIndex+1} 页{effective.pageLabel?` · 书面 ${effective.pageLabel}`:''}</span>}</div>{effective?.imageDataUrl?<img className="crop-preview" src={effective.imageDataUrl} alt="即将发送的公式截图"/>:<p className="selection-preview">{boardTarget?.text??effective?.sourceText??'用鼠标选择 PDF 文字，或框选一个想弄懂的公式。'}</p>}<div className="selection-actions"><button className="primary-button" disabled={!effective||busy} onClick={()=>{cancel();setQuestionDialog(true);}}><MessageCircle size={15}/>针对选区提问</button><button className="secondary-button" disabled={!effective?.sourceText} onClick={()=>void read()}><Volume2 size={15}/>朗读所选</button>{effective&&<button className="text-button clear-selection-button" title="清除选区与提问目标（Esc），保留阅读书签" onClick={clearSelection}><X size={13}/>取消选中 <kbd>Esc</kbd></button>}</div><p className="selection-question-hint">每次可编辑问题，也可以直接在右侧输入。{effective?.sourceText&&<button className="text-button" onClick={()=>{cancel();setCorrectionOpen(true);}}>校对朗读文本</button>}{correction&&<span> · 使用已校对版本</span>}</p><ClassroomControls state={lesson} mode={lessonMode} unit={lessonUnit} disabled={!effective?.sourceText||busy} onMode={value=>{cancel();classroom.current?.reset();setLessonMode(value);}} onUnit={value=>{cancel();classroom.current?.reset();setLessonUnit(value);}} onStart={()=>void startLesson()} onContinue={()=>void classroom.current?.continue().catch(error=>setError(error.message))} onStop={()=>{cancel();classroom.current?.reset();}}/><label className="formula-confirm">{effective?.sourceText && requiresFormulaConfirmation(effective.sourceText) && <><input type="checkbox" checked={formulaConfirmed} onChange={e=>setFormulaConfirmed(e.target.checked)}/>已对照原页核对公式，按预览原文朗读</>}</label><p className="privacy-hint">{config?.mode==='demo'?'演示模式：内容留在本机，不调用模型。':effective?.imageDataUrl?'发送问题时：此截图与问题将传给配置的模型服务。':'发送问题时：所选原文、最近 6 条问答（每条最多 4000 字）与问题将传给模型。'}</p></div></section>
      <Blackboard activeEntryId={activeEntryId} revealThrough={lesson?.entry?{entryId:lesson.entry.id,index:lesson.stepIndex}:null} onSpeak={speakStep} entries={boardHidden?[]:entries} active={activeStep} setActive={setActiveStep} dark={dark} setDark={setDark} onSelect={selectBoard} onSource={(id,entry)=>{const source=entry.context.sources.find(s=>s.sourceId===id);if(source)setNavigation({pageIndex:source.pageIndex,rect:source.rect??undefined,nonce:Date.now()});}} onClear={()=>{cancel();setBoardHidden(true);setBoardTarget(null);}}/>
      {chatVisible&&<section className="chat-panel panel" aria-label="学习对话"><div className="panel-heading"><div><span className="eyebrow">03 / CONVERSATION</span><h2>一起想明白</h2></div><span className="chat-status">{busy?'准备教案中':'文字问答'}</span></div><div className="conversation-scroll">{!messages.length&&<div className="chat-welcome"><div className="teacher-avatar"><BookOpen size={21}/></div><h3>今天想弄懂什么？</h3><p>先选中一段原文，我们从一个小问题开始。</p>{config?.mode==='demo'&&<div className="demo-notice">当前为明确演示模式。教案使用自制样例，不代表模型理解了你的教材。</div>}<span className="small-label">你可以这样问</span><div className="prompt-list">{['这一步为什么成立？','解释每个符号的含义','用一个小数字举例'].map(p=><button key={p} onClick={()=>setQuestion(p)}>{p}<ArrowUp size={13}/></button>)}</div></div>}{messages.map(m=><div className={`message ${m.role}`} key={m.id}><div className="message-label">{m.role==='user'?'你':m.demo?'演示讲解 · 非真实 AI':'AI 老师'}</div><p>{m.text}</p></div>)}{busy&&<div className="thinking" role="status"><span className="green-dot"/>正在生成并校验教案…<button onClick={()=>cancel()}>取消</button></div>}</div><div className="composer-area">{effective&&<div className="target-chip"><span>{boardTarget?'已选板书':effective.imageDataUrl?'框选区域':'所选文字'} · PDF 第 {effective.pageIndex+1} 页</span><button aria-label="取消提问目标" onClick={clearSelection}><X size={12}/></button></div>}<div className="composer"><textarea aria-label="输入文字问题" placeholder="哪一步还不清楚？" value={question} maxLength={2000} onChange={e=>{cancel();setQuestion(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void ask();}}}/><div className="composer-bottom"><span>Enter 发送 · Shift+Enter 换行</span><button aria-label="发送问题" disabled={!question.trim()||busy} onClick={()=>void ask()}><ArrowUp size={18}/></button></div></div><VoiceQuestionInput config={config} onStart={()=>{cancel(false,false,true);return guard.current.current();}} onTranscript={(text,envelope)=>{if(guard.current.accepts(envelope)){setQuestion(text);setError('');}}} onError={setError} resetRevision={voiceRevision} disabled={!effective}/><div className="future-voice">语音转文字后确认发送 · 实时插话为 M3</div><details className="notes"><summary><NotebookPen size={13}/>本书本地笔记</summary><textarea aria-label="本书本地笔记" value={note} disabled={!documentRecord} onChange={e=>saveNote(e.target.value)} placeholder="只保存在当前浏览器，不发送给模型"/></details></div></section>}
      {chatVisible&&<><div className="column-handle first" style={{left:`calc((100% - 28px) * ${columns[0]/100} + 7px)`}} role="separator" aria-label="调整阅读器宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight")setColumns([Math.max(28,Math.min(48,columns[0]+(e.key==="ArrowRight"?1:-1))),columns[1]]);}} onPointerDown={e=>{e.preventDefault();resizeColumn(0,e.clientX);}}/><div className="column-handle second" style={{left:`calc((100% - 28px) * ${(columns[0]+columns[1])/100} + 21px)`}} role="separator" aria-label="调整黑板宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight")setColumns([columns[0],Math.max(25,Math.min(43,columns[1]+(e.key==="ArrowRight"?1:-1)))]);}} onPointerDown={e=>{e.preventDefault();resizeColumn(1,e.clientX);}}/></>}    </main>
    <footer className="audio-bar" aria-label="朗读控制"><div className="audio-source"><span className={`audio-emblem ${audioState?.status==='speaking'?'playing':''}`}><Volume2 size={20}/></span><div><strong>{audioState?outputLabel[audioState.status as keyof typeof outputLabel]??'待机':'声音待机'}<span className="audio-kind">{config?.mode==='demo'?'本机合成语音 · 演示':config?.mode==='live'?'AI 合成语音':'声音未配置'}</span></strong><span className="subtitle" data-testid="reading-subtitle">{currentSentence?.sourceText??'选择原文，开启一小段朗读'}</span></div></div><div className="playback-controls"><button className="icon-button" aria-label="上一句" disabled={!audioState?.hasBookmark} onClick={()=>audio.current?.previous()}><SkipBack size={17}/></button><button className="play-button" aria-label={(audioState?.status==='speaking'||audioState?.status==='buffering')?'暂停朗读':'继续朗读'} disabled={!audioState?.hasBookmark} onClick={()=>(audioState?.status==='speaking'||audioState?.status==='buffering')?audio.current?.pause():void resume()}>{(audioState?.status==='speaking'||audioState?.status==='buffering')?<Pause size={18}/>:<Play size={18}/>}</button><button className="icon-button" aria-label="下一句" disabled={!audioState?.hasBookmark} onClick={()=>audio.current?.next()}><SkipForward size={17}/></button><button className="stop-button" onClick={()=>{cancel();audio.current?.stop();}}><Square size={14}/>停止</button></div><div className="audio-options">{audioState?.channel==='explanation'&&audioState.cursor&&<button className="text-button" onClick={()=>void resumeOriginal()}>回原文继续</button>}<button className="text-button voice-settings-button" disabled={!!documentRecord&&recordReady!==documentRecord.documentId} onClick={()=>setSettings(true)}>声音设置</button><button className="bookmark-button" disabled={!audioState?.cursor} onClick={()=>{const cursor=audioState?.cursor;if(cursor)setNavigation({pageIndex:cursor.pageIndex,nonce:Date.now()});}}><Bookmark size={14}/>阅读位置</button><label>语速<select aria-label="语速" value={rate} onChange={e=>{const value=Number(e.target.value);setRate(value);audio.current?.setRate(value);}}>{[0.75,1,1.25,1.5].map(n=><option key={n} value={n}>{n}×</option>)}</select></label><label className="volume-control"><Volume2 size={15}/><input aria-label="音量" type="range" min="0" max="1" step="0.1" value={volume} onChange={e=>{setVolume(Number(e.target.value));audio.current?.setVolume(Number(e.target.value));}}/></label></div></footer>
    {questionDialog&&effective&&<SelectionQuestionDialog target={effective} question={question} selectedBoardText={boardTarget?.text} demo={config?.mode==='demo'} onChange={setQuestion} onClose={()=>setQuestionDialog(false)} onSend={()=>{setQuestionDialog(false);void ask();}}/>}
    {correctionOpen&&effective&&<ReadingCorrectionDialog sourceText={correction?.sourceId===effective.sourceId?correction.text:effective.sourceText} onClose={()=>setCorrectionOpen(false)} onSave={text=>{cancel(true);classroom.current?.reset();audio.current?.reset();setCorrection({sourceId:effective.sourceId,text});setFormulaConfirmed(true);setCorrectionOpen(false);}}/>}
    {settings&&<div className="modal-backdrop" onClick={()=>setSettings(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-label="设置与用量" onClick={e=>e.stopPropagation()}><div className="panel-heading"><h2>设置与用量</h2><button className="icon-button" aria-label="关闭设置" onClick={()=>setSettings(false)}><X size={19}/></button></div><p>API Key 只在后端 <code>.env</code> 配置。不要填写到浏览器或聊天中。</p><div className="config-card"><strong>{config?.mode==='demo'?'DEMO_MODE=true · 本机演示':config?.mode==='live'?'API 模式 · 按账号能力验证':'尚未配置真实模型'}</strong><p>文字：{config?.models.chat||'未配置'}<br/>视觉：{config?.models.vision||'未配置'}<br/>TTS：{config?.models.tts||'未配置'}<br/>转写：{config?.models.transcription||'未配置'}</p></div><div className="voice-config-card"><strong>声音与语气</strong><p>{config?.mode==='demo'?'当前使用 Windows / 浏览器本机语音，音色和语气受系统限制。自然语音模型尚未连接。':config?.mode==='live'?'当前使用后端配置的 AI 合成语音，实际听感需试听验证。':'尚未配置声音。'}</p>{config?.mode==='live'&&config.speech&&<p>当前音色：{config.speech.voice}；语气：{config.speech.style}。{!config.speech.instructionsSupported&&'当前模型未启用语气指令。'}</p>}<p>自然朗读可在本机 .env 配置 TTS_MODEL=gpt-4o-mini-tts、TTS_VOICE=marin，并关闭演示模式；语气说明可用 TTS_INSTRUCTIONS 调整。需要自己的 API 权限和额度。</p><p>已支持录音转文字后确认提问。GPT-Live 连续语音对话和实时插话尚未接入。</p><label className="auto-resume-option"><input type="checkbox" checked={autoResume} onChange={event=>setAutoResume(event.target.checked)}/>文字问答完成后自动继续已中断的陪读（默认关闭）</label></div><p>真实请求会产生独立 API 费用。当前费用：<b>无法估算</b>。本会话请求：{usageSummary?.requestCount??usage.length} / {usageSummary?.maxRequests??config?.maxRequests??100}；文字 {usage.filter(u=>u.category==="text").length} 次、语音 {usage.filter(u=>u.category==="tts").length} 次、转写 {usage.filter(u=>u.category==="transcription").length} 次。可取得的输入 / 输出 token：{usage.some(u=>u.inputTokens!==null)?usage.reduce((n,u)=>n+(u.inputTokens??0),0):"未知"} / {usage.some(u=>u.outputTokens!==null)?usage.reduce((n,u)=>n+(u.outputTokens??0),0):"未知"}。</p><p>当前会话音频缓存：{usageSummary?`${usageSummary.cache.entries} 段 / ${(usageSummary.cache.bytes/1024/1024).toFixed(1)} MB`:"未读取"}，后端总上限 {usageSummary?(usageSummary.cache.maxBytes/1024/1024):32} MB。原文不会自动整书上传。学习记录保存在当前浏览器，重新打开同一 PDF 可恢复；音频和原始录音不持久化。</p><button className="secondary-button" onClick={()=>{if(config)void apiClient(config).clearCache().then(()=>{setUsageSummary(prev=>prev?{...prev,cache:{...prev.cache,entries:0,bytes:0}}:null);setError('音频缓存已清除。');}).catch(e=>setError(e.message));}}>清除音频缓存</button><p className="privacy-hint">暂停同一段音频时原位继续；停止或提问后以未完成句的句首续读。复杂公式请先核对提取文本。M3 实时插话尚未启用。</p><details className="usage-details"><summary>最近请求与语音用量</summary><table><thead><tr><th>类别 / 模型</th><th>服务端用量</th><th>状态</th></tr></thead><tbody>{usage.slice(-10).reverse().map((item,index)=><tr key={item.requestId+index}><td>{item.category}<br/>{item.model}<small>{item.requestId}</small></td><td>{item.category==='transcription'?(item.audioSeconds!=null?item.audioSeconds+' 秒':'音频时长未知'):(item.inputTokens!=null||item.outputTokens!=null?(item.inputTokens??'?')+' / '+(item.outputTokens??'?')+' tokens':item.characters!=null?item.characters+' 字符':'未知')}</td><td>{item.cancelled?'已取消，可能已计费':'已完成'}</td></tr>)}</tbody></table></details><LearningRecordsPanel replacing={recordReplacing} onBeforeReplace={suspendSaving} record={buildRecord()} enabled={persistenceEnabled} onEnable={()=>{if(!replacingRecord.current)setPersistenceEnabled(true);}} onImport={record=>{if(documentRecord&&latestDocument.current===record.document.documentId){applyRecord(record);setPersistenceEnabled(true);setRecordReady(documentRecord.documentId);}}} onDelete={deleteCurrentRecord} onError={setError}/><p className="storage-notice" role="status">{storageNotice}</p></section></div>}
  </div>;
}
