import { describe, it, expect, vi } from 'vitest';
import { AudioCoordinator, type PlaybackInput, type AudioCoordinatorOptions } from '../../apps/web/src/features/voice/AudioCoordinator';
import type { PdfTarget } from '../../packages/shared/protocol';
const target:PdfTarget={sourceId:'source-one',documentId:'book-one',pageIndex:0,pageLabel:null,blockId:'block-one',rect:null,sourceText:''};
const envelope={sessionId:'math-session',generationId:1,contextRevision:1};
function setup(){
 const requestSpeech=vi.fn<AudioCoordinatorOptions['requestSpeech']>(async()=>new Blob(['mock']));const onError=vi.fn();const inputs:PlaybackInput[]=[];
 const create=vi.fn((input:PlaybackInput)=>{inputs.push(input);return {play:async()=>input.onStarted(),pause(){},stop(){},dispose(){},setRate(){},setVolume(){}};});
 const audio=new AudioCoordinator({requestSpeech,onError,onChange:()=>{},playbackAdapter:{create},prefetchLocalSpeech:true,generatedSpeechRate:1});
 return {audio,requestSpeech,onError,create,inputs};
}
describe('formula guard at the single audio owner (mock playback)',()=>{
 it.each(['live','demo'] as const)('blocks unknown LaTeX before either %s speech transport or playback',async mode=>{
  const h=setup();h.audio.load({...target,sourceText:String.raw`$\unknown{x}$`},envelope,mode);await h.audio.play();
  expect(h.requestSpeech).not.toHaveBeenCalled();expect(h.create).not.toHaveBeenCalled();expect(h.onError).toHaveBeenCalledWith(expect.stringContaining('校对'));h.audio.dispose();
 });
 it('does not prefetch the next unclear formula and stops at its source anchor',async()=>{
  const h=setup();h.audio.load({...target,sourceText:'先读普通句子。'+String.raw`$\unknown{x}$`},envelope,'live');await h.audio.play();
  expect(h.requestSpeech).toHaveBeenCalledTimes(1);h.inputs[0].onEnded();await Promise.resolve();
  expect(h.requestSpeech).toHaveBeenCalledTimes(1);expect(h.audio.getSnapshot()).toMatchObject({sentenceIndex:1,status:'silent',error:expect.stringContaining('校对')});h.audio.dispose();
 });
 it('sends a converted fraction while keeping the literal formula for captions',async()=>{
  const sourceText=String.raw`式子为 $\frac{1}{1-\beta^t}$。`;const h=setup();h.audio.load({...target,sourceText},envelope,'live');await h.audio.play();
  expect(h.requestSpeech).toHaveBeenCalledTimes(1);const text=h.requestSpeech.mock.calls[0][0];expect(text).toContain('分子为');expect(text).toContain('贝塔');expect(text).not.toContain('\\frac');expect(h.audio.getSnapshot().sentences[0].sourceText).toBe(sourceText);h.audio.dispose();
 });
});
