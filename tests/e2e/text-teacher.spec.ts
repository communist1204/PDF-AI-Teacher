import {test,expect,type Page} from '@playwright/test';
import type {AskRequest,AskResponse} from '../../packages/shared/protocol';
import {mockSourceSpeech} from './realtimeHarness';

type Harness={audio:HTMLAudioElement[];microphones:number};
async function setup(page:Page,tts=true){
  await page.addInitScript(()=>{
    const state:Harness={audio:[],microphones:0};Object.defineProperty(window,'__answerAudio',{value:state});
    const NativeAudio=window.Audio;
    window.Audio=class extends NativeAudio{constructor(src?:string){super(src);state.audio.push(this);}};
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{state.microphones++;throw Error('This text-only test must not open a microphone');}});
  });
  await page.route('**/api/config',async route=>{const response=await route.fetch();const config=await response.json();expect(config.mode).toBe('demo');await route.fulfill({json:{...config,mode:'live',models:{...config.models,chat:'mock-theory-quality',vision:'mock-vision-quality',tts:tts?'mock-narration':''},capabilities:{...config.capabilities,text:'untested',vision:'untested',tts:tts?'untested':'unconfigured'},teaching:{chatReasoningEffort:'xhigh',visionReasoningEffort:'xhigh',maxOutputTokens:32000,timeoutMs:300000}}});});
  const questions:AskRequest[]=[];const speech:string[]=[];const unexpected:string[]=[];
  page.on('request',request=>{const path=new URL(request.url()).pathname;if(path==='/api/tts')speech.push(request.postDataJSON().text);if(/\/api\/(transcribe|realtime\/connect)$/.test(path))unexpected.push(path);});
  await page.route('**/api/ask',async route=>{
    const request=route.request().postDataJSON() as AskRequest;questions.push(request);
    const response=await route.fetch();const body=await response.json() as AskResponse;
    body.mode='live';body.plan.answer='接口模拟：这里检验线性期望和零初始化的适用条件。';
    body.plan.steps=body.plan.steps.slice(0,2).map((step,index)=>({...step,title:'接口模拟步骤 '+(index+1),speechText:index===0?'先明确零初始化这个条件。再核对随机变量的期望是否保持不变。':'在这些条件下展开递推式。分母来自历史权重的总和。'}));
    body.usage.model='mock-theory-quality';await route.fulfill({json:body});
  });
  await mockSourceSpeech(page);
  await page.goto('/');await page.getByRole('button',{name:/示例/}).click();await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
  const span=page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first();await expect(span).toBeVisible();const b=(await span.boundingBox())!;
  await page.mouse.move(b.x+1,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width-1,b.y+b.height/2,{steps:12});await page.mouse.up();
  return {questions,speech,unexpected};
}
async function question(page:Page){await page.getByRole('textbox',{name:'输入文字问题'}).fill('请严格推导期望关系，并说明平稳性假设能否去掉。');await page.getByRole('button',{name:'发送问题',exact:true}).click();await expect(page.locator('.message.assistant')).toBeVisible();}
async function endSentence(page:Page){await page.evaluate(()=>{const h=(window as unknown as {__answerAudio:Harness}).__answerAudio;const audio=[...h.audio].reverse().find(item=>!!item.src&&!item.paused);if(!audio)throw Error('No active audio');audio.pause();audio.dispatchEvent(new Event('ended'));});}

test('打字提问用解题接口，朗读复用同份讲解稿，不开麦、不重复解题，并保留原文书签',async({page})=>{
  const {questions,speech,unexpected}=await setup(page);
  await expect(page.locator('.optional-voice')).not.toHaveAttribute('open','');await expect(page.getByRole('button',{name:'语音转文字提问',exact:true})).toBeHidden();
  await expect(page.locator('.teaching-route')).toContainText('mock-theory-quality');
  await page.getByRole('button',{name:'朗读所选',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');const source=await page.getByTestId('reading-subtitle').textContent();
  await question(page);expect(questions).toHaveLength(1);expect(questions[0].question).toContain('平稳性');expect(questions[0].context.sources[0].sourceText).toContain('指数移动平均');
  await expect(page.locator('.audio-source strong')).not.toContainText('正在朗读');expect(speech).toHaveLength(1);
  await page.getByRole('button',{name:'听这次讲解',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');await expect(page.getByTestId('reading-subtitle')).toHaveText('先明确零初始化这个条件。');expect(speech.at(-1)).toBe('先明确零初始化这个条件。');expect(questions).toHaveLength(1);
  await endSentence(page);await expect(page.getByTestId('reading-subtitle')).toHaveText('再核对随机变量的期望是否保持不变。');await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  await page.getByRole('button',{name:'暂停朗读',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('已暂停');
  await page.getByRole('button',{name:'从头听讲解',exact:true}).click();await expect(page.getByTestId('reading-subtitle')).toHaveText('先明确零初始化这个条件。');await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  await endSentence(page);await expect(page.getByTestId('reading-subtitle')).toHaveText('再核对随机变量的期望是否保持不变。');await expect(page.locator('.audio-source strong')).toContainText('正在朗读');await endSentence(page);
  await page.getByRole('button',{name:'继续这次讲解',exact:true}).click();await expect(page.getByTestId('reading-subtitle')).toHaveText('在这些条件下展开递推式。');await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  await page.screenshot({path:'docs/screenshots/text-teacher-desktop.png',fullPage:true});await page.setViewportSize({width:1280,height:720});await page.locator('.answer-speech').scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/text-teacher-720.png',fullPage:true});
  await page.getByRole('textbox',{name:'输入文字问题'}).fill('这里再解释细一点');await expect(page.locator('.audio-source strong')).not.toContainText('正在朗读');
  await page.getByRole('button',{name:'回原文继续',exact:true}).click();await expect(page.getByTestId('reading-subtitle')).toHaveText(source??'');await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  expect(questions).toHaveLength(1);expect(unexpected).toEqual([]);expect(await page.evaluate(()=>(window as unknown as {__answerAudio:Harness}).__answerAudio.microphones)).toBe(0);await page.getByRole('button',{name:'停止',exact:true}).click();
});

test('语音失败保留专业解答与板书，不重问解题模型或偷偷换本机声音',async({page})=>{
  const {questions,speech}=await setup(page);await page.route('**/api/tts',route=>route.fulfill({status:503,json:{message:'模拟：语音服务暂不可用'}}));
  await question(page);await page.getByRole('button',{name:'听这次讲解',exact:true}).click();await expect(page.getByRole('alert')).toContainText('语音服务暂不可用');await expect(page.locator('.message.assistant')).toContainText('零初始化');await expect(page.getByTestId('board-step').first()).toBeVisible();expect(questions).toHaveLength(1);expect(speech).toHaveLength(1);
  await expect(page.locator('.audio-source strong')).not.toContainText('正在朗读');
});

test('没有TTS时文字解答独立可用，设置显示实际解题配置而非虚报已连接',async({page})=>{
  const {questions,speech}=await setup(page,false);await question(page);await expect(page.getByRole('button',{name:'听这次讲解',exact:true})).toBeDisabled();await expect(page.locator('.answer-speech')).toContainText('声音尚未配置');expect(questions).toHaveLength(1);expect(speech).toEqual([]);
  await page.getByRole('button',{name:'设置与用量',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('xhigh');await expect(page.getByRole('dialog')).toContainText('32000');await expect(page.getByRole('dialog')).toContainText('300 秒');
});
