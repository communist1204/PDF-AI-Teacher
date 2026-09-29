import { useEffect, useRef, useState } from 'react';
import katex from 'katex';
import Diagram from './Diagram';
import 'katex/dist/katex.min.css';
import { Copy, ArrowUpRight, ChevronLeft, ChevronRight, Moon, Sun, Eraser, BookOpen } from 'lucide-react';
import type { ContextSnapshot, TeachingPlan, TeachingStep } from '../../../../../packages/shared/protocol';

function MathBlock({ latex }: { latex: string }) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => { if (node.current) katex.render(latex, node.current, { displayMode: true, throwOnError: false, trust: false, strict: 'warn', maxExpand: 100, maxSize: 12, output: 'htmlAndMathml' }); }, [latex]);
  return <div ref={node} className="formula" />;
}
export type BoardEntry = { id: string; plan: TeachingPlan; context: ContextSnapshot; mode: 'demo' | 'live' };
export default function Blackboard({ entries, active, setActive, dark, setDark, onSelect, onSource, onClear, activeEntryId, revealThrough, onSpeak }: { entries: BoardEntry[]; active: number; setActive: (n:number)=>void; dark:boolean; setDark:(b:boolean)=>void; onSelect:(step:TeachingStep, entry:BoardEntry)=>void; onSource:(sourceId:string, entry:BoardEntry)=>void; onClear:()=>void; activeEntryId?:string|null; revealThrough?:{entryId:string;index:number}|null; onSpeak?:(step:TeachingStep,entry:BoardEntry,index:number)=>void }) {
  const [copyMessage,setCopyMessage]=useState("");
  const [copyFallback,setCopyFallback]=useState("");
  const copyLatex=async(latex:string)=>{try{await navigator.clipboard.writeText(latex);setCopyMessage("LaTeX 已复制");setCopyFallback("");}catch{setCopyMessage("浏览器无法写入剪贴板，请手动复制下方 LaTeX。");setCopyFallback(latex);}};
  const latest = entries.find(entry=>entry.id===activeEntryId)??entries.at(-1);
  const boardRoot=useRef<HTMLElement>(null);
  useEffect(()=>{boardRoot.current?.querySelector(".active-step")?.scrollIntoView({block:"nearest",behavior:"smooth"});},[active,activeEntryId]);
  return <section ref={boardRoot} className={`board panel ${dark ? 'board-dark' : ''}`} aria-label="教学黑板">
    <div className="panel-heading"><div><span className="eyebrow">02 / BLACKBOARD</span><h2>教学黑板 <span className="count">{entries.reduce((n,e)=>n+e.plan.steps.length,0)}</span></h2></div><div className="icon-group"><button className="icon-button" title="切换黑板主题" aria-label="切换黑板主题" onClick={()=>setDark(!dark)}>{dark?<Sun size={17}/>:<Moon size={17}/>}</button><button className="icon-button" title="清空当前黑板（保留对话）" aria-label="清空当前黑板" onClick={onClear}><Eraser size={17}/></button></div></div>
    <div className="board-content">
      {!latest && <div className="board-empty"><div className="board-grid-icon"><BookOpen size={30}/></div><span className="eyebrow">把一个问题，慢慢讲清楚</span><h3>从你选中的那一段开始</h3><p>在左侧选择原文或框选公式。<br/>提出问题后，推导和例子会留在这里。</p><div className="empty-steps"><span>01 符号</span><span>02 推导</span><span>03 例子</span></div></div>}
      {entries.map((entry,ei)=><div key={entry.id} className="board-answer"><div className="answer-kicker">{entry.mode==='demo'?'演示教案 · 非模型回答':'模型教案'} · 第 {ei+1} 次讲解</div>{entry.plan.steps.slice(0,revealThrough?.entryId===entry.id?revealThrough.index+1:undefined).map((step,si)=><article key={step.stepId} className={`board-step ${entry.id===latest?.id&&si===active?'active-step':''}`} data-testid="board-step"><div className="step-heading"><span className="step-number">{String(si+1).padStart(2,'0')}</span><h3>{step.title}</h3></div><p className="step-explanation">{step.explanationMarkdown}</p>{step.boardBlocks.map(block=><div key={block.id} className="board-block">{block.type==='diagram'&&<Diagram block={block}/>}{block.type==='text'&&<p>{block.markdown}</p>}{block.type==='math'&&<><div className="math-label">{block.label}<button className="icon-button" aria-label="复制 LaTeX" title="复制 LaTeX" onClick={()=>void copyLatex(block.latex)}><Copy size={13}/></button></div><MathBlock latex={block.latex}/></>}{block.type==='callout'&&<aside className={`callout ${block.tone}`}>{block.text}</aside>}{block.type==='table'&&<div className="table-scroll"><table><thead><tr>{block.headers.map((h,i)=><th key={i}>{h}</th>)}</tr></thead><tbody>{block.rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>}</div>)}{step.exampleOrigin==='teacher_created'&&<span className="origin-label">自拟例子 · 非教材原文</span>}<div className="step-actions">{onSpeak&&<button onClick={()=>onSpeak(step,entry,si)}>讲这一步</button>}<button onClick={()=>onSelect(step,entry)}>追问这一步 <ArrowUpRight size={13}/></button>{step.sourceIds.map(id=><button key={id} onClick={()=>onSource(id,entry)}>原文 · PDF { (entry.context.sources.find(s=>s.sourceId===id)?.pageIndex??0)+1 } 页</button>)}</div></article>)}</div>)}
    </div>
    {copyMessage&&<div className="copy-message" role="status">{copyMessage}{copyFallback&&<input aria-label="LaTeX 复制文本" readOnly value={copyFallback}/>}</div>}
    <div className="board-footer"><span>{latest?`当前步骤 ${Math.min(active+1,latest.plan.steps.length)} / ${latest.plan.steps.length}`:'教案与板书共享同一上下文'}</span><div className="icon-group"><button className="icon-button" aria-label="上一步板书" disabled={!latest||active<=0} onClick={()=>setActive(active-1)}><ChevronLeft size={16}/></button><button className="icon-button" aria-label="下一步板书" disabled={!latest||active>=latest.plan.steps.length-1} onClick={()=>setActive(active+1)}><ChevronRight size={16}/></button></div></div>
  </section>;
}
