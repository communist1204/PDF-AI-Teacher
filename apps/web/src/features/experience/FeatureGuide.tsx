import {useEffect,useRef} from 'react';
import {BookOpen,MessageCircle,Volume2,X} from 'lucide-react';
import { normalizeSpeechEngine, type SpeechEngine } from '../../../../../packages/shared/localSpeech';
import type {AppConfig} from '../../../../../packages/shared/protocol';
type Props={config:AppConfig|null;speechEngine?:SpeechEngine;canRead?:boolean;hasDocument:boolean;hasText:boolean;hasTarget:boolean;onClose:()=>void;onQuestion:()=>void;onPractice:()=>void;onBoard:()=>void;onMicrophone:()=>void;onSettings:()=>void};
export default function FeatureGuide({config,speechEngine,canRead,hasDocument,hasText,hasTarget,onClose,onQuestion,onPractice,onBoard,onMicrophone,onSettings}:Props){
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{dialog.current?.showModal();},[]);
  const demo=config?.mode==='demo';
  const engine=normalizeSpeechEngine(speechEngine);
  const readingAvailable=canRead??false;
  return <dialog ref={dialog} className="feature-guide" aria-labelledby="feature-guide-title" onCancel={event=>{event.preventDefault();onClose();}}>
    <div className="panel-heading"><div><span className="eyebrow">从一个小动作开始</span><h2 id="feature-guide-title">这些功能，现在就能试</h2></div><button className="icon-button" aria-label="关闭功能体验" onClick={onClose}><X size={19}/></button></div>
    <p className="feature-intro">{demo?'当前解题 AI 未连接：PDF 与所选声音独立使用；提问与板书是固定演示。':'先走一遍朗读和续读，再试模型讲解。已配置能力仍需实际连接验证。'}</p>
    <div className="feature-cards">
      <section><MessageCircle size={19}/><div><h3>打字问理论，再听这次讲解</h3><p>选中文字或框选公式，输入你真正想问的问题。解题模型生成答案、推导和讲解稿；回答下方点「听这次讲解」，语音只负责朗读。无需开启麦克风。</p><button className="primary-button" disabled={!hasTarget||!config||config.mode==='unconfigured'} onClick={onQuestion}>去输入我的问题</button>{!hasTarget&&<small>先选中教材内容；也可以从下方练习开始。</small>}</div></section>
      <section><Volume2 size={19}/><div><h3>听一段 → 暂停 → 从原句继续</h3><p>{hasDocument?'使用你当前打开的 PDF，选区保持真实。':'打开本项目自制练习 PDF，不需要准备教材。'}每一步都会告诉你该点哪里，最低可选 0.25×。</p><button className="primary-button" disabled={!readingAvailable} onClick={onPractice}>{hasDocument?'带我试读与续读':'用练习走一遍'}</button><small>{engine==='doubao'?'豆包朗读会发送所选文本给火山引擎，免费试用余额需在官方控制台确认。':engine==='openai'?'OpenAI 朗读会发送所选文本并按 API 用量计费。':'朗读未启用，请先在声音设置配置在线声音。'}</small></div></section>
      <section><BookOpen size={19}/><div><h3>看板书一小步一小步出现</h3><p>{demo?'固定 EMA 教案演示：先出当前公式，再播放讲解，每步等待继续。内容不会随问题改变。':'围绕所选原文生成教案，先展示当前步骤再讲解。问答使用所选账号或 API 额度；声音按所选服务的额度使用。'}</p><button className="secondary-button" disabled={!hasText||!readingAvailable||!config||config.mode==='unconfigured'} onClick={onBoard}>{demo?'试分步板书（固定样例）':'讲解当前选段'}</button>{!hasText&&<small>先在 PDF 中选一段文字，再来试。</small>}</div></section>
    </div>
    <details className="optional-voice guide-microphone"><summary>可选：试麦克风打断</summary><p>麦克风只在本机检测声音。开启后点「朗读所选」，再开口；声音暂停后可手动继续。此演练不转写、不回答问题。</p><button className="secondary-button" disabled={!hasTarget||!hasText||!config||config.mode==='unconfigured'} onClick={onMicrophone}>打开麦克风试打断</button>{!hasText&&<p>先选择可朗读的文字；图片区域不能直接朗读。点击后才申请麦克风。</p>}</details>
    <div className="feature-connection"><strong>{demo?'想让老师真正回答问题？':'连接与用量'}</strong><p>解题模型负责回答，朗读方式独立选择。在线朗读需要对应服务的凭证与可用额度；桌面版可在设置中登录 ChatGPT 用于解题。无需配置实时语音。</p><button className="text-button" onClick={onSettings}>查看连接状态与配置方法</button></div>
  </dialog>;
}
