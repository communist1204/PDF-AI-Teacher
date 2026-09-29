import {expect,type Page} from '@playwright/test';
export async function realtimeHarness(page:Page,live=true){
  const connections:{closed:number;opened:number}={closed:0,opened:0};
  await page.addInitScript(()=>{
    type Data={sent:Record<string,unknown>[];peer:RTCPeerConnection|null;channel:RTCDataChannel|null;input:MediaStream|null;gain:GainNode|null;audioContext:AudioContext|null;context:{contextRevision:number;authorizedContext:{documentId:string;sources:Array<{sourceId:string}>}}|null;lastAudio:string;next:number;action:'plan'|'resume_source';holdTools:boolean;held:(()=>void)|null;dropClear:boolean;clearDelay:number;ackBoardCounts:number[];emit:(event:Record<string,unknown>)=>void;offer:(sdp:string)=>Promise<string>;speech:(text:string,id?:string)=>void;finish:()=>void};
    const harness:Data={sent:[],peer:null,channel:null,input:null,gain:null,audioContext:null,context:null,lastAudio:'',next:0,action:'plan',holdTools:false,held:null,dropClear:false,clearDelay:0,ackBoardCounts:[],emit(event){if(harness.channel?.readyState==='open')harness.channel.send(JSON.stringify(event));},async offer(sdp){
      const peer=new RTCPeerConnection();harness.peer=peer;
      const audioContext=harness.audioContext??new AudioContext();harness.audioContext=audioContext;
      const remote=audioContext.createMediaStreamDestination();const zero=audioContext.createGain();zero.gain.value=0;const oscillator=audioContext.createOscillator();oscillator.connect(zero);zero.connect(remote);oscillator.start();remote.stream.getTracks().forEach(track=>peer.addTrack(track,remote.stream));
      peer.ondatachannel=event=>{const channel=event.channel;harness.channel=channel;channel.onopen=()=>harness.emit({type:'session.created',session:{id:'mock-provider-local-rtc'}});channel.onmessage=event=>{
        const body=JSON.parse(event.data);harness.sent.push(body);
        if(body.type==='conversation.item.create'&&body.item?.role==='user'){const text=body.item.content?.[0]?.text;if(text)harness.context=JSON.parse(text);}
        if(body.type==='conversation.item.create'&&body.item?.type==='function_call_output')harness.ackBoardCounts.push(document.querySelectorAll('[data-testid="board-step"]').length);
        if(body.type==='session.update')harness.emit({type:'session.updated',session:body.session});
        if(body.type==='response.create'){
          const id='response-'+(++harness.next);const metadata=body.response.metadata;
          harness.emit({type:'response.created',response:{id,metadata}});
          if(body.response.output_modalities[0]==='text'){
            const context=harness.context!;
            const plan={schemaVersion:'1',contextRevision:context.contextRevision,answer:'实时接口模拟教案',needsClarification:false,clarificationQuestion:null,steps:[1,2].map(number=>({stepId:'rt-step-'+number,title:'实时步骤 '+number,explanationMarkdown:'这一行解释当前已授权来源。',speechText:'这是第'+number+'步的简短讲解。',boardBlocks:[{id:'rt-math-'+number,type:'math',latex:'M_t=0.9M_{t-1}+0.1g_t',label:'接口模拟公式'}],sourceIds:[context.authorizedContext.sources[0].sourceId],exampleOrigin:'teacher_created'})),checkQuestion:'权重总和是多少？'};
            const call={type:'function_call',name:harness.action==='plan'?'present_teaching_plan':'control_reading',call_id:'call-'+id,arguments:JSON.stringify(harness.action==='plan'?{opId:'op-'+id,plan}:{opId:'op-'+id,action:'resume_source'})};
            harness.emit({...call,type:'response.function_call_arguments.done',response_id:id});
            const done=()=>harness.emit({type:'response.done',response:{id,status:'completed',output:[call]}});
            if(harness.holdTools)harness.held=done;else setTimeout(done,20);
          }else{
            harness.lastAudio=id;harness.emit({type:'output_audio_buffer.started',response_id:id});harness.emit({type:'response.output_audio_transcript.delta',response_id:id,delta:'这是当前步骤的语音转写，来自模拟服务。'});harness.emit({type:'response.done',response:{id,status:'completed',output:[]}});
          }
        }
        if(body.type==='response.cancel')harness.emit({type:'response.done',response:{id:body.response_id??'none',status:'cancelled',output:[]}});
        if(body.type==='output_audio_buffer.clear'&&!harness.dropClear)setTimeout(()=>harness.emit({type:'output_audio_buffer.cleared',response_id:harness.lastAudio}),harness.clearDelay);
      };};
      await peer.setRemoteDescription({type:'offer',sdp});await peer.setLocalDescription(await peer.createAnswer());
      if(peer.iceGatheringState!=='complete')await new Promise<void>(resolve=>{const timer=setTimeout(resolve,3000);peer.addEventListener('icegatheringstatechange',()=>{if(peer.iceGatheringState==='complete'){clearTimeout(timer);resolve();}});});
      return peer.localDescription!.sdp;
    },speech(text,id='input-'+Date.now()) {harness.emit({type:'input_audio_buffer.speech_started',item_id:id});harness.emit({type:'input_audio_buffer.speech_stopped',item_id:id});harness.emit({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:text});},finish(){harness.emit({type:'output_audio_buffer.stopped',response_id:harness.lastAudio});}};
    Object.defineProperty(window,'__rt',{value:harness});
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{const ctx=new AudioContext();harness.audioContext=ctx;const destination=ctx.createMediaStreamDestination();const oscillator=ctx.createOscillator();const gain=ctx.createGain();gain.gain.value=0;oscillator.connect(gain);gain.connect(destination);oscillator.start();harness.gain=gain;harness.input=destination.stream;return destination.stream;}});
  });
  if(live)await page.route('**/api/config',async route=>{const response=await route.fetch();const config=await response.json();expect(config.mode).toBe('demo');await route.fulfill({json:{...config,mode:'live',models:{...config.models,realtime:'MOCK_REALTIME_NOT_PAID'},capabilities:{...config.capabilities,realtimeAudio:'untested'},realtime:{provider:'openai-realtime',voice:'marin',maxSessionSeconds:600,idleSeconds:120,inputTranscriptionModel:'MOCK_TRANSCRIPTION'}}});});
  await page.route('**/api/realtime/connect',async route=>{connections.opened++;const body=route.request().postDataJSON();const sdp=await page.evaluate(async offer=>(window as unknown as {__rt:{offer:(sdp:string)=>Promise<string>}}).__rt.offer(offer),body.sdp);await route.fulfill({json:{sessionId:body.sessionId,generationId:body.generationId,contextRevision:body.contextRevision,connectionId:'local-loopback-only',sdp,expiresAt:Date.now()+600000}});});
  await page.route('**/api/realtime/heartbeat',route=>route.fulfill({json:{active:true}}));
  await page.route('**/api/realtime/disconnect',route=>{connections.closed++;return route.fulfill({json:{active:false,upstreamCancellation:'confirmed'}});});
  return connections;
}
export async function openRealtime(page:Page,mode:'live'|'local'='live'){await page.goto('/');await page.getByRole('button',{name:/示例/}).click();await expect(page.locator('main')).toHaveAttribute('aria-busy','false');const span=page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first();await expect(span).toBeVisible();const box=(await span.boundingBox())!;await page.mouse.move(box.x+1,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width-1,box.y+box.height/2,{steps:12});await page.mouse.up();await page.locator('.realtime-panel summary').click();await page.getByRole('button',{name:mode==='live'?'开启实时语音':'本机打断演练',exact:true}).click();await expect(page.locator('.realtime-body')).toContainText(mode==='live'?'实时麦克风已开启':'本机演练：');}

export async function mockSourceSpeech(page:Page){
  const bytes=8000*2*30;const wav=Buffer.alloc(44+bytes);wav.write('RIFF',0);wav.writeUInt32LE(36+bytes,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(bytes,40);
  await page.route('**/api/tts',route=>{const body=route.request().postDataJSON();return route.fulfill({status:200,body:wav,headers:{'Content-Type':'audio/wav','x-session-id':body.sessionId,'x-generation-id':String(body.generationId),'x-context-revision':String(body.contextRevision)}});});
}
