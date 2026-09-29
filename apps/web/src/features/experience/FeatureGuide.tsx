import {useEffect,useRef} from 'react';
import {BookOpen,Mic,Volume2,X} from 'lucide-react';
import type {AppConfig} from '../../../../../packages/shared/protocol';
type Props={config:AppConfig|null;hasDocument:boolean;hasText:boolean;hasTarget:boolean;onClose:()=>void;onPractice:()=>void;onBoard:()=>void;onMicrophone:()=>void;onSettings:()=>void};
export default function FeatureGuide({config,hasDocument,hasText,hasTarget,onClose,onPractice,onBoard,onMicrophone,onSettings}:Props){
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{dialog.current?.showModal();},[]);
  const demo=config?.mode==='demo';
  return <dialog ref={dialog} className="feature-guide" aria-labelledby="feature-guide-title" onCancel={event=>{event.preventDefault();onClose();}}>
    <div className="panel-heading"><div><span className="eyebrow">从一个小动作开始</span><h2 id="feature-guide-title">这些功能，现在就能试</h2></div><button className="icon-button" aria-label="关闭功能体验" onClick={onClose}><X size={19}/></button></div>
    <p className="feature-intro">{demo?'当前没有连接 AI：PDF、选区、朗读和续读可以真实使用；提问与板书是固定演示。':'先走一遍朗读和续读，再试模型讲解。已配置能力仍需实际连接验证。'}</p>
    <div className="feature-cards">
      <section><Volume2 size={19}/><div><h3>听一段 → 暂停 → 从原句继续</h3><p>{hasDocument?'使用你当前打开的 PDF，选区保持真实。':'打开本项目自制练习 PDF，不需要准备教材。'}每一步都会告诉你该点哪里，最低可选 0.25×。</p><button className="primary-button" disabled={!config||config.mode==='unconfigured'} onClick={onPractice}>{hasDocument?'带我试读与续读':'用练习走一遍'}</button><small>{demo?'本机合成语音，无 API 请求。':'API 模式下朗读会使用配置的 TTS 并产生费用。'}</small></div></section>
      <section><BookOpen size={19}/><div><h3>看板书一小步一小步出现</h3><p>{demo?'固定 EMA 教案演示：先出当前公式，再播放讲解，每步等待继续。内容不会随问题改变。':'围绕所选原文生成教案，先展示当前步骤再讲解。会发送选区并产生模型和 TTS 费用。'}</p><button className="secondary-button" disabled={!hasText||!config||config.mode==='unconfigured'} onClick={onBoard}>{demo?'试分步板书（固定样例）':'讲解当前选段'}</button>{!hasText&&<small>先在 PDF 中选一段文字，再来试。</small>}</div></section>
      <section><Mic size={19}/><div><h3>开口，让正在朗读的声音停下来</h3><p>麦克风只在本机检测声音。开启后点「朗读所选」，再开口；声音暂停后可手动继续。此演练不转写、不回答问题。</p><button className="secondary-button" disabled={!hasTarget||!hasText||!config||config.mode==='unconfigured'} onClick={onMicrophone}>打开麦克风试打断</button>{!hasText&&<small>先选择可朗读的文字；图片区域不能直接朗读。点击后才申请麦克风。</small>}</div></section>
    </div>
    <div className="feature-connection"><strong>{demo?'想让老师真正回答问题？':'连接与用量'}</strong><p>自然 AI 声音、理解教材、语音追问都需要你在本机配置 API。ChatGPT 登录不会自动连接到这个应用。</p><button className="text-button" onClick={onSettings}>查看连接状态与配置方法</button></div>
  </dialog>;
}
