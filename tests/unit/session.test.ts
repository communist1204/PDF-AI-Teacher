import { describe, it, expect } from 'vitest';
import { SessionGuard, snapshot } from '../../apps/web/src/state/session';
import { validatePlan, type PdfTarget } from '../../packages/shared/protocol';
const target: PdfTarget = { documentId:'book-a',sourceId:'source-a',pageIndex:0,pageLabel:'86',blockId:'b',rect:null,sourceText:'原文' };
describe('课堂上下文',()=>{
  it('快照不随原目标变化，保留独立书面页码',()=>{ const copy={...target};const context=snapshot(copy);copy.sourceText='换页';expect(context.sources[0].sourceText).toBe('原文');expect(context.sources[0].pageLabel).toBe('86'); });
  it('拒绝晚到、新选区、跨会话响应',()=>{const guard=new SessionGuard('a');const first=guard.next(true);expect(guard.accepts(first)).toBe(true);guard.next();expect(guard.accepts(first)).toBe(false);const current=guard.current();expect(guard.accepts({...current,sessionId:'b'})).toBe(false);guard.next(true);expect(guard.current().contextRevision).toBe(2);});
  it('拒绝伪造来源及重复板书步骤',()=>{ const plan={schemaVersion:'1',contextRevision:1,answer:'回答',needsClarification:false,clarificationQuestion:null,steps:[{stepId:'1',title:'标题',explanationMarkdown:'解释',speechText:'解释',boardBlocks:[],sourceIds:['made-up-page'],exampleOrigin:'none'}],checkQuestion:null};expect(()=>validatePlan(plan,snapshot(target),1)).toThrow('来源');plan.steps[0].sourceIds=['source-a'];expect(validatePlan(plan,snapshot(target),1).steps).toHaveLength(1);plan.steps.push(plan.steps[0]);expect(()=>validatePlan(plan,snapshot(target),1)).toThrow(); });
});
