import { Mic, MicOff, Square } from 'lucide-react';
import type { AppConfig } from '../../../../../packages/shared/protocol';
import type { RealtimeState } from './RealtimeController';
export default function RealtimePanel({state,config,hasTarget,onStart,onStop,onInterrupt,onContinue}:{state:RealtimeState;config:AppConfig|null;hasTarget:boolean;onStart:(mode:'live'|'local')=>void;onStop:()=>void;onInterrupt:()=>void;onContinue:()=>void}){
  const active=state.connection==='connected'||state.connection==='connecting';
  const available=config?.mode==='live'&&!!config.models.realtime&&!['unconfigured','unsupported'].includes(config.capabilities.realtimeAudio);
  return <details className="realtime-panel"><summary><Mic size={14}/>实时语音 <span className={active?'microphone-active':''}>{active?(state.mode==='local'?'本机演练 · 麦克风开启':'麦克风开启'):available?'可连接 · 待实测':'未配置'}</span></summary><div className="realtime-body">
    <p>{state.mode==='local'&&active?'本机演练只检测声音并暂停朗读；不上传、不转写、不生成 AI 回答。':'OpenAI Realtime · AI 合成声音。开启后，麦克风音频、所选内容与已显示黑板会发送到服务商并产生 API 费用。不是 GPT-Live 接口。'}</p>
    {!available&&<p>需在本机配置 REALTIME_MODEL 和 REALTIME_TRANSCRIPTION_MODEL。文字、TTS 配置不能代替实时语音权限。</p>}
    <div className="realtime-actions">{!active?<><button className="secondary-button" disabled={!available||!hasTarget} onClick={()=>onStart('live')}><Mic size={14}/>开启实时语音</button><button className="text-button" disabled={!hasTarget} onClick={()=>onStart('local')}>本机打断演练</button></>:<><button className="secondary-button" onClick={onStop}><MicOff size={14}/>停止实时会话</button><button className="text-button" onClick={onInterrupt}><Square size={13}/>停止声音</button></>}{active&&state.canContinue&&state.mode==='live'&&<button className="text-button" disabled={state.clearPending} onClick={onContinue}>继续实时讲解</button>}</div>
    {active&&<div className="realtime-status"><meter aria-label="实时麦克风音量" min={0} max={1} value={state.level}/><span>{state.input==='speaking'?'检测到说话':'正在监听'} · {state.output==='thinking'?'准备回答':state.output==='speaking'?'正在播放':'声音停止'} · {state.seconds} 秒</span></div>}
    {state.caption&&<p className="realtime-caption" aria-label="实时转写">{state.caption}</p>}
    {state.responses>0&&<small>本次实时回复 {state.responses} 次 · 服务端已返回 tokens：{state.inputTokens??'未知'} 输入 / {state.outputTokens??'未知'} 输出。费用无法估算。</small>}{state.notice&&<p role="status">{state.notice}</p>}{state.error&&<p role="alert">{state.error}</p>}
    <small>噪声误触后可手动继续原文；更换目标、切换窗口或断线会关闭麦克风。闲置两分钟自动结束，不自动重连。</small>
  </div></details>;
}
