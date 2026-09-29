import {test,expect,type Page} from '@playwright/test';
import {realtimeHarness,openRealtime} from './realtimeHarness';
type Speech={rates:number[];texts:string[];active:number;maximum:number;finish:()=>void};
async function mockSpeech(page:Page){await page.addInitScript(()=>{
  class Utterance{onstart:(()=>void)|null=null;onresume:(()=>void)|null=null;onend:(()=>void)|null=null;rate=1;constructor(public text:string){}}
  let current:Utterance|null=null;const state={rates:[] as number[],texts:[] as string[],active:0,maximum:0,finish(){state.active=0;current?.onend?.();}};
  Object.defineProperty(window,'__trialSpeech',{value:state});Object.defineProperty(window,'SpeechSynthesisUtterance',{value:Utterance});
  Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[{name:'Mock Chinese',lang:'zh-CN',localService:true}],speak(value:Utterance){current=value;state.rates.push(value.rate);state.texts.push(value.text);state.active++;state.maximum=Math.max(state.maximum,state.active);queueMicrotask(()=>value.onstart?.());},pause(){state.active=0;},resume(){if(current){state.active=1;current.onresume?.();}},cancel(){state.active=0;current=null;},addEventListener(){},removeEventListener(){}}});
});}
async function prepare(page:Page){await page.goto('/');await page.getByRole('button',{name:'功能体验',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('当前没有连接 AI');await page.getByRole('button',{name:'用练习走一遍',exact:true}).click();await expect(page.locator('main')).toHaveAttribute('aria-busy','false');await expect(page.locator('.textLayer span').first()).toBeVisible();await page.getByRole('button',{name:'帮我选一小段',exact:true}).click();await expect(page.locator('.practice-coach')).toContainText('2 / 4');}

test('功能引导使用真实 PDF 选区与播放状态，0.25倍速暂停后同一句续读并记住速度',async({page})=>{
  await mockSpeech(page);const calls:string[]=[];page.on('request',request=>{if(/\/api\/(ask|tts|transcribe|realtime\/connect)$/.test(new URL(request.url()).pathname))calls.push(request.url());});await prepare(page);
  const preview=await page.locator('.selection-preview').textContent();expect(preview?.length).toBeGreaterThan(30);expect(await page.evaluate(()=>window.getSelection()?.toString().trim())).toBe(preview?.trim());
  await page.getByRole('combobox',{name:'语速',exact:true}).selectOption('0.25');await page.getByRole('button',{name:'开始试读',exact:true}).click();await expect(page.locator('.practice-coach')).toContainText('3 / 4');
  expect(await page.evaluate(()=>(window as unknown as {__trialSpeech:Speech}).__trialSpeech.rates.at(-1))).toBe(0.25);const sentence=await page.getByTestId('reading-subtitle').textContent();
  await page.getByRole('button',{name:'暂停试读',exact:true}).click();await expect(page.locator('.practice-coach')).toContainText('4 / 4');await expect(page.locator('.audio-source strong')).toContainText('已暂停');
  await page.getByRole('button',{name:'从这里继续',exact:true}).click();await expect(page.locator('.practice-coach')).toContainText('已体验暂停与续读');await expect(page.getByTestId('reading-subtitle')).toHaveText(sentence??'');expect(calls).toEqual([]);
  await page.setViewportSize({width:1280,height:720});await page.screenshot({path:'docs/screenshots/slow-reading-720.png',fullPage:true});await page.getByRole('button',{name:'停止',exact:true}).click();
  await page.reload();await expect(page.getByRole('combobox',{name:'语速',exact:true})).toHaveValue('0.25');expect(await page.evaluate(()=>(window as unknown as {__trialSpeech:Speech}).__trialSpeech.texts)).toEqual([]);
});

test('最低速在朗读中立即从本句重播，暂停时改速不自动出声；无叠音（模拟输出）',async({page})=>{
  await mockSpeech(page);await prepare(page);await page.getByRole('button',{name:'开始试读',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');const sentence=await page.getByTestId('reading-subtitle').textContent();
  await page.getByRole('combobox',{name:'语速',exact:true}).selectOption('0.25');await expect.poll(()=>page.evaluate(()=>(window as unknown as {__trialSpeech:Speech}).__trialSpeech.rates.at(-1))).toBe(0.25);await expect(page.getByTestId('reading-subtitle')).toHaveText(sentence??'');
  await page.getByRole('button',{name:'暂停朗读',exact:true}).click();await page.getByRole('combobox',{name:'语速',exact:true}).selectOption('0.35');await expect(page.locator('.audio-source strong')).toContainText('已暂停');expect(await page.evaluate(()=>(window as unknown as {__trialSpeech:Speech}).__trialSpeech.active)).toBe(0);
  await page.getByRole('button',{name:'继续朗读',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as unknown as {__trialSpeech:Speech}).__trialSpeech.rates.at(-1))).toBe(0.35);expect(await page.evaluate(()=>(window as unknown as {__trialSpeech:Speech}).__trialSpeech.maximum)).toBe(1);await page.getByRole('button',{name:'停止',exact:true}).click();
});

test('体验入口明确固定板书并直接打开逐步讲解，Esc 关闭介绍不清除选区',async({page})=>{
  await mockSpeech(page);await prepare(page);const source=await page.locator('.selection-preview').textContent();await page.getByRole('button',{name:'功能体验',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('内容不会随问题改变');await page.screenshot({path:'docs/screenshots/feature-guide.png',fullPage:true});await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.selection-preview')).toHaveText(source??'');
  await page.getByRole('button',{name:'功能体验',exact:true}).click();await page.getByRole('button',{name:'试分步板书（固定样例）',exact:true}).click();await expect(page.locator('.classroom-controls')).toHaveAttribute('open','');await expect(page.getByTestId('board-step')).toHaveCount(1);await expect(page.locator('.classroom-progress')).toContainText('正在讲解');await expect(page.locator('.active-step')).toContainText('演示范围');
  for(let i=0;i<25&&(await page.locator('.classroom-progress').textContent())?.includes('正在讲解');i++){await page.evaluate(()=>(window as unknown as {__trialSpeech:Speech}).__trialSpeech.finish());await page.waitForTimeout(25);}
  await page.getByRole('button',{name:'继续陪读',exact:true}).click();await expect(page.getByTestId('board-step')).toHaveCount(2);await page.getByRole('button',{name:'停止',exact:true}).click();
});

test('体验入口的麦克风只开启本机检测，真实声音分析可暂停朗读而不上传',async({page})=>{
  const service=await realtimeHarness(page,false);await mockSpeech(page);await prepare(page);await page.getByRole('button',{name:'展开或折叠对话',exact:true}).click();await page.getByRole('button',{name:'功能体验',exact:true}).click();await page.locator('.guide-microphone>summary').click();await page.getByRole('button',{name:'打开麦克风试打断',exact:true}).click();await expect(page.locator('.realtime-body')).toContainText('本机演练：');await expect(page.locator('.realtime-panel')).toHaveAttribute('open','');await expect(page.locator('.optional-voice')).toHaveAttribute('open','');await expect(page.getByRole('button',{name:'停止实时会话',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'朗读所选',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');await page.evaluate(()=>{(window as unknown as {__rt:{gain:GainNode}}).__rt.gain.gain.value=0.1;});await expect(page.locator('.audio-source strong')).toContainText('已暂停');expect(service.opened).toBe(0);await page.getByRole('button',{name:'停止',exact:true}).click();await expect(page.locator('.microphone-chip')).toHaveCount(0);
});

test('真实本机 RTC 回环确认 0.25倍速后才请求语音（模型事件模拟）',async({page})=>{
  await realtimeHarness(page);await openRealtime(page);await page.getByRole('combobox',{name:'语速',exact:true}).selectOption('0.25');await page.evaluate(()=>(window as unknown as {__rt:{speech:(text:string)=>void}}).__rt.speech('请慢慢解释。'));await expect(page.locator('.realtime-status')).toContainText('正在播放');
  const events=await page.evaluate(()=>(window as unknown as {__rt:{sent:Array<{type:string;session?:{audio?:{output?:{speed?:number}}};response?:{output_modalities?:string[]}}>}}).__rt.sent);
  const speed=events.findIndex(event=>event.type==='session.update'&&event.session?.audio?.output?.speed===0.25);const audio=events.findIndex(event=>event.type==='response.create'&&event.response?.output_modalities?.[0]==='audio');expect(speed).toBeGreaterThan(-1);expect(audio).toBeGreaterThan(speed);await page.getByRole('button',{name:'停止',exact:true}).click();
});

test('试读自然结束不能虚报完成，能重新播放再试暂停',async({page})=>{
  await mockSpeech(page);await prepare(page);await page.getByRole('button',{name:'开始试读',exact:true}).click();await expect(page.locator('.practice-coach')).toContainText('3 / 4');
  for(let i=0;i<20&&(await page.locator('.audio-source strong').textContent())?.includes('正在朗读');i++){await page.evaluate(()=>(window as unknown as {__trialSpeech:Speech}).__trialSpeech.finish());await page.waitForTimeout(30);}
  await expect(page.locator('.practice-coach')).toContainText('还没有完成暂停体验');await expect(page.locator('.practice-coach')).not.toContainText('已体验暂停与续读');await page.getByRole('button',{name:'开始试读',exact:true}).click();await expect(page.locator('.practice-coach')).toContainText('3 / 4');await page.getByRole('button',{name:'暂停试读',exact:true}).click();await page.getByRole('button',{name:'从这里继续',exact:true}).click();await expect(page.locator('.practice-coach')).toContainText('已体验暂停与续读');await page.getByRole('button',{name:'停止',exact:true}).click();
});

test('只有图片选区时体验入口不引导无法朗读的麦克风流程',async({page})=>{
  await prepare(page);await page.getByRole('button',{name:'关闭试读引导',exact:true}).click();await page.getByRole('button',{name:'框选区域',exact:true}).click();const bounds=(await page.locator('.pdf-page').boundingBox())!;await page.mouse.move(bounds.x+20,bounds.y+20);await page.mouse.down();await page.mouse.move(bounds.x+150,bounds.y+95,{steps:10});await page.mouse.up();await expect(page.locator('.crop-preview')).toBeVisible();
  await page.getByRole('button',{name:'功能体验',exact:true}).click();await page.locator('.guide-microphone>summary').click();await expect(page.getByRole('button',{name:'打开麦克风试打断',exact:true})).toBeDisabled();await expect(page.getByRole('dialog')).toContainText('图片区域不能直接朗读');
});

test('麦克风权限尚未返回时只显示准备中，取消后不显示已开启',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:()=>new Promise(()=>{})}));await prepare(page);await page.getByRole('button',{name:'功能体验',exact:true}).click();await page.locator('.guide-microphone>summary').click();await page.getByRole('button',{name:'打开麦克风试打断',exact:true}).click();await expect(page.locator('.microphone-chip')).toContainText('语音准备中');await expect(page.locator('.realtime-status')).toContainText('申请麦克风 / 连接中');await expect(page.locator('.realtime-status')).not.toContainText('正在监听');
  await page.locator('.microphone-chip').click();await expect(page.locator('.microphone-chip')).toHaveCount(0);await expect(page.locator('.realtime-body')).toContainText('设备已释放');
});
