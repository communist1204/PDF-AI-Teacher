import { sameEnvelope, type Envelope, type PdfTarget } from '../../../../../packages/shared/protocol';
import type { BoardEntry } from '../blackboard/Blackboard';
import type { AudioCoordinator } from '../voice/AudioCoordinator';
import type { LearningRecord } from '../../../../../packages/shared/learning';
import { createLessonUnits } from '../voice/lessonUnits';

export type LessonMode = 'read' | 'read-explain' | 'explain';
export type LessonUnit = 'sentence' | 'paragraph' | 'selection';
export type ClassroomState = {
  phase: 'idle' | 'reading' | 'generating' | 'explaining' | 'waiting' | 'interrupted' | 'complete';
  mode: LessonMode; units: PdfTarget[]; unitIndex: number; entry: BoardEntry | null;
  stepIndex: number; completedStepIds: string[]; interruptedPhase: 'reading' | 'generating' | 'explaining' | 'waiting';
};
const initial: ClassroomState = { phase:'idle', mode:'read-explain', units:[], unitIndex:0, entry:null, stepIndex:0, completedStepIds:[], interruptedPhase:'reading' };
type Options = {
  audio: () => AudioCoordinator | null;
  begin: () => { envelope: Envelope; mode:'demo'|'live' };
  generate: (target:PdfTarget,envelope:Envelope) => Promise<BoardEntry|null>;
  showStep: (entry:BoardEntry,index:number) => void;
  onChange: (state:ClassroomState) => void;
  onError: (message:string) => void;
};
/** No timer or speculative requests: one chosen unit and one audible teaching step at a time. */
export class ClassroomController {
  private state:ClassroomState=structuredClone(initial);
  private epoch=0;
  private envelope:Envelope|null=null;
  private mode:'demo'|'live'='demo';
  constructor(private options:Options) {}
  getSnapshot(){ return structuredClone(this.state); }
  private emit(){ this.options.onChange(this.getSnapshot()); }
  reset(){ this.epoch++;this.envelope=null;this.state=structuredClone(initial);this.emit(); }
  interrupt(){
    this.epoch++;
    if(['reading','generating','explaining'].includes(this.state.phase)){
      this.state.interruptedPhase=this.state.phase as ClassroomState['interruptedPhase'];
      this.state.phase='interrupted';this.emit();
    }
  }
  async start(target:PdfTarget,mode:LessonMode,unit:LessonUnit){
    this.reset();
    this.state={...structuredClone(initial),mode,units:createLessonUnits(target,unit)};
    if(!this.state.units.length)throw new Error('请先选择可核对的原文。');
    await this.startUnit();
  }
  private begin(){const next=this.options.begin();this.envelope=next.envelope;this.mode=next.mode;return next;}
  private async startUnit(){
    this.state.entry=null;this.state.stepIndex=0;this.state.completedStepIds=[];
    this.begin();
    if(this.state.mode==='explain'){await this.generate();return;}
    this.state.phase='reading';this.emit();
    this.options.audio()?.load(this.state.units[this.state.unitIndex],this.envelope!,this.mode);
    await this.options.audio()?.play();
  }
  private async generate(){
    const token=++this.epoch;
    this.state.phase='generating';this.emit();
    const entry=await this.options.generate(this.state.units[this.state.unitIndex],this.envelope!);
    if(token!==this.epoch)return;
    if(!entry){this.state.phase='interrupted';this.state.interruptedPhase='generating';this.emit();return;}
    this.state.entry=entry;this.state.stepIndex=0;
    if(entry.plan.needsClarification||!entry.plan.steps.length){this.state.phase='waiting';this.emit();return;}
    await this.playStep();
  }
  private async playStep(){
    const entry=this.state.entry;const step=entry?.plan.steps[this.state.stepIndex];
    if(!entry||!step)return;
    this.state.phase='explaining';this.emit();
    this.options.showStep(entry,this.state.stepIndex);
    if(!step.speechText.trim()){this.state.phase='waiting';this.emit();return;}
    // showStep commits React state before onStarted can confirm audible playback.
    this.options.audio()?.loadExplanation(this.state.units[this.state.unitIndex],step,this.envelope!,this.mode);
    await this.options.audio()?.play();
  }
  onComplete(event:{channel:'source'|'explanation';stepId:string|null;envelope:Envelope}){
    if(!this.envelope||!sameEnvelope(event.envelope,this.envelope))return;
    if(event.channel==='source'&&this.state.phase==='reading'){
      if(this.state.mode==='read'){this.state.phase='waiting';this.emit();}
      else void this.generate().catch(error=>this.fail(error));
    }else if(event.channel==='explanation'&&this.state.phase==='explaining'&&event.stepId===this.state.entry?.plan.steps[this.state.stepIndex]?.stepId){
      this.state.completedStepIds=[...new Set([...this.state.completedStepIds,event.stepId])];
      this.state.phase='waiting';this.emit();
    }
  }
  async continue(){
    if(this.state.phase==='interrupted'){
      this.begin();
      const phase=this.state.interruptedPhase;
      if(phase==='generating'){await this.generate();return;}
      if(phase==='explaining'){
        const step=this.state.entry?.plan.steps[this.state.stepIndex];
        const playback=this.options.audio()?.getSnapshot();
        const bookmark=this.options.audio()?.getExplanationBookmark();
        const source=this.state.units[this.state.unitIndex];
        const sameSource=bookmark?.target.documentId===source.documentId&&bookmark?.target.pageIndex===source.pageIndex&&bookmark?.target.sourceId===source.sourceId&&bookmark?.target.blockId===source.blockId&&bookmark?.target.sourceText===source.sourceText;
        if(step&&playback?.channel==='explanation'&&playback.teachingStepId===step.stepId&&playback.hasBookmark&&sameSource&&bookmark?.speechText===step.speechText){
          this.state.phase='explaining';this.emit();this.options.showStep(this.state.entry!,this.state.stepIndex);
          this.options.audio()?.rebind(this.envelope!);await this.options.audio()?.resume();
        }else await this.playStep();
      }else if(phase==='reading'){
        this.state.phase='reading';this.emit();
        const bookmark=this.options.audio()?.getBookmark();
        if(bookmark?.target.sourceId===this.state.units[this.state.unitIndex].sourceId)await this.options.audio()?.resumeSource(this.envelope!,this.mode);
        else {this.options.audio()?.load(this.state.units[this.state.unitIndex],this.envelope!,this.mode);await this.options.audio()?.play();}
      }
      return;
    }
    if(this.state.phase!=='waiting')return;
    const steps=this.state.entry?.plan.steps??[];
    if(this.state.stepIndex+1<steps.length){this.state.stepIndex++;this.begin();await this.playStep();}
    else if(this.state.unitIndex+1<this.state.units.length){this.state.unitIndex++;await this.startUnit();}
    else {this.state.phase='complete';this.emit();}
  }
  restore(entry:BoardEntry,stepIndex:number,completedStepIds:string[]){
    this.reset();
    const source=entry.context.sources[0];
    this.state={...structuredClone(initial),units:[source],entry,stepIndex:Math.min(stepIndex,Math.max(0,entry.plan.steps.length-1)),completedStepIds,phase:'interrupted',interruptedPhase:'explaining'};
    this.emit();
  }
  restoreProgress(progress:NonNullable<LearningRecord['teachingProgress']>,entry:BoardEntry|null){
    this.reset();
    this.state={...structuredClone(initial),units:progress.units,unitIndex:progress.unitIndex,mode:progress.mode,entry,stepIndex:progress.stepIndex,completedStepIds:progress.completedStepIds,phase:progress.phase==='waiting'?'waiting':'interrupted',interruptedPhase:progress.phase};
    this.emit();
  }
  confirmExternalStep(entryId:string,index:number){
    if(this.state.entry?.id!==entryId||this.state.stepIndex!==index)return;
    const step=this.state.entry.plan.steps[index];if(!step)return;
    this.state.completedStepIds=[...new Set([...this.state.completedStepIds,step.stepId])];this.state.phase='waiting';this.emit();
  }
  private fail(error:unknown){this.interrupt();this.options.onError(error instanceof Error?error.message:'陪读暂时中断，请重试。');}
}
