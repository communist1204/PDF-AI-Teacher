import {test,expect} from '@playwright/test';
import {realtimeHarness,openRealtime,mockSourceSpeech} from './realtimeHarness';
type Harness={speech:(text:string,id?:string)=>void;finish:()=>void;sent:Array<{type:string;response?:{output_modalities:string[]};item?:{type:string}}> ;ackBoardCounts:number[];input:MediaStream;peer:RTCPeerConnection;holdTools:boolean;held:(()=>void)|null;clearDelay:number;dropClear:boolean;emit:(value:Record<string,unknown>)=>void};

test('实际本机 WebRTC＋模拟服务：板书成功回执后才请求语音，生成完成不等于播放完成',async({page})=>{
  const service=await realtimeHarness(page);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await openRealtime(page);
  await expect.poll(async()=>page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.peer.connectionState)).toBe('connected');
  await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.speech('为什么 beta 要取 t 次方？'));
  await expect(page.getByTestId('board-step')).toHaveCount(1);await expect(page.locator('.realtime-status')).toContainText('正在播放');
  expect(await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.ackBoardCounts)).toEqual([1]);
  await expect(page.locator('.message.assistant')).toHaveCount(0);
  await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.finish());
  await expect(page.locator('.message.assistant')).toHaveCount(1);await expect(page.locator('.message-delivery').last()).toContainText('播放完成');
  await page.getByRole('button',{name:'继续实时讲解',exact:true}).click();await expect(page.getByTestId('board-step')).toHaveCount(2);
  await page.screenshot({path:'docs/screenshots/m3-realtime.png',fullPage:true});
  await page.getByRole('button',{name:'停止实时会话',exact:true}).click();
  await expect.poll(()=>service.closed).toBe(1);expect(await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.input.getTracks().every(track=>track.readyState==='ended'))).toBe(true);expect(errors).toEqual([]);
});

test('打断等待服务端清除回执，再接同一课堂的文字问题；未播放转写有明确标记',async({page})=>{
  await realtimeHarness(page);await openRealtime(page);await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.speech('讲解当前公式。'));await expect(page.locator('.realtime-status')).toContainText('正在播放');
  await page.evaluate(()=>{(window as unknown as {__rt:Harness}).__rt.clearDelay=800;});
  const prior=await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.sent.filter(event=>event.type==='response.create').length);
  await page.getByRole('textbox',{name:'输入文字问题',exact:true}).fill('再给一个不同数字的例子。');await page.getByRole('button',{name:'发送问题',exact:true}).click();
  expect(await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.sent.filter(event=>event.type==='response.create').length)).toBe(prior);
  await expect(page.locator('.message-delivery')).toContainText(['实时会话输入','实时语音已打断']);
  await expect(page.getByTestId('board-step')).toHaveCount(2);await expect(page.locator('.message.user')).toHaveCount(2);
  const kinds=await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.sent.map(event=>event.type));expect(kinds.indexOf('output_audio_buffer.clear')).toBeGreaterThan(kinds.indexOf('response.cancel'));
});

test('迟到的完整工具回复、旧输入转写不污染新一轮上下文',async({page})=>{
  await realtimeHarness(page);await openRealtime(page);await page.evaluate(()=>{const h=(window as unknown as {__rt:Harness}).__rt;h.holdTools=true;h.speech('先解释原理。','old-input');});
  await expect.poll(async()=>page.evaluate(()=>!!(window as unknown as {__rt:Harness}).__rt.held)).toBe(true);await expect(page.getByTestId('board-step')).toHaveCount(0);
  await page.getByRole('textbox',{name:'输入文字问题',exact:true}).fill('我正在修改问题');
  await page.evaluate(()=>{const h=(window as unknown as {__rt:Harness}).__rt;h.held?.();h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'old-input',transcript:'迟到旧转写'});});
  await page.waitForTimeout(250);await expect(page.getByTestId('board-step')).toHaveCount(0);await expect(page.locator('.message.user')).toHaveCount(1);
  await page.getByRole('button',{name:'取消提问目标',exact:true}).click();await expect(page.locator('.microphone-chip')).toHaveCount(0);expect(await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.input.getTracks()[0].readyState)).toBe('ended');
});

test('服务端清音频超时则关闭设备，不让旧声音复活',async({page})=>{
  const service=await realtimeHarness(page);await openRealtime(page);await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.speech('解释选中内容。'));await expect(page.locator('.realtime-status')).toContainText('正在播放');
  await page.evaluate(()=>{(window as unknown as {__rt:Harness}).__rt.dropClear=true;});await page.locator('.realtime-panel').getByRole('button',{name:'停止声音',exact:true}).click();
  await expect(page.locator('.realtime-body')).toContainText('服务端未确认清除');await expect.poll(()=>service.closed).toBe(1);expect(await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.input.getTracks()[0].readyState)).toBe('ended');
});

test('原文真实播放器与实时音频交接：语音打断后恢复同一句，停止释放输入输出',async({page})=>{
  await realtimeHarness(page);await mockSourceSpeech(page);await openRealtime(page);
  await page.getByRole('button',{name:'朗读所选',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  const first=await page.getByTestId('reading-subtitle').textContent();await page.getByRole('button',{name:'下一句',exact:true}).click();await expect(page.getByTestId('reading-subtitle')).not.toHaveText(first??'');const sentence=await page.getByTestId('reading-subtitle').textContent();
  await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.speech('先解释一下这个权重。'));await expect(page.locator('.realtime-status')).toContainText('正在播放');await expect(page.locator('.audio-source strong')).not.toContainText('正在朗读');
  await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.finish());await expect(page.locator('.realtime-status')).toContainText('声音停止');
  await page.evaluate(()=>{const h=(window as unknown as {__rt:Harness&{action:string}}).__rt;h.action='resume_source';h.speech('懂了，接着读刚才那句。');});
  await expect(page.locator('.audio-source strong')).toContainText('正在朗读');await expect(page.getByTestId('reading-subtitle')).toHaveText(sentence??'');await expect(page.locator('.realtime-status')).toContainText('声音停止');
  await page.getByRole('button',{name:'停止',exact:true}).click();await expect(page.locator('.microphone-chip')).toHaveCount(0);await expect(page.locator('.audio-source strong')).toContainText('待机');
});



test('无 Key 本机演练：真实 AudioContext 检测合成输入并暂停，书签恢复且不上传',async({page})=>{
  await realtimeHarness(page,false);const calls:string[]=[];page.on('request',request=>{if(/\/api\/(realtime\/connect|transcribe|ask|tts)$/.test(new URL(request.url()).pathname))calls.push(request.url());});
  await page.addInitScript(()=>{
    class Utterance{onstart:(()=>void)|null=null;onresume:(()=>void)|null=null;onend:(()=>void)|null=null;constructor(public text:string){}}
    let active:Utterance|null=null;Object.defineProperty(window,'SpeechSynthesisUtterance',{value:Utterance});
    Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[{name:'Mock Chinese',lang:'zh-CN',localService:true}],speak(value:Utterance){active=value;queueMicrotask(()=>value.onstart?.());},pause(){},resume(){active?.onresume?.();},cancel(){active=null;},addEventListener(){},removeEventListener(){}}});
  });
  await openRealtime(page,'local');await expect(page.getByText('演示模式 · AI 未连接',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'朗读所选',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  await page.getByRole('button',{name:'下一句',exact:true}).click();const sentence=await page.getByTestId('reading-subtitle').textContent();
  await page.evaluate(()=>{(window as unknown as {__rt:{gain:GainNode}}).__rt.gain.gain.value=0.1;});
  await expect(page.locator('.realtime-body')).toContainText('检测到声音');await expect(page.locator('.audio-source strong')).not.toContainText('正在朗读');
  await page.evaluate(()=>{(window as unknown as {__rt:{gain:GainNode}}).__rt.gain.gain.value=0;});await expect(page.locator('.realtime-body')).toContainText('演练不识别内容');
  await page.getByRole('button',{name:'继续朗读',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');await expect(page.getByTestId('reading-subtitle')).toHaveText(sentence??'');
  await page.setViewportSize({width:1280,height:720});await page.screenshot({path:'docs/screenshots/m3-local-720.png',fullPage:true});
  await page.getByRole('button',{name:'停止',exact:true}).click();await expect(page.locator('.microphone-chip')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.input.getTracks()[0].readyState)).toBe('ended');expect(calls).toEqual([]);await expect(page.locator('.message.assistant')).toHaveCount(0);
});


test('停止实时会话后切回 TTS 陪读，下一步仍先展示板书再播放',async({page})=>{
  await realtimeHarness(page);await mockSourceSpeech(page);await openRealtime(page);
  await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.speech('先讲第一步。'));await expect(page.locator('.realtime-status')).toContainText('正在播放');await expect(page.getByTestId('board-step')).toHaveCount(1);
  await page.evaluate(()=>(window as unknown as {__rt:Harness}).__rt.finish());await expect(page.locator('.message-delivery').last()).toContainText('播放完成');
  await page.getByRole('button',{name:'停止实时会话',exact:true}).click();await page.locator('.classroom-controls summary').click();
  await page.getByRole('button',{name:'继续陪读',exact:true}).click();await expect(page.getByTestId('board-step')).toHaveCount(2);await expect(page.locator('.active-step')).toContainText('实时步骤 2');await expect(page.locator('.audio-source strong')).toContainText('正在朗读');await expect(page.getByTestId('reading-subtitle')).toContainText('第2步');
  await expect(page.locator('.microphone-chip')).toHaveCount(0);await page.getByRole('button',{name:'停止',exact:true}).click();
});
