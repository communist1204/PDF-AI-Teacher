import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Settings2, LockKeyhole, ArrowUp, Play, Pause, Square, SkipBack, SkipForward, Volume2, X, Bookmark, PanelRightClose, MessageCircle, RefreshCw, NotebookPen } from 'lucide-react';
import type { AppConfig, DocumentRecord, PdfTarget, TeachingStep, UsageRecord } from '../../../packages/shared/protocol';
import { apiClient, getConfig } from './services/api';
import { SessionGuard, snapshot } from './state/session';
import { PdfReader } from './features/pdf/PdfReader';
import Blackboard, { type BoardEntry } from './features/blackboard/Blackboard';
import { AudioCoordinator, requiresFormulaConfirmation, type AudioState } from './features/voice/AudioCoordinator';

type Message = { id: string; role: 'user' | 'assistant'; text: string; demo?: boolean };
export default function App() {
  const [config,setConfig]=useState<AppConfig|null>(null);
  const [documentRecord,setDocument]=useState<DocumentRecord|null>(null);
  const [target,setTarget]=useState<PdfTarget|null>(null);
  const [locked,setLocked]=useState<PdfTarget|null>(null);
  const [pageIndex,setPageIndex]=useState(0);
  const [follow,setFollow]=useState(false);
  const [question,setQuestion]=useState('');
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
    const controller=new AudioCoordinator({requestSpeech:client.speech,onChange:setAudioState,onError:setError});
    audio.current=controller;setAudioState(controller.getSnapshot());
    return ()=>{controller.dispose();audio.current=null;};
  },[config]);
  useEffect(()=>{
    if(!settings||!config)return;
    const controller=new AbortController();
    void fetch('/api/usage',{signal:controller.signal}).then(response=>{if(!response.ok)throw new Error('用量暂时无法读取，请重新打开设置。');return response.json();}).then(data=>{setUsage(data.records);setUsageSummary(data);}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>controller.abort();
  },[settings,config]);
  const cancel=useCallback((change=false)=>{
    const previous=guard.current.current();request.current?.abort();request.current=null;audio.current?.interrupt();
    guard.current.next(change);setBusy(false);
    if(configRef.current)void apiClient(configRef.current).cancel(previous);
  },[]);
  useEffect(()=>{
    const offline=()=>{cancel();setError('网络已断开，声音已停止。阅读书签仍保留，请连接后手动继续。');};
    window.addEventListener('offline',offline);return()=>window.removeEventListener('offline',offline);
  },[cancel]);
  const handleDocument=useCallback((value:DocumentRecord|null)=>{
    if(value?.documentId===latestDocument.current)return;
    cancel(true);audio.current?.reset();latestDocument.current=value?.documentId??null;lastTargetId.current=null;
    setDocument(value);setTarget(null);setLocked(null);contextRef.current=null;setBoardTarget(null);setEntries([]);setMessages([]);setQuestion('');setPageIndex(0);currentPage.current=0;setError('');
    if(value){try{setNote(localStorage.getItem(`pdf-teacher-note:${value.documentId}`)??'');}catch{setNote('');}}else setNote('');
  },[cancel]);
  const handleTarget=useCallback((value:PdfTarget|null)=>{
    if(value?.sourceId===lastTargetId.current)return;
    lastTargetId.current=value?.sourceId??null;
    if(value){cancel(true);audio.current?.reset();setBoardTarget(null);contextRef.current=value;}
    setTarget(value);setFormulaConfirmed(false);
  },[cancel]);
  const handlePage=useCallback((page:number)=>{
    const previous=currentPage.current;currentPage.current=page;setPageIndex(page);
    if(followRef.current&&previous!==page){cancel(true);audio.current?.reset();setTarget(null);setLocked(null);contextRef.current=null;setBoardTarget(null);lastTargetId.current=null;}
  },[cancel]);
  const effective=boardTarget?.target??target??locked;
  const ask=async(text=question)=>{
    if(!text.trim())return;
    if(!config){setError('请先连接本地服务。');return;}
    if(!effective){setError('你想了解哪一段？请在 PDF 中选中文字或框选一个公式。');return;}
    if(config.mode==='unconfigured'){setError('真实模型未配置。请在本机 .env 配置，或启用 DEMO_MODE=true。');return;}
    cancel();setError('');
    const envelope=guard.current.current();
    const context=snapshot(effective,boardTarget?.text??null);
    contextRef.current=structuredClone(effective);setLocked(structuredClone(effective));
    const controller=new AbortController();request.current=controller;setBusy(true);
    const submitted=text.trim();setQuestion('');
    const history=messages.slice(-6).map(m=>({role:m.role,text:m.text.slice(0,4000)}));
    setMessages(prev=>[...prev,{id:crypto.randomUUID(),role:'user',text:submitted}]);
    try{
      const result=await apiClient(config).ask({...envelope,question:submitted,context,history},controller.signal);
      if(!guard.current.accepts(result))return;
      const entry={id:crypto.randomUUID(),plan:result.plan,context,mode:result.mode};
      setMessages(prev=>[...prev,{id:entry.id,role:'assistant',text:result.plan.needsClarification?[result.plan.answer,result.plan.clarificationQuestion].filter(Boolean).join('\n'):result.plan.answer,demo:result.mode==='demo'}]);
      setEntries(prev=>[...prev,entry]);setActiveStep(0);setUsage(prev=>[...prev,result.usage]);
    }catch(e){if(!controller.signal.aborted&&guard.current.accepts(envelope))setError((e as Error).message);}
    finally{if(guard.current.accepts(envelope)){setBusy(false);request.current=null;}}
  };
  const read=async()=>{
    if(!effective?.sourceText.trim()){setError('请先选择可核对的原文。图片区域没有可靠转写，不能逐字朗读。');return;}
    if(requiresFormulaConfirmation(effective.sourceText)&&!formulaConfirmed){setError('选区含有需要核对的公式。请对照原页核对并勾选确认后再朗读。');return;}
    if(!config||config.mode==='unconfigured'){setError('TTS 未配置。可在 .env 开启演示模式体验浏览器合成语音。');return;}
    cancel();setError('');setLocked(structuredClone(effective));
    audio.current?.load(effective,guard.current.current(),config.mode==='demo'?'demo':'live');
    audio.current?.setRate(rate);audio.current?.setVolume(volume);
    try{await audio.current?.play();}catch(e){setError((e as Error).message);}
  };
  const resume=async()=>{setError('');try{if(audioState?.status!=='paused'){cancel();audio.current?.rebind(guard.current.current());}await audio.current?.resume();}catch(e){setError((e as Error).message);}};
  const selectBoard=(step:TeachingStep,entry:BoardEntry)=>{cancel(true);setFormulaConfirmed(false);const source=entry.context.sources.find(s=>step.sourceIds.includes(s.sourceId))??entry.context.sources[0];setBoardTarget({text:`${step.title}\n${step.explanationMarkdown}\n${step.boardBlocks.map(b=>b.type==='math'?b.latex:b.type==='text'?b.markdown:b.type==='callout'?b.text:JSON.stringify(b.rows)).join('\n')}`,target:source});setQuestion(`请解释“${step.title}”这一步。`);};
  const resizeColumn=(index:number,startX:number)=>{
    const width=workspace.current?.getBoundingClientRect().width??1000;
    const start=[...columns];
    const move=(event:PointerEvent)=>{const delta=(event.clientX-startX)/width*100;setColumns(index===0?[Math.max(28,Math.min(48,start[0]+delta)),start[1]]:[start[0],Math.max(25,Math.min(43,start[1]+delta))]);};
    const done=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',done);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',done,{once:true});
  };
  const currentSentence=audioState?.sentences[audioState.sentenceIndex];
  const outputLabel={silent:'待机',buffering:'准备声音',speaking:'正在朗读',paused:'已暂停'};
  const saveNote=(value:string)=>{setNote(value);if(documentRecord){try{localStorage.setItem(`pdf-teacher-note:${documentRecord.documentId}`,value);}catch{setError('本地笔记存储失败，请复制保留内容。');}}};
  return <div className="app-shell">
    <header className="app-header"><div className="brand"><span className="brand-mark"><BookOpen size={23}/></span><div><strong>PDF AI Teacher</strong><span>你的陪读学习工作台</span></div></div><div className="document-title"><span className="small-label">正在阅读</span><strong>{documentRecord?.fileName??'从一本书，一个问题开始'}</strong>{documentRecord&&<span>PDF {pageIndex+1} / {documentRecord.pageCount}</span>}</div><div className="header-actions"><span className={`mode-badge ${config?.mode==='live'?'live':''}`}><i/>{config?.mode==='demo'?'演示模式 · AI 未连接':config?.mode==='live'?'API 模式 · 能力待验':'模型未配置'}</span><button className="icon-button" title="设置与用量" aria-label="设置与用量" onClick={()=>setSettings(true)}><Settings2 size={19}/></button></div></header>
    <div className="session-toolbar"><div className="session-label"><span className="green-dot"/>学习空间 <span className="divider">/</span><span>M0 · M1 基础工作台</span></div><div className="toolbar-actions"><span className="locked-indicator"><LockKeyhole size={13}/>{locked?`讲解锁定 · PDF 第 ${locked.pageIndex+1} 页`:'等待选择学习目标'}</span><button className="text-button" onClick={()=>{const next=!follow;setFollow(next);followRef.current=next;cancel(true);if(next){setLocked(null);setTarget(null);contextRef.current=null;setBoardTarget(null);audio.current?.reset();}}}>{follow?'跟随当前页 ✓':'切换为跟随当前页'}</button><button className="icon-button" aria-label="展开或折叠对话" onClick={()=>setChatVisible(!chatVisible)}><PanelRightClose size={17}/></button></div></div>
    {error&&<div className="error-banner" role="alert"><span>{error}</span><div>{!config&&<button onClick={()=>void connect()}><RefreshCw size={14}/>重新连接</button>}<button aria-label="关闭提示" onClick={()=>setError('')}><X size={16}/></button></div></div>}
    <main ref={workspace} style={chatVisible?{gridTemplateColumns:`minmax(300px,${columns[0]}fr) minmax(310px,${columns[1]}fr) minmax(270px,${100-columns[0]-columns[1]}fr)`}:undefined} className={`workspace ${!chatVisible?'chat-collapsed':''}`}>
      <section className="reader-panel panel" aria-label="PDF 阅读区"><PdfReader onDocument={handleDocument} onTarget={handleTarget} onPage={handlePage} onError={setError} navigation={navigation} readingText={audioState?.status==='speaking'&&audioState.cursor?.pageIndex===pageIndex&&audioState.cursor?.documentId===documentRecord?.documentId?currentSentence?.sourceText:undefined}/><div className="selection-tray"><div className="selection-title"><span className="eyebrow">{boardTarget?'已选板书步骤':effective?.imageDataUrl?'公式区域预览':effective?'原文选区预览':'你的阅读目标'}</span>{effective&&<span>PDF {effective.pageIndex+1} 页{effective.pageLabel?` · 书面 ${effective.pageLabel}`:''}</span>}</div>{effective?.imageDataUrl?<img className="crop-preview" src={effective.imageDataUrl} alt="即将发送的公式截图"/>:<p className="selection-preview">{boardTarget?.text??effective?.sourceText??'用鼠标选择 PDF 文字，或框选一个想弄懂的公式。'}</p>}<div className="selection-actions"><button className="primary-button" disabled={!effective||busy} onClick={()=>void ask('请围绕所选内容，解释符号、推导和一个小数字例子。')}><MessageCircle size={15}/>讲解这里</button><button className="secondary-button" disabled={!effective?.sourceText} onClick={()=>void read()}><Volume2 size={15}/>朗读所选</button></div><label className="formula-confirm">{effective?.sourceText && requiresFormulaConfirmation(effective.sourceText) && <><input type="checkbox" checked={formulaConfirmed} onChange={e=>setFormulaConfirmed(e.target.checked)}/>已对照原页核对公式，按预览原文朗读</>}</label><p className="privacy-hint">{config?.mode==='demo'?'演示模式：内容留在本机，不调用模型。':effective?.imageDataUrl?'发送问题时：此截图与问题将传给配置的模型服务。':'发送问题时：所选原文、最近 6 条问答（每条最多 4000 字）与问题将传给模型。'}</p></div></section>
      <Blackboard entries={entries} active={activeStep} setActive={setActiveStep} dark={dark} setDark={setDark} onSelect={selectBoard} onSource={(id,entry)=>{const source=entry.context.sources.find(s=>s.sourceId===id);if(source)setNavigation({pageIndex:source.pageIndex,rect:source.rect??undefined,nonce:Date.now()});}} onClear={()=>{setEntries([]);setBoardTarget(null);}}/>
      {chatVisible&&<section className="chat-panel panel" aria-label="学习对话"><div className="panel-heading"><div><span className="eyebrow">03 / CONVERSATION</span><h2>一起想明白</h2></div><span className="chat-status">{busy?'准备教案中':'文字问答'}</span></div><div className="conversation-scroll">{!messages.length&&<div className="chat-welcome"><div className="teacher-avatar"><BookOpen size={21}/></div><h3>今天想弄懂什么？</h3><p>先选中一段原文，我们从一个小问题开始。</p>{config?.mode==='demo'&&<div className="demo-notice">当前为明确演示模式。教案使用自制样例，不代表模型理解了你的教材。</div>}<span className="small-label">你可以这样问</span><div className="prompt-list">{['这一步为什么成立？','解释每个符号的含义','用一个小数字举例'].map(p=><button key={p} onClick={()=>setQuestion(p)}>{p}<ArrowUp size={13}/></button>)}</div></div>}{messages.map(m=><div className={`message ${m.role}`} key={m.id}><div className="message-label">{m.role==='user'?'你':m.demo?'演示讲解 · 非真实 AI':'AI 老师'}</div><p>{m.text}</p></div>)}{busy&&<div className="thinking" role="status"><span className="green-dot"/>正在生成并校验教案…<button onClick={()=>cancel()}>取消</button></div>}</div><div className="composer-area">{boardTarget&&<div className="target-chip">针对已选板书追问<button aria-label="取消板书目标" onClick={()=>setBoardTarget(null)}><X size={12}/></button></div>}<div className="composer"><textarea aria-label="输入文字问题" placeholder="哪一步还不清楚？" value={question} maxLength={2000} onChange={e=>{if(audioState?.status==='speaking'||audioState?.status==='buffering'||busy)cancel();setQuestion(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void ask();}}}/><div className="composer-bottom"><span>Enter 发送 · Shift+Enter 换行</span><button aria-label="发送问题" disabled={!question.trim()||busy} onClick={()=>void ask()}><ArrowUp size={18}/></button></div></div><div className="future-voice">语音提问 M2 · 实时插话 M3，后续开放</div><details className="notes"><summary><NotebookPen size={13}/>本书本地笔记</summary><textarea aria-label="本书本地笔记" value={note} disabled={!documentRecord} onChange={e=>saveNote(e.target.value)} placeholder="只保存在当前浏览器，不发送给模型"/></details></div></section>}
      {chatVisible&&<><div className="column-handle first" style={{left:`calc((100% - 28px) * ${columns[0]/100} + 7px)`}} role="separator" aria-label="调整阅读器宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight")setColumns([Math.max(28,Math.min(48,columns[0]+(e.key==="ArrowRight"?1:-1))),columns[1]]);}} onPointerDown={e=>{e.preventDefault();resizeColumn(0,e.clientX);}}/><div className="column-handle second" style={{left:`calc((100% - 28px) * ${(columns[0]+columns[1])/100} + 21px)`}} role="separator" aria-label="调整黑板宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight")setColumns([columns[0],Math.max(25,Math.min(43,columns[1]+(e.key==="ArrowRight"?1:-1)))]);}} onPointerDown={e=>{e.preventDefault();resizeColumn(1,e.clientX);}}/></>}    </main>
    <footer className="audio-bar" aria-label="朗读控制"><div className="audio-source"><span className={`audio-emblem ${audioState?.status==='speaking'?'playing':''}`}><Volume2 size={20}/></span><div><strong>{audioState?outputLabel[audioState.status as keyof typeof outputLabel]??'待机':'声音待机'}<span className="audio-kind">{config?.mode==='demo'?'浏览器合成声音 · 演示':'AI 合成声音'}</span></strong><span className="subtitle" data-testid="reading-subtitle">{currentSentence?.sourceText??'选择原文，开启一小段朗读'}</span></div></div><div className="playback-controls"><button className="icon-button" aria-label="上一句" disabled={!audioState?.hasBookmark} onClick={()=>audio.current?.previous()}><SkipBack size={17}/></button><button className="play-button" aria-label={(audioState?.status==='speaking'||audioState?.status==='buffering')?'暂停朗读':'继续朗读'} disabled={!audioState?.hasBookmark} onClick={()=>(audioState?.status==='speaking'||audioState?.status==='buffering')?audio.current?.pause():void resume()}>{(audioState?.status==='speaking'||audioState?.status==='buffering')?<Pause size={18}/>:<Play size={18}/>}</button><button className="icon-button" aria-label="下一句" disabled={!audioState?.hasBookmark} onClick={()=>audio.current?.next()}><SkipForward size={17}/></button><button className="stop-button" onClick={()=>{cancel();audio.current?.stop();}}><Square size={14}/>停止</button></div><div className="audio-options"><button className="bookmark-button" disabled={!audioState?.cursor} onClick={()=>{const cursor=audioState?.cursor;if(cursor)setNavigation({pageIndex:cursor.pageIndex,nonce:Date.now()});}}><Bookmark size={14}/>阅读位置</button><label>语速<select aria-label="语速" value={rate} onChange={e=>{const value=Number(e.target.value);setRate(value);audio.current?.setRate(value);}}>{[0.75,1,1.25,1.5].map(n=><option key={n} value={n}>{n}×</option>)}</select></label><label className="volume-control"><Volume2 size={15}/><input aria-label="音量" type="range" min="0" max="1" step="0.1" value={volume} onChange={e=>{setVolume(Number(e.target.value));audio.current?.setVolume(Number(e.target.value));}}/></label></div></footer>
    {settings&&<div className="modal-backdrop" onClick={()=>setSettings(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-label="设置与用量" onClick={e=>e.stopPropagation()}><div className="panel-heading"><h2>设置与用量</h2><button className="icon-button" aria-label="关闭设置" onClick={()=>setSettings(false)}><X size={19}/></button></div><p>API Key 只在后端 <code>.env</code> 配置。不要填写到浏览器或聊天中。</p><div className="config-card"><strong>{config?.mode==='demo'?'DEMO_MODE=true · 本机演示':config?.mode==='live'?'API 模式 · 按账号能力验证':'尚未配置真实模型'}</strong><p>文字：{config?.models.chat||'未配置'}<br/>视觉：{config?.models.vision||'未配置'}<br/>TTS：{config?.models.tts||'未配置'}</p></div><p>真实请求会产生独立 API 费用。当前费用：<b>无法估算</b>。本会话请求：{usageSummary?.requestCount??usage.length} / {usageSummary?.maxRequests??config?.maxRequests??100}；文字 {usage.filter(u=>u.category==="text").length} 次、语音 {usage.filter(u=>u.category==="tts").length} 次。可取得的输入 / 输出 token：{usage.some(u=>u.inputTokens!==null)?usage.reduce((n,u)=>n+(u.inputTokens??0),0):"未知"} / {usage.some(u=>u.outputTokens!==null)?usage.reduce((n,u)=>n+(u.outputTokens??0),0):"未知"}。</p><p>当前会话音频缓存：{usageSummary?`${usageSummary.cache.entries} 段 / ${(usageSummary.cache.bytes/1024/1024).toFixed(1)} MB`:"未读取"}，后端总上限 {usageSummary?(usageSummary.cache.maxBytes/1024/1024):32} MB。原文不会自动整书上传。笔记保存在当前浏览器，刷新后会话与音频不保留。</p><button className="secondary-button" onClick={()=>{if(config)void apiClient(config).clearCache().then(()=>{setUsageSummary(prev=>prev?{...prev,cache:{...prev.cache,entries:0,bytes:0}}:null);setError('音频缓存已清除。');}).catch(e=>setError(e.message));}}>清除音频缓存</button><p className="privacy-hint">暂停同一段音频时原位继续；停止或提问后以未完成句的句首续读。复杂公式请先核对提取文本。M2/M3 功能尚未启用。</p></section></div>}
  </div>;
}
