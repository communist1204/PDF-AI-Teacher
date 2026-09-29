import {useEffect,useRef,useState} from 'react';
import {Check, X} from 'lucide-react';
import type {PdfTarget} from '../../../../../packages/shared/protocol';
import type {AudioState} from '../voice/AudioCoordinator';
type Props={target:PdfTarget|null;audio:AudioState|null;hasDocument:boolean;loading:boolean;demo:boolean;onChoose:()=>void;onRead:()=>void;onPause:()=>void;onResume:()=>void;onClose:()=>void;onMore:()=>void};
type Stage='choose'|'read'|'pause'|'resume'|'done';
export default function PracticeCoach({target,audio,hasDocument,loading,demo,onChoose,onRead,onPause,onResume,onClose,onMore}:Props){
  const [stage,setStage]=useState<Stage>('choose');const [finishedEarly,setFinishedEarly]=useState(false);const source=useRef('');const anchor=useRef('');
  const cursor=audio?.cursor;const identity=cursor?JSON.stringify([cursor.documentId,cursor.pageIndex,cursor.blockId,cursor.sentenceId]):'';
  useEffect(()=>{
    if(!target?.sourceText){source.current='';anchor.current='';setStage('choose');return;}
    if(source.current!==target.sourceId){source.current=target.sourceId;anchor.current='';setFinishedEarly(false);setStage('read');return;}
    const sameSource=cursor?.documentId===target.documentId&&cursor?.pageIndex===target.pageIndex&&cursor?.blockId===target.blockId&&audio?.channel==='source';
    if((stage==='pause'||stage==='resume')&&audio?.channel==='source'&&audio.status==='silent'&&!audio.hasBookmark){anchor.current='';setFinishedEarly(true);setStage('read');return;}
    if(!sameSource)return;
    if(stage==='read'&&audio?.status==='speaking')setStage('pause');
    else if(stage==='pause'&&audio?.hasBookmark&&(audio.status==='paused'||audio.status==='silent')){anchor.current=identity;setStage('resume');}
    else if(stage==='resume'&&audio?.status==='speaking'&&identity===anchor.current)setStage('done');
  },[target,audio,stage,identity,cursor]);
  const content={choose:['1 / 4 · 选一小段',hasDocument?'在 PDF 上拖选文字，或点右侧按钮帮你选一小段；请核对预览。':'正在打开练习 PDF；不会自动发声或连接 AI。'],read:['2 / 4 · 开始听',finishedEarly?'刚才的选段已经读完，还没有完成暂停体验。可以再播一遍，试着在中途暂停。':demo?'这是本机朗读。点右侧开始，底部语速可以调到 0.25×。':'点右侧朗读当前选区。API 模式会发送所选文本生成语音。'],pause:['3 / 4 · 试着暂停','声音已经开始。点暂停，或在右侧打字，观察声音停下、位置保留。'],resume:['4 / 4 · 接着刚才那句','已经停下。点继续，核对底部字幕，应该回到刚才未读完的句子。'],done:['已体验暂停与续读','播放器已从同一句恢复。还可以试分步板书和本机开口打断。']}[stage];
  return <aside className="practice-coach" aria-label="试读与续读引导"><div className="practice-copy" role="status"><strong>{stage==='done'&&<Check size={14}/>} {content[0]}</strong><span>{content[1]}</span></div><div className="practice-actions">{stage==='choose'&&<button className="secondary-button" disabled={loading||!hasDocument} onClick={onChoose}>帮我选一小段</button>}{stage==='read'&&<button className="primary-button" disabled={loading||audio?.status==='buffering'} onClick={onRead}>{audio?.status==='buffering'?'声音准备中…':'开始试读'}</button>}{stage==='pause'&&<button className="secondary-button" onClick={onPause}>暂停试读</button>}{stage==='resume'&&<button className="primary-button" onClick={onResume}>从这里继续</button>}{stage==='done'&&<button className="secondary-button" onClick={onMore}>再试板书和打断</button>}<button className="icon-button" aria-label="关闭试读引导" onClick={onClose}><X size={15}/></button></div></aside>;
}
