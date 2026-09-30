import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { BookOpen, Settings2, LockKeyhole, ArrowUp, Play, Pause, Square, SkipBack, SkipForward, Volume2, X, Bookmark, PanelRightClose, MessageCircle, RefreshCw, NotebookPen } from 'lucide-react';
import type { AppConfig, DocumentRecord, PdfTarget, TeachingStep, UsageRecord, Envelope } from '../../../packages/shared/protocol';
import { apiClient, getConfig } from './services/api';
import { SessionGuard, snapshot } from './state/session';
import FeatureGuide from './features/experience/FeatureGuide';
import PracticeCoach from './features/experience/PracticeCoach';
import { MIN_SPEECH_RATE } from '../../../packages/shared/speechRate';
import type { SpeechEngine } from '../../../packages/shared/localSpeech';
import { PdfReader, type ReaderAction } from './features/pdf/PdfReader';
import SelectionQuestionDialog from './features/chat/SelectionQuestionDialog';
import AnswerSpeechControls from './features/chat/AnswerSpeechControls';
import Blackboard, { type BoardEntry } from './features/blackboard/Blackboard';
import { AudioCoordinator, requiresFormulaConfirmation, type AudioState } from './features/voice/AudioCoordinator';

import { ClassroomController, type ClassroomState, type LessonMode, type LessonUnit } from './features/classroom/ClassroomController';
import ClassroomControls from './features/classroom/ClassroomControls';
import ReadingCorrectionDialog from './features/classroom/ReadingCorrectionDialog';
import LearningRecordsPanel from './features/settings/LearningRecordsPanel';
import DesktopSettingsPanel from './features/settings/DesktopSettingsPanel';
import type { DesktopSettings } from '../../../packages/shared/desktop';
import VoiceQuestionInput from './features/voice/VoiceQuestionInput';
import { RealtimeController, initialRealtime, type RealtimeState } from './features/realtime/RealtimeController';
import RealtimePanel from './features/realtime/RealtimePanel';
import type { RealtimeContext } from './features/realtime/tools';
import { textVersion } from './features/voice/sentences';
import type { LearningRecord } from '../../../packages/shared/learning';
import { loadRecord, saveRecord } from './features/library/storage';
import { readRecovery, writeRecovery, clearRecovery } from './features/library/recovery';

type SpeechSettings = NonNullable<AppConfig['speech']> & { engine?: SpeechEngine; ready?: boolean };
function speechEngine(config: AppConfig | null): SpeechEngine {
  return (config?.speech as SpeechSettings | undefined)?.engine ?? (config?.mode === 'demo' ? 'system' : 'openai');
}
function speechPlaybackMode(config: AppConfig | null): 'demo' | 'live' {
  return speechEngine(config) === 'system' ? 'demo' : 'live';
}
function canPlaySpeech(config: AppConfig | null): boolean {
  if (!config) return false;
  const engine = speechEngine(config);
  if (engine === 'local') return (config.speech as SpeechSettings | undefined)?.ready === true;
  if (engine === 'system') return true;
  return config.mode === 'live' && !!config.models.tts && !['unconfigured', 'unsupported'].includes(config.capabilities.tts);
}
function speechUnavailableMessage(config: AppConfig | null): string {
  return speechEngine(config) === 'local' ? '本地语音模型尚未就绪，请先安装项目提供的本地语音模型包。不会自动改用付费语音。' : '声音尚未配置。请在声音设置中选择免费本地朗读、系统基本语音或配置 OpenAI 朗读。';
}
function isLocalUsage(usage: UsageRecord): boolean { return 'local' in usage && usage.local === true; }
type Message = { id: string; role: 'user' | 'assistant'; text: string; demo?: boolean; delivery?:'text'|'spoken'|'interrupted'|'unconfirmed' };
export default function App() {
  const [config,setConfig]=useState<AppConfig|null>(null);
  const audioEngine=speechEngine(config);
  const speechAvailable=canPlaySpeech(config);
  const voiceLabel=audioEngine==='local'?(speechAvailable?'免费本地 AI 合成语音':'本地 AI 语音 · 模型未就绪'):audioEngine==='system'?'系统基本语音 · 免费':speechAvailable?'OpenAI AI 合成语音 · API 计费':'OpenAI 声音未配置';
  const desktopBridge=window.desktopTeacher;
  const [desktopSettings,setDesktopSettings]=useState<DesktopSettings|null>(null);
  const chatgptMode=(config as (AppConfig & {authMode?:string})|null)?.authMode==='chatgpt';
  useEffect(()=>{let active=true;if(desktopBridge)void desktopBridge.getSettings().then(value=>{if(active)setDesktopSettings(value);}).catch(()=>{});return()=>{active=false;};},[desktopBridge]);
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
  const realtime=useRef<RealtimeController|null>(null);
  const [realtimeState,setRealtimeState]=useState<RealtimeState>(initialRealtime);
  const realtimeContext=useRef<RealtimeContext|null>(null);
  const [realtimeReveal,setRealtimeReveal]=useState<Record<string,number>>({});
  const entriesRef=useRef<BoardEntry[]>([]);
  const rateRef=useRef(1);const volumeRef=useRef(0.8);
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
  const [featureGuide,setFeatureGuide]=useState(false);
  const [practice,setPractice]=useState(false);
  const [practiceSession,setPracticeSession]=useState(0);
  const [readerAction,setReaderAction]=useState<ReaderAction>();
  const [classroomOpen,setClassroomOpen]=useState(0);
  const [realtimeOpen,setRealtimeOpen]=useState(0);
  const optionalVoice=useRef<HTMLDetailsElement>(null);
  const [chatVisible,setChatVisible]=useState(true);
  useEffect(()=>{if(chatVisible&&realtimeOpen&&optionalVoice.current)optionalVoice.current.open=true;},[chatVisible,realtimeOpen]);
  const [audioState,setAudioState]=useState<AudioState|null>(null);
  const [rate,setRate]=useState(()=>{try{const saved=Number(localStorage.getItem('pdf-ai-teacher:speech-rate'));return [0.25,0.35,0.5,0.6,0.75,1,1.25,1.5].includes(saved)?saved:1;}catch{return 1;}});
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
  useEffect(()=>{try{localStorage.setItem('pdf-ai-teacher:speech-rate',String(rate));}catch{/* Playback remains usable if preferences cannot be saved. */}},[rate]);
  useEffect(()=>{
    if(!config)return;
    const client=apiClient(config);
    const controller=new AudioCoordinator({...(speechEngine(config)==='local'?{generatedSpeechRate:1,prefetchLocalSpeech:true}:{}),requestSpeech:client.speech,onChange:setAudioState,onError:message=>{classroom.current?.interrupt();setError(message);},onComplete:event=>classroom.current?.onComplete(event)});
    audio.current=controller;controller.setRate(rateRef.current);controller.setVolume(volumeRef.current);setAudioState(controller.getSnapshot());
    return ()=>{controller.dispose();audio.current=null;};
  },[config]);
  useEffect(()=>{
    if(!settings||!config)return;
    const controller=new AbortController();
    void fetch('/api/usage',{signal:controller.signal}).then(response=>{if(!response.ok)throw new Error('用量暂时无法读取，请重新打开设置。');return response.json();}).then(data=>{setUsage(data.records);setUsageSummary(data);}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>controller.abort();
  },[settings,config]);
  const cancel=useCallback((change=false,keepLesson=false,keepInput=false,keepRealtime=false)=>{
    if(!keepRealtime){if(change)realtime.current?.stop('学习目标变化，实时会话已结束。重新选择后可手动连接。');else realtime.current?.interrupt();}
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
      begin:()=>{cancel(false,true);return {envelope:guard.current.current(),mode:speechPlaybackMode(config)};},
      generate:(source,envelope)=>askRef.current('请围绕本段进行一次简短教学：解释必要符号和原理，按需给出推导与小例子，最后留一个检查问题。',source,envelope),
      showStep:(entry,index)=>flushSync(()=>{setBoardHidden(false);setActiveEntryId(entry.id);setActiveStep(index);setRealtimeReveal(previous=>previous[entry.id]===undefined?previous:{...previous,[entry.id]:Math.max(previous[entry.id],index)});}),
      onChange:setLesson,onError:setError,
    });
    classroom.current=controller;setLesson(controller.getSnapshot());
    return()=>{controller.reset();classroom.current=null;};
  },[config,cancel]);
  useEffect(()=>{
    if(!config)return;
    const controller=new RealtimeController({
      config,current:()=>guard.current.current(),begin:()=>{cancel(false,false,false,true);const source=realtimeContext.current?.context.sources[0];if(source){contextRef.current=structuredClone(source);setLocked(structuredClone(source));}return guard.current.current();},
      context:()=>realtimeContext.current?structuredClone(realtimeContext.current):null,
      onChange:setRealtimeState,pauseLocal:()=>audio.current?.pause(),
      claimOutput:stop=>{if(!audio.current)throw Error('声音控制器尚未就绪。');return audio.current.claimExternalOutput(stop);},
      onMessage:(role,text,delivery)=>setMessages(previous=>[...previous,{id:crypto.randomUUID(),role,text,delivery}]),
      tools:{
        present:async(plan,valid)=>{
          if(!valid()||!realtimeContext.current)throw Error('旧教案已取消。');
          const entry:BoardEntry={id:crypto.randomUUID(),plan,context:structuredClone(realtimeContext.current.context),mode:'live'};
          flushSync(()=>{if(!valid())return;setEntries(previous=>[...previous,entry]);setBoardHidden(false);setActiveEntryId(entry.id);setActiveStep(0);setRealtimeReveal(previous=>({...previous,[entry.id]:0}));});
          if(['idle','complete'].includes(classroom.current?.getSnapshot().phase??'idle')&&plan.steps.length)classroom.current?.restore(entry,0,[]);
          return {entryId:entry.id};
        },
        focus:async(entryId,stepId,valid)=>{
          const entry=entriesRef.current.find(item=>item.id===entryId);const index=entry?.plan.steps.findIndex(step=>step.stepId===stepId)??-1;
          if(!valid()||!entry||index<0)throw Error('板书目标不存在或已变化，请澄清。');
          flushSync(()=>{if(valid()){setBoardHidden(false);setActiveEntryId(entryId);setActiveStep(index);}});
          const previous=classroom.current?.getSnapshot();if(previous?.entry?.id===entryId)classroom.current?.restore(entry,index,previous.completedStepIds);
          return {stepIndex:index,speechText:entry.plan.steps[index].speechText,plan:entry.plan};
        },
        control:async(action,valid)=>{
          if(!valid())throw Error('旧阅读操作已取消。');
          if(action==='pause'){audio.current?.pause();return;}
          if(action==='resume_source'){
            if(!audio.current?.getBookmark())throw Error('还没有原文书签，请先选段朗读。');
            classroom.current?.reset();void audio.current.resumeSource(guard.current.current(),speechPlaybackMode(config)).catch(error=>setError(error.message));return;
          }
          if(action==='continue_teaching'){if(!realtime.current?.getSnapshot().canContinue)throw Error('没有可继续的实时教学步骤，请指定要讲的内容。');return;}
          const next=Math.max(MIN_SPEECH_RATE,rateRef.current-0.25);setRate(next);audio.current?.setRate(next);
        },
      },
      showStep:async(entryId,index,valid)=>{
        const entry=entriesRef.current.find(item=>item.id===entryId);if(!valid()||!entry?.plan.steps[index])throw Error('教学步骤已失效。');
        flushSync(()=>{if(valid()){setBoardHidden(false);setActiveEntryId(entryId);setActiveStep(index);setRealtimeReveal(previous=>({...previous,[entryId]:index}));}});
        const previous=classroom.current?.getSnapshot();if(previous?.entry?.id===entryId)classroom.current?.restore(entry,index,previous.completedStepIds);
      },
      rate:()=>rateRef.current,volume:()=>volumeRef.current,
      onStepComplete:(entryId,index)=>classroom.current?.confirmExternalStep(entryId,index),
    });
    realtime.current=controller;return()=>{controller.stop();if(realtime.current===controller)realtime.current=null;};
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
      if(questionDialog||correctionOpen||featureGuide)return;
      if(documentRecord||target||locked||boardTarget){event.preventDefault();clearSelection();}
    };
    window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);
  },[settings,questionDialog,correctionOpen,featureGuide,documentRecord,target,locked,boardTarget,clearSelection]);
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
    setDocument(value);setTarget(null);setLocked(null);contextRef.current=null;setBoardTarget(null);setEntries([]);setRealtimeReveal({});setMessages([]);setQuestion('');setPageIndex(0);currentPage.current=0;setError('');
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
  entriesRef.current=entries;rateRef.current=rate;volumeRef.current=volume;
  if(effective){
    const context=snapshot(effective,boardTarget?.text??null);const displayed=boardHidden?[]:entries.filter(entry=>entry.id===(activeEntryId??entries.at(-1)?.id));
    const sources=new Map(context.sources.map(source=>[source.sourceId,source]));
    for(const entry of displayed)for(const source of entry.context.sources)if(source.documentId===context.documentId&&sources.size<8)sources.set(source.sourceId,source);
    if([...sources.values()].reduce((sum,source)=>sum+source.sourceText.length,0)<=24000)context.sources=[...sources.values()];
    const allowed=new Set(context.sources.map(source=>source.sourceId));
    realtimeContext.current={context,board:displayed.flatMap(entry=>entry.plan.steps.slice(0,(realtimeReveal[entry.id]??(lesson?.entry?.id===entry.id?lesson.stepIndex:entry.plan.steps.length-1))+1).filter(step=>step.sourceIds.every(id=>allowed.has(id))).map((step,index)=>({entryId:entry.id,stepId:step.stepId,title:step.title,number:index+1,summary:[step.explanationMarkdown,...step.boardBlocks.map(block=>block.type==='math'?block.latex:block.type==='text'?block.markdown:'')].join('\n').slice(0,1600),sourceIds:step.sourceIds}))).slice(-12)};
  }else realtimeContext.current=null;
  const ask=async(text=question,overrideTarget?:PdfTarget,providedEnvelope?:Envelope):Promise<BoardEntry|null>=>{
    if(desktopSettings?.restartRequired){setError('账号或模型设置等待应用，请在设置中点击「应用并重启」后继续提问。');setSettings(true);return null;}
    const source=overrideTarget??effective;
    if(!text.trim())return null;
    if(!config){setError('请先连接本地服务。');return null;}
    if(!source){setError('你想了解哪一段？请在 PDF 中选中文字或框选一个公式。');return null;}
    if(config.mode==='unconfigured'){setError('真实模型未配置。请在本机 .env 配置，或启用 DEMO_MODE=true。');return null;}
    if(!providedEnvelope&&!overrideTarget&&realtime.current?.isLive()){setQuestion('');try{await realtime.current.ask(text.trim());}catch(error){setError((error as Error).message);}return null;}
    if(!providedEnvelope)cancel();setError('');
    const envelope=providedEnvelope??guard.current.current();
    const context=snapshot(source,overrideTarget?null:boardTarget?.text??null);
    contextRef.current=structuredClone(source);setLocked(structuredClone(source));
    const controller=new AbortController();request.current=controller;setBusy(true);
    const submitted=text.trim();if(!overrideTarget)setQuestion('');
    const history=messages.filter(message=>!['interrupted','unconfirmed'].includes(message.delivery??'')).slice(-6).map(m=>({role:m.role,text:m.text.slice(0,4000)}));
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
    if(!canPlaySpeech(config)){setError(speechUnavailableMessage(config));return;}
    cancel();setError('');setLocked(structuredClone(effective));
    classroom.current?.reset();audio.current?.load(readingTarget!,guard.current.current(),speechPlaybackMode(config));
    audio.current?.setRate(rate);audio.current?.setVolume(volume);
    try{await audio.current?.play();}catch(e){setError((e as Error).message);}
  };
  const resume=async()=>{setError('');try{if(classroom.current?.getSnapshot().phase==='interrupted'){await classroom.current.continue();return;}if(audioState?.status!=='paused'){cancel();audio.current?.rebind(guard.current.current());}await audio.current?.resume();}catch(e){setError((e as Error).message);}};
  const resumeOriginal=async()=>{
    if(!config||!audio.current?.getBookmark())return;
    cancel();classroom.current?.reset();setError('');
    await audio.current.resumeSource(guard.current.current(),speechPlaybackMode(config));
  };
  const selectBoard=(step:TeachingStep,entry:BoardEntry)=>{cancel(true);setFormulaConfirmed(false);const source=entry.context.sources.find(s=>step.sourceIds.includes(s.sourceId))??entry.context.sources[0];setBoardTarget({text:`${step.title}\n${step.explanationMarkdown}\n${step.boardBlocks.map(b=>b.type==='math'?b.latex:b.type==='text'?b.markdown:b.type==='callout'?b.text:JSON.stringify('rows' in b?b.rows:b)).join('\n')}`,target:source});setQuestion(`请解释“${step.title}”这一步。`);};
  const startLesson=async(mode=lessonMode)=>{
    if(!readingTarget?.sourceText.trim()||!config){setError('请先选择原文。');return;}
    if(!canPlaySpeech(config)){setError(speechUnavailableMessage(config));return;}
    if(mode!=='read'&&config.mode==='unconfigured'){setError('解题模型尚未配置。可以选择「只朗读」，使用免费本地声音。');return;}
    if(requiresFormulaConfirmation(readingTarget.sourceText)&&!formulaConfirmed){setError('请先核对公式，或使用校对朗读文本。');return;}
    setError('');setLocked(structuredClone(readingTarget));audio.current?.setRate(rate);audio.current?.setVolume(volume);
    try{await classroom.current?.start(readingTarget,mode,lessonUnit);}catch(error){setError((error as Error).message);}
  };
  const speakStep=(_step:TeachingStep,entry:BoardEntry,index:number,restart=false)=>{
    if(!canPlaySpeech(config)){setError(speechUnavailableMessage(config));return;}
    cancel();setError('');if(restart)audio.current?.loadExplanation(entry.context.sources[0],entry.plan.steps[index],guard.current.current(),speechPlaybackMode(config),true);setClassroomOpen(value=>value+1);classroom.current?.restore(entry,index,[]);void classroom.current?.continue().catch(error=>setError(error.message));
  };
  const showMicrophone=()=>{setFeatureGuide(false);setChatVisible(true);if(optionalVoice.current)optionalVoice.current.open=true;setRealtimeOpen(value=>value+1);setVoiceRevision(value=>value+1);void realtime.current?.start('local');};
  const focusQuestion=()=>{setFeatureGuide(false);setChatVisible(true);setTimeout(()=>document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),0);};
  const beginPractice=()=>{setFeatureGuide(false);cancel();classroom.current?.reset();setPracticeSession(value=>value+1);setPractice(true);if(!documentRecord)setReaderAction({type:'open-sample',nonce:Date.now()});};
  const directLesson=(mode:LessonMode)=>{setFeatureGuide(false);setPractice(false);setClassroomOpen(value=>value+1);setLessonMode(mode);void startLesson(mode);};
  const applyRecord=useCallback((record:LearningRecord)=>{
    if(latestDocument.current!==record.document.documentId)return;
    clearSelection();audio.current?.reset();setTarget(record.target);setLocked(null);lastTargetId.current=record.target?.sourceId??null;contextRef.current=record.target;
    setBoardTarget(null);setBoardHidden(false);setCorrection(null);setMessages(record.messages);setEntries(record.entries);setActiveStep(record.activeStep);setActiveEntryId(record.activeEntryId??record.entries.at(-1)?.id??null);
    setNote(record.note);setLessonMode(record.preferences.mode);setLessonUnit(record.preferences.unit);setAutoResume(record.preferences.autoResume);
    setNavigation({pageIndex:record.pageIndex,rect:record.target?.pageIndex===record.pageIndex?record.target.rect??undefined:undefined,nonce:Date.now()});
    currentPage.current=record.pageIndex;setPageIndex(record.pageIndex);
    if(record.readingBookmark)audio.current?.restoreBookmark(record.readingBookmark,guard.current.current(),speechPlaybackMode(configRef.current));
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
    if(recordReady!==documentRecord?.documentId||!persistenceEnabled){persistLatest.current=null;if(autosaveTimer.current)clearTimeout(autosaveTimer.current);return;}
    const record=buildRecord();persistLatest.current=record;if(!record)return;
    const identity=JSON.stringify({...record,updatedAt:''});if(identity===savedIdentity.current)return;
    try{writeRecovery(record);}catch(error){setError((error as Error).message);setStorageNotice('恢复快照未保存，正在尝试主库；请等保存结束再关闭或先导出。');}
    if(autosaveTimer.current)clearTimeout(autosaveTimer.current);savedIdentity.current=identity;
    autosaveTimer.current=setTimeout(()=>{void queueSave(record).catch(error=>{savedIdentity.current='';setPersistenceEnabled(false);setError(error.message);setStorageNotice('自动保存失败，当前内容仍在内存，请导出后清理空间。');});},180);
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
    <header className="app-header"><div className="brand"><span className="brand-mark"><BookOpen size={23}/></span><div><strong>PDF AI Teacher</strong><span>你的陪读学习工作台</span></div></div><div className="document-title"><span className="small-label">正在阅读</span><strong>{documentRecord?.fileName??'从一本书，一个问题开始'}</strong>{documentRecord&&<span>PDF {pageIndex+1} / {documentRecord.pageCount}</span>}</div><div className="header-actions">{desktopBridge&&<button className="desktop-account-entry" onClick={()=>setSettings(true)}>{desktopSettings?.auth.status==='signed_in'?'ChatGPT 账号设置':'登录 ChatGPT'}{desktopSettings?.restartRequired?' · 待应用':''}</button>}<button className="feature-entry" disabled={!!documentRecord&&recordReady!==documentRecord.documentId} onClick={()=>setFeatureGuide(true)}><BookOpen size={15}/>功能体验</button>{['connecting','connected'].includes(realtimeState.connection)&&<button className="microphone-chip" onClick={()=>realtime.current?.stop()}>{realtimeState.connection==='connecting'?'语音准备中 · 点击取消':'麦克风开启 · 点击关闭'}</button>}<span className={`mode-badge ${config?.mode==='live'?'live':''}`}><i/>{config?.mode==='demo'?(audioEngine==='local'?'演示模式 · 解题 AI 未连接':'演示模式 · AI 未连接'):config?.mode==='live'?(chatgptMode?'ChatGPT 账号 · 能力待验':'API 模式 · 能力待验'):'模型未配置'}</span><button className="icon-button" title="设置与用量" aria-label="设置与用量" disabled={!!documentRecord&&recordReady!==documentRecord.documentId} onClick={()=>setSettings(true)}><Settings2 size={19}/></button></div></header>
    <div className="session-toolbar"><div className="session-label"><span className="green-dot"/>学习空间 <span className="divider">/</span><span>选一段 · 听一段 · 慢慢讲</span>{documentRecord&&!persistenceEnabled&&<button className="text-button" onClick={()=>setSettings(true)}>自动保存已暂停 · 查看原因</button>}</div><div className="toolbar-actions"><span className="locked-indicator"><LockKeyhole size={13}/>{locked?`讲解锁定 · PDF 第 ${locked.pageIndex+1} 页`:'等待选择学习目标'}</span><button className="text-button" onClick={()=>{const next=!follow;setFollow(next);followRef.current=next;cancel(true);if(next){clearSelection();audio.current?.reset();}}}>{follow?'跟随当前页 ✓':'切换为跟随当前页'}</button><button className="icon-button" aria-label="展开或折叠对话" onClick={()=>setChatVisible(!chatVisible)}><PanelRightClose size={17}/></button></div></div>
    {desktopSettings?.restartRequired&&<div className="desktop-pending-banner" role="status"><span>账号或模型设置等待应用，请重启软件后继续 AI 问答。已保存的学习记录保留。</span><button className="text-button" onClick={()=>setSettings(true)}>打开设置并应用</button></div>}
    {error&&<div className="error-banner" role="alert"><span>{error}</span><div>{!config&&<button onClick={()=>void connect()}><RefreshCw size={14}/>重新连接</button>}<button aria-label="关闭提示" onClick={()=>setError('')}><X size={16}/></button></div></div>}
    {practice&&<PracticeCoach key={practiceSession} target={readingTarget} audio={audioState} hasDocument={!!documentRecord} loading={!!documentRecord&&recordReady!==documentRecord.documentId} demo={config?.mode==='demo'} speechEngine={audioEngine} onChoose={()=>setReaderAction({type:'select-excerpt',nonce:Date.now()})} onRead={()=>void read()} onPause={()=>audio.current?.pause()} onResume={()=>void resume()} onClose={()=>setPractice(false)} onMore={()=>{setPractice(false);setFeatureGuide(true);}}/>}
    <main inert={!!documentRecord&&recordReady!==documentRecord.documentId} aria-busy={!!documentRecord&&recordReady!==documentRecord.documentId} ref={workspace} style={chatVisible?{gridTemplateColumns:`minmax(300px,${columns[0]}fr) minmax(310px,${columns[1]}fr) minmax(270px,${100-columns[0]-columns[1]}fr)`}:undefined} className={`workspace ${!chatVisible?'chat-collapsed':''}`}>
      <section className="reader-panel panel" aria-label="PDF 阅读区"><PdfReader action={readerAction} clearSelectionRevision={clearSelectionRevision} onClearSelection={clearSelection} onDocument={handleDocument} onTarget={handleTarget} onPage={handlePage} onError={setError} navigation={navigation} readingText={audioState?.channel==='source'&&audioState.status==='speaking'&&audioState.cursor?.pageIndex===pageIndex&&audioState.cursor?.documentId===documentRecord?.documentId?currentSentence?.sourceText:undefined}/><div className="selection-tray"><div className="selection-title"><span className="eyebrow">{boardTarget?'已选板书步骤':effective?.imageDataUrl?'公式区域预览':effective?'原文选区预览':'你的阅读目标'}</span>{effective&&<span>PDF {effective.pageIndex+1} 页{effective.pageLabel?` · 书面 ${effective.pageLabel}`:''}</span>}</div>{effective?.imageDataUrl?<img className="crop-preview" src={effective.imageDataUrl} alt="即将发送的公式截图"/>:<p className="selection-preview">{boardTarget?.text??effective?.sourceText??'用鼠标选择 PDF 文字，或框选一个想弄懂的公式。'}</p>}<div className="selection-actions"><button className="primary-button" disabled={!effective||busy} onClick={()=>{cancel();setQuestionDialog(true);}}><MessageCircle size={15}/>针对选区提问</button><button className="secondary-button" disabled={!effective?.sourceText} onClick={()=>void read()}><Volume2 size={15}/>朗读所选</button><button className="secondary-button" disabled={!effective?.sourceText||busy} onClick={()=>directLesson('read-explain')}>读并讲</button>{effective&&<button className="text-button clear-selection-button" title="清除选区与提问目标（Esc），保留阅读书签" onClick={clearSelection}><X size={13}/>取消选中 <kbd>Esc</kbd></button>}</div><p className="selection-question-hint">每次可编辑问题，也可以直接在右侧输入。{effective?.sourceText&&<button className="text-button" onClick={()=>{cancel();setCorrectionOpen(true);}}>校对朗读文本</button>}{correction&&<span> · 使用已校对版本</span>}</p><ClassroomControls openNonce={classroomOpen} state={lesson} mode={lessonMode} unit={lessonUnit} disabled={!effective?.sourceText||busy} onMode={value=>{cancel();classroom.current?.reset();setLessonMode(value);}} onUnit={value=>{cancel();classroom.current?.reset();setLessonUnit(value);}} onStart={()=>void startLesson()} onContinue={()=>void classroom.current?.continue().catch(error=>setError(error.message))} onStop={()=>{cancel();classroom.current?.reset();}}/><label className="formula-confirm">{effective?.sourceText && requiresFormulaConfirmation(effective.sourceText) && <><input type="checkbox" checked={formulaConfirmed} onChange={e=>setFormulaConfirmed(e.target.checked)}/>已对照原页核对公式，按预览原文朗读</>}</label><p className="privacy-hint">{config?.mode==='demo'?(audioEngine==='openai'?'演示问答不调用解题模型；主动朗读会将所选文字发给 OpenAI。':'演示问答：内容留在本机，不调用在线模型。'):effective?.imageDataUrl?'发送问题时：此截图与问题将传给配置的模型服务。':'发送问题时：所选原文、最近 6 条问答（每条最多 4000 字）与问题将传给模型。'}</p></div></section>
      <Blackboard revealLimits={realtimeReveal} activeEntryId={activeEntryId} revealThrough={lesson?.entry?{entryId:lesson.entry.id,index:lesson.stepIndex}:null} onSpeak={speakStep} entries={boardHidden?[]:entries} active={activeStep} setActive={setActiveStep} dark={dark} setDark={setDark} onSelect={selectBoard} onSource={(id,entry)=>{const source=entry.context.sources.find(s=>s.sourceId===id);if(source)setNavigation({pageIndex:source.pageIndex,rect:source.rect??undefined,nonce:Date.now()});}} onClear={()=>{cancel();setBoardHidden(true);setBoardTarget(null);}}/>
      {chatVisible&&<section className="chat-panel panel" aria-label="学习对话"><div className="panel-heading"><div><span className="eyebrow">03 / CONVERSATION</span><h2>一起想明白</h2></div><span className="chat-status">{busy?'正在解答':'文字问答'}</span></div><div className="teaching-route"><div><strong>{realtimeState.mode==='live'&&realtimeState.connection==='connected'?'当前使用实时模型对话':'打字提问 · 看推导 · 听讲解'}</strong><span>解题：{config?.mode==='demo'?'固定演示，AI 未连接':(realtimeState.mode==='live'&&realtimeState.connection==='connected'?config?.models.realtime:effective?.imageDataUrl?config?.models.vision:config?.models.chat)||'未配置'} · 朗读：{voiceLabel}</span></div><button className="text-button" onClick={()=>setSettings(true)}>配置</button></div><div className="conversation-scroll">{!messages.length&&<div className="chat-welcome"><div className="teacher-avatar"><BookOpen size={21}/></div><h3>把不懂的地方，打字问清楚</h3><p>选中教材后输入你的问题。解题模型负责理论、推导和讲解稿；语音模型负责把讲解读给你听。</p><button className="secondary-button welcome-trial" onClick={()=>setFeatureGuide(true)}>带我试用功能</button>{config?.mode==='demo'&&<div className="demo-notice">解题 AI 尚未连接：{audioEngine==='local'?'本地 AI 朗读独立可用，模型就绪后即可免费听书。':'朗读、暂停和续读按所选声音设置使用。'}提问只展示固定教案，连接解题模型后才会理解你的教材。</div>}<span className="small-label">你可以这样问</span><div className="prompt-list">{['这一步为什么成立？','解释每个符号的含义','用一个小数字举例'].map(p=><button key={p} onClick={()=>setQuestion(p)}>{p}<ArrowUp size={13}/></button>)}</div></div>}{messages.map(m=><div className={`message ${m.role}`} key={m.id}><div className="message-label">{m.role==='user'?'你':m.demo?'演示讲解 · 非真实 AI':'AI 老师'}</div>{m.delivery&&<span className="message-delivery">{m.delivery==='spoken'?'实时语音 · 播放完成':m.delivery==='interrupted'?'实时语音已打断 · 转写可能含未播放内容':m.delivery==='unconfirmed'?'实时语音播放未确认':'实时会话输入'}</span>}<p>{m.text}</p>{m.role==='assistant'&&!m.delivery&&entries.find(entry=>entry.id===m.id)&&<AnswerSpeechControls entry={entries.find(entry=>entry.id===m.id)!} lesson={lesson} available={speechAvailable} speechEngine={audioEngine} onListen={()=>{const entry=entries.find(item=>item.id===m.id);if(entry?.plan.steps[0])speakStep(entry.plan.steps[0],entry,0,true);}} onContinue={()=>void classroom.current?.continue().catch(error=>setError(error.message))}/>}</div>)}{busy&&<div className="thinking" role="status"><span className="green-dot"/>正在核对条件、推导并整理板书…<button onClick={()=>cancel()}>取消</button></div>}</div><div className="composer-area">{effective&&<div className="target-chip"><span>{boardTarget?'已选板书':effective.imageDataUrl?'框选区域':'所选文字'} · PDF 第 {effective.pageIndex+1} 页</span><button aria-label="取消提问目标" onClick={clearSelection}><X size={12}/></button></div>}<div className="composer"><textarea aria-label="输入文字问题" placeholder="哪一步还不清楚？" value={question} maxLength={2000} onChange={e=>{cancel();setQuestion(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void ask();}}}/><div className="composer-bottom"><span>Enter 发送 · Shift+Enter 换行</span><button aria-label="发送问题" disabled={!question.trim()||busy} onClick={()=>void ask()}><ArrowUp size={18}/></button></div></div><details className="optional-voice" ref={optionalVoice}><summary>可选：麦克风与实时语音</summary><p>日常理论问题直接打字即可。以下功能只在你主动开启时使用麦克风；开启实时语音后，文字追问也会进入实时模型。</p><RealtimePanel openNonce={realtimeOpen} state={realtimeState} config={config} hasTarget={!!effective} onStart={mode=>{setVoiceRevision(value=>value+1);void realtime.current?.start(mode);}} onStop={()=>realtime.current?.stop()} onInterrupt={()=>{realtime.current?.interrupt();audio.current?.pause();}} onContinue={()=>void realtime.current?.continueTeaching().catch(error=>setError(error.message))}/><VoiceQuestionInput config={config} onStart={()=>{realtime.current?.stop();cancel(false,false,true);return guard.current.current();}} onTranscript={(text,envelope)=>{if(guard.current.accepts(envelope)){setQuestion(text);setError('');}}} onError={setError} resetRevision={voiceRevision} disabled={!effective}/></details><details className="notes"><summary><NotebookPen size={13}/>本书本地笔记</summary><textarea aria-label="本书本地笔记" value={note} disabled={!documentRecord||recordReady!==documentRecord.documentId} onChange={e=>saveNote(e.target.value)} placeholder={desktopBridge?'只保存在本机软件内，不发送给模型':'只保存在当前浏览器，不发送给模型'}/></details></div></section>}
      {chatVisible&&<><div className="column-handle first" style={{left:`calc((100% - 28px) * ${columns[0]/100} + 7px)`}} role="separator" aria-label="调整阅读器宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight")setColumns([Math.max(28,Math.min(48,columns[0]+(e.key==="ArrowRight"?1:-1))),columns[1]]);}} onPointerDown={e=>{e.preventDefault();resizeColumn(0,e.clientX);}}/><div className="column-handle second" style={{left:`calc((100% - 28px) * ${(columns[0]+columns[1])/100} + 21px)`}} role="separator" aria-label="调整黑板宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight")setColumns([columns[0],Math.max(25,Math.min(43,columns[1]+(e.key==="ArrowRight"?1:-1)))]);}} onPointerDown={e=>{e.preventDefault();resizeColumn(1,e.clientX);}}/></>}    </main>
    <footer className="audio-bar" aria-label="朗读控制"><div className="audio-source"><span className={`audio-emblem ${audioState?.status==='speaking'?'playing':''}`}><Volume2 size={20}/></span><div><strong>{audioState?outputLabel[audioState.status as keyof typeof outputLabel]??'待机':'声音待机'}<span className="audio-kind">{voiceLabel}</span></strong><span className="subtitle" data-testid="reading-subtitle">{currentSentence?.sourceText??'选择原文，开启一小段朗读'}</span></div></div><div className="playback-controls"><button className="icon-button" aria-label="上一句" disabled={!audioState?.hasBookmark} onClick={()=>audio.current?.previous()}><SkipBack size={17}/></button><button className="play-button" aria-label={(audioState?.status==='speaking'||audioState?.status==='buffering')?'暂停朗读':'继续朗读'} disabled={!audioState?.hasBookmark} onClick={()=>(audioState?.status==='speaking'||audioState?.status==='buffering')?audio.current?.pause():void resume()}>{(audioState?.status==='speaking'||audioState?.status==='buffering')?<Pause size={18}/>:<Play size={18}/>}</button><button className="icon-button" aria-label="下一句" disabled={!audioState?.hasBookmark} onClick={()=>audio.current?.next()}><SkipForward size={17}/></button><button className="stop-button" onClick={()=>{realtime.current?.stop();cancel();audio.current?.stop();}}><Square size={14}/>停止</button></div><div className="audio-options">{audioState?.channel==='explanation'&&audioState.cursor&&<button className="text-button" onClick={()=>void resumeOriginal()}>回原文继续</button>}<button className="text-button voice-settings-button" disabled={!!documentRecord&&recordReady!==documentRecord.documentId} onClick={()=>setSettings(true)}>声音设置</button><button className="bookmark-button" disabled={!audioState?.cursor} onClick={()=>{const cursor=audioState?.cursor;if(cursor)setNavigation({pageIndex:cursor.pageIndex,nonce:Date.now()});}}><Bookmark size={14}/>阅读位置</button><label title="朗读中改速会从当前句重播；暂停时保持暂停。实时讲解从下一步骤生效。">语速<select aria-label="语速" value={rate} onChange={e=>{const value=Number(e.target.value);setRate(value);audio.current?.setRate(value);}}>{[0.25,0.35,0.5,0.6,0.75,1,1.25,1.5].map(n=><option key={n} value={n}>{n}×</option>)}</select></label><label className="volume-control"><Volume2 size={15}/><input aria-label="音量" type="range" min="0" max="1" step="0.1" value={volume} onChange={e=>{setVolume(Number(e.target.value));audio.current?.setVolume(Number(e.target.value));realtime.current?.setVolume(Number(e.target.value));}}/></label></div></footer>
    {featureGuide&&<FeatureGuide config={config} speechEngine={audioEngine} canRead={speechAvailable} hasDocument={!!documentRecord} hasText={!!effective?.sourceText} hasTarget={!!effective} onClose={()=>setFeatureGuide(false)} onQuestion={focusQuestion} onPractice={beginPractice} onBoard={()=>directLesson('explain')} onMicrophone={showMicrophone} onSettings={()=>{setFeatureGuide(false);setSettings(true);}}/>}
    {questionDialog&&effective&&<SelectionQuestionDialog target={effective} question={question} selectedBoardText={boardTarget?.text} demo={config?.mode==='demo'} onChange={setQuestion} onClose={()=>setQuestionDialog(false)} onSend={()=>{setQuestionDialog(false);void ask();}}/>}
    {correctionOpen&&effective&&<ReadingCorrectionDialog sourceText={correction?.sourceId===effective.sourceId?correction.text:effective.sourceText} onClose={()=>setCorrectionOpen(false)} onSave={text=>{cancel(true);classroom.current?.reset();audio.current?.reset();setCorrection({sourceId:effective.sourceId,text});setFormulaConfirmed(true);setCorrectionOpen(false);}}/>}
    {settings&&<div className="modal-backdrop" onClick={()=>setSettings(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-label="设置与用量" onClick={e=>e.stopPropagation()}><div className="panel-heading"><h2>设置与用量</h2><button className="icon-button" aria-label="关闭设置" onClick={()=>setSettings(false)}><X size={19}/></button></div>{desktopBridge?<DesktopSettingsPanel bridge={desktopBridge} onChange={setDesktopSettings} onBeforeAccountChange={()=>{cancel(true);realtime.current?.stop();audio.current?.stop();}}/>:<p>API Key 只在后端 <code>.env</code> 配置。不要填写到浏览器或聊天中。</p>}<div className="config-card"><strong>{desktopBridge?'本次运行：':''}{config?.mode==='demo'?'DEMO_MODE=true · 本机演示':config?.mode==='live'?(chatgptMode?'ChatGPT 账号模式 · 按账号能力验证':'API 模式 · 按账号能力验证'):'尚未配置真实模型'}</strong><p>文字：{config?.models.chat||'未配置'}<br/>视觉：{config?.models.vision||'未配置'}<br/>朗读：{voiceLabel}<br/>转写：{config?.models.transcription||'未配置'}<br/>Realtime：{config?.models.realtime||'未配置'}<br/>实时输入转写：{config?.realtime?.inputTranscriptionModel||'未配置'}</p>{config?.teaching&&<p className="reasoning-config">文字推理强度：{config.teaching.chatReasoningEffort??'由模型默认设置决定'}<br/>视觉推理强度：{config.teaching.visionReasoningEffort??'由模型默认设置决定'}<br/>回答预算：{config.teaching.maxOutputTokens} tokens（含推理） · 最长等待 {config.teaching.timeoutMs/1000} 秒<br/>按本机配置使用模型，失败不会自动换模型；配置不代表真实接口已验证。</p>}</div><div className="voice-config-card"><strong>解题与朗读分别配置</strong><p>文字和公式问题交给 CHAT_MODEL / VISION_MODEL；讲解稿与板书由同一次解答生成。TTS 只朗读已有稿件，不独立解题。回答下方点「听这次讲解」，也可在黑板点「讲这一步」。</p><p>底部语速最低 0.25×，会记住本机选择。朗读中改速会从当前句重播；暂停时保持暂停。实时讲解在下一步骤应用新速度。</p><p>{audioEngine==='local'?(speechAvailable?'免费本地 AI 合成语音：在本机 CPU 生成，无 API 费用，朗读文本不离开本机。':'本地语音模型尚未就绪，请先安装项目提供的模型包；不会切换到付费语音。'):audioEngine==='system'?'系统基本语音：免费，音色和自然度受 Windows / 浏览器已有声音限制。':speechAvailable?'已配置 OpenAI AI 合成语音，按 API 用量计费；实际连通性和听感需试听验证。':'尚未配置 OpenAI 声音；可选择免费本地或系统语音。文字解答仍可独立使用。'}</p>{config?.speech&&<p>当前音色：{config.speech.voice}；语气：{config.speech.style}。{audioEngine==='openai'&&!config.speech.instructionsSupported&&'当前模型未启用语气指令。'}</p>}{!desktopBridge&&audioEngine==='openai'&&<p>自然朗读可在本机 .env 配置 TTS_MODEL=gpt-4o-mini-tts、TTS_VOICE=marin，并关闭演示模式；语气说明可用 TTS_INSTRUCTIONS 调整。需要自己的 API 权限和额度。</p>}<p>仅用打字提问和朗读，不需要配置转写或 Realtime。高级语音入口已收起，GPT-Live 没有启用。</p><label className="auto-resume-option"><input type="checkbox" checked={autoResume} onChange={event=>setAutoResume(event.target.checked)}/>文字问答完成后自动继续已中断的陪读（默认关闭）</label></div><p>{chatgptMode?'文字与看图解题使用 ChatGPT 账号授权及计划额度。':'在线 API 解题按供应商额度计费，演示问答不调用在线模型。'}{audioEngine==='openai'?'OpenAI 朗读另按 API 用量计费。':'当前朗读免费，不消耗 OpenAI API 额度。'}当前费用：<b>无法估算</b>。本会话请求：{usageSummary?.requestCount??usage.length} / {usageSummary?.maxRequests??config?.maxRequests??100}；文字 {usage.filter(u=>u.category==="text").length} 次、语音 {usage.filter(u=>u.category==="tts").length} 次、转写 {usage.filter(u=>u.category==="transcription").length} 次、实时连接 {usage.filter(u=>u.category==="realtime").length} 次。可取得的输入 / 输出 token：{usage.some(u=>u.inputTokens!==null)?usage.reduce((n,u)=>n+(u.inputTokens??0),0):"未知"} / {usage.some(u=>u.outputTokens!==null)?usage.reduce((n,u)=>n+(u.outputTokens??0),0):"未知"}。</p><p>当前会话音频缓存：{usageSummary?`${usageSummary.cache.entries} 段 / ${(usageSummary.cache.bytes/1024/1024).toFixed(1)} MB`:"未读取"}，后端总上限 {usageSummary?(usageSummary.cache.maxBytes/1024/1024):32} MB。原文不会自动整书上传。学习记录保存在{desktopBridge?'本机软件内':'当前浏览器'}，重新打开同一 PDF 可恢复；音频和原始录音不持久化。</p><button className="secondary-button" onClick={()=>{if(config)void apiClient(config).clearCache().then(()=>{setUsageSummary(prev=>prev?{...prev,cache:{...prev.cache,entries:0,bytes:0}}:null);setError('音频缓存已清除。');}).catch(e=>setError(e.message));}}>清除音频缓存</button><p className="privacy-hint">暂停同一段音频时原位继续；停止或提问后以未完成句的句首续读。复杂公式请先核对提取文本。实时连接最长十分钟、闲置两分钟关闭；结束后手动重连。实际语音效果待真人验收。</p><details className="usage-details"><summary>最近请求与语音用量</summary><table><thead><tr><th>类别 / 模型</th><th>服务端用量</th><th>状态</th></tr></thead><tbody>{usage.slice(-10).reverse().map((item,index)=><tr key={item.requestId+index}><td>{item.category}{isLocalUsage(item)&&' · 本地免费'}<br/>{item.model}<small>{item.requestId}</small></td><td>{isLocalUsage(item)?'本地生成，无 API 用量':item.category==='realtime'?(item.connectionSeconds!=null?item.connectionSeconds.toFixed(1)+' 秒连接（非计费时长）':'连接时长未知'):item.category==='transcription'?(item.audioSeconds!=null?item.audioSeconds+' 秒':'音频时长未知'):(item.inputTokens!=null||item.outputTokens!=null?(item.inputTokens??'?')+' / '+(item.outputTokens??'?')+' tokens':item.characters!=null?item.characters+' 字符':'未知')}</td><td>{isLocalUsage(item)?(item.cancelled?'本地生成已取消 · 免费':'本地生成完成 · 免费'):item.category==='realtime'?(item.upstreamCancellation==='confirmed'?'关闭已确认':item.upstreamCancellation==='unconfirmed'?'关闭未确认，可能仍计费':'连接中，用量未知'):item.cancelled?'已取消，可能已计费':'已完成'}</td></tr>)}</tbody></table></details><LearningRecordsPanel replacing={recordReplacing} onBeforeReplace={suspendSaving} record={buildRecord()} enabled={persistenceEnabled} onEnable={()=>{if(!replacingRecord.current)setPersistenceEnabled(true);}} onImport={record=>{if(documentRecord&&latestDocument.current===record.document.documentId){applyRecord(record);setPersistenceEnabled(true);setRecordReady(documentRecord.documentId);}}} onDelete={deleteCurrentRecord} onError={setError}/><p className="storage-notice" role="status">{storageNotice}</p></section></div>}
  </div>;
}
