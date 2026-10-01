import { describe, expect, it, vi } from 'vitest';
import { ClassroomController } from '../../apps/web/src/features/classroom/ClassroomController';
import type { AudioCoordinator } from '../../apps/web/src/features/voice/AudioCoordinator';
import type { Envelope, PdfTarget } from '../../packages/shared/protocol';
import type { BoardEntry } from '../../apps/web/src/features/blackboard/Blackboard';
const target:PdfTarget={documentId:'doc',sourceId:'doc:one',blockId:'one',pageIndex:0,pageLabel:null,rect:null,sourceText:'原文第一句。原文第二句。'};
const entry:BoardEntry={id:'lesson',mode:'demo',context:{documentId:'doc',sources:[target],selectedBoardText:null,imageDataUrl:null},plan:{schemaVersion:'1',contextRevision:0,answer:'answer',needsClarification:false,clarificationQuestion:null,checkQuestion:'检查题',steps:['one','two'].map(id=>({stepId:id,title:id,speechText:'讲解'+id,explanationMarkdown:id,boardBlocks:[],sourceIds:[target.sourceId],exampleOrigin:'none'}))}};
function setup(generate=vi.fn(async()=>entry)){
  let envelope:Envelope={sessionId:'s',generationId:0,contextRevision:0};
  const events:string[]=[];
  const audio={load:vi.fn(()=>events.push('source')),play:vi.fn(async()=>{events.push('play');}),loadExplanation:vi.fn(()=>events.push('explanation')),getSnapshot:vi.fn(()=>({channel:'explanation',teachingStepId:'one',hasBookmark:true,sentences:[{sentenceId:'one',sourceText:'原文',speechText:'原文'}]})),getBookmark:vi.fn(()=>null),getExplanationBookmark:vi.fn(()=>null),rebind:vi.fn(),resume:vi.fn(async()=>{}),resumeSource:vi.fn(async()=>{})};
  const controller=new ClassroomController({audio:()=>audio as unknown as AudioCoordinator,begin:()=>({envelope:envelope={...envelope,generationId:envelope.generationId+1},mode:'demo'}),generate,showStep:()=>events.push('board'),onChange:()=>{},onError:()=>{}});
  return {controller,audio,generate,events,envelope:()=>envelope};
}
describe('classroom sequencing',()=>{
  it('先播选中原文，再生成同一教案；板书先出现，每步后等待',async()=>{
    const {controller,audio,generate,events,envelope}=setup();await controller.start(target,'read-explain','selection');
    expect(generate).not.toHaveBeenCalled();expect(events).toEqual(['source','play']);
    controller.onComplete({channel:'source',stepId:null,envelope:envelope()});await vi.waitFor(()=>expect(audio.loadExplanation).toHaveBeenCalledTimes(1));
    expect(events.slice(-3)).toEqual(['board','explanation','play']);
    controller.onComplete({channel:'explanation',stepId:'one',envelope:envelope()});
    expect(controller.getSnapshot().phase).toBe('waiting');expect(audio.loadExplanation).toHaveBeenCalledTimes(1);
    await controller.continue();expect(audio.loadExplanation).toHaveBeenCalledTimes(2);expect(controller.getSnapshot().stepIndex).toBe(1);
  });
  it('原文结束的旧版本回调不得启动问答',async()=>{
    const {controller,generate,envelope}=setup();await controller.start(target,'read-explain','selection');const old=envelope();controller.interrupt();
    controller.onComplete({channel:'source',stepId:null,envelope:old});expect(generate).not.toHaveBeenCalled();
    await controller.continue();controller.onComplete({channel:'source',stepId:null,envelope:old});expect(generate).not.toHaveBeenCalled();
  });
  it('生成中断后迟到教案不得发声或展示步骤',async()=>{
    let resolve!:(value:BoardEntry)=>void;const pending=new Promise<BoardEntry>(r=>{resolve=r;});
    const {controller,audio}=setup(vi.fn(()=>pending));const start=controller.start(target,'explain','selection');
    controller.interrupt();resolve(entry);await start;expect(audio.loadExplanation).not.toHaveBeenCalled();expect(controller.getSnapshot().phase).toBe('interrupted');
  });
  it('恢复记录只保留位置，不自动生成或播放',()=>{
    const {controller,audio,generate}=setup();controller.restore(entry,1,['one']);
    expect(controller.getSnapshot().phase).toBe('interrupted');expect(controller.getSnapshot().stepIndex).toBe(1);expect(audio.play).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();
  });
});

it('重复stepId但speechText不同不得复活旧讲解',async()=>{
  const {controller,audio}=setup();
  const old={target,stepId:'one',speechText:'旧回答的内容',sentenceId:'x',textVersion:'x',sentenceIndex:0};
  audio.getExplanationBookmark.mockImplementation(()=>old as never);
  controller.restore(entry,0,[]);await controller.continue();
  expect(audio.resume).not.toHaveBeenCalled();expect(audio.loadExplanation).toHaveBeenCalled();
});


it('公式全部跳过时只朗读进入等待，不启动空音频或问答',async()=>{
  const {controller,audio,generate}=setup();
  audio.getSnapshot.mockReturnValue({channel:'source',teachingStepId:null,hasBookmark:false,sentences:[]} as never);
  await controller.start({...target,sourceText:'$x=y$'},'read','selection');
  expect(controller.getSnapshot().phase).toBe('waiting');
  expect(audio.play).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();
});

it('读并讲的纯公式单元略过声音，仍以原始公式请求讲解',async()=>{
  const {controller,audio,generate}=setup();
  audio.getSnapshot.mockReturnValue({channel:'source',teachingStepId:null,hasBookmark:false,sentences:[]} as never);
  const formula={...target,sourceText:'$x=y$'};
  await controller.start(formula,'read-explain','selection');
  expect((generate.mock.calls as unknown as [PdfTarget][])[0][0].sourceText).toBe(formula.sourceText);
  expect(audio.loadExplanation).toHaveBeenCalledTimes(1);
  expect(audio.play).toHaveBeenCalledTimes(1);
});


it.each(['read','read-explain'] as const)('restoring an interrupted formula-only %s unit skips empty playback',async(mode)=>{
  const {controller,audio,generate}=setup();
  audio.getSnapshot.mockReturnValue({channel:'source',teachingStepId:null,hasBookmark:false,sentences:[]} as never);
  const formula={...target,sourceText:'$x=y$'};
  controller.restoreProgress({entryId:null,stepIndex:0,completedStepIds:[],interrupted:true,units:[formula],unitIndex:0,mode,phase:'reading'},null);
  await controller.continue();
  if(mode==='read'){
    expect(controller.getSnapshot().phase).toBe('waiting');
    expect(audio.play).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();
  }else{
    expect((generate.mock.calls as unknown as [PdfTarget][])[0][0].sourceText).toBe(formula.sourceText);
    expect(audio.loadExplanation).toHaveBeenCalledTimes(1);expect(audio.play).toHaveBeenCalledTimes(1);
  }
});
