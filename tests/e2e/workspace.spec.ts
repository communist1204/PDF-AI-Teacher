import { test, expect, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

async function openSample(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /示例/ }).click();
  await expect(page.locator('.textLayer span').filter({ hasText: '指数移动平均将过去' }).first()).toBeVisible();
}
async function selectText(page: Page) {
  const text = page.locator('.textLayer span').filter({ hasText: '指数移动平均将过去' }).first();
  const box = await text.boundingBox();
  if (!box) throw new Error('text layer missing');
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(page.locator('.selection-preview')).toContainText('指数移动平均');
}
async function askSelection(page: Page, question = '请解释这段内容。') {
  await page.getByRole('button', {name:'针对选区提问',exact:true}).click();
  await page.getByRole('textbox', {name:'本次选区问题',exact:true}).fill(question);
  await page.getByRole('button', {name:'发送选区问题',exact:true}).click();
}
test('中文 PDF 真实鼠标选区 → 演示教案 → 公式表格及来源', async ({page}) => {
  const errors:string[]=[];
  page.on('pageerror', e=>errors.push(e.message));
  await openSample(page);
  await selectText(page);
  await expect(page.getByText('演示模式 · AI 未连接')).toBeVisible();
  await askSelection(page);
  await expect(page.getByTestId('board-step').first()).toBeVisible();
  await expect(page.locator('.katex').first()).toBeVisible();
  await expect(page.locator('table').first()).toBeVisible();
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>Object.defineProperty(window,'__copiedLatex',{configurable:true,value:text})}}));
  await page.getByRole('button',{name:'复制 LaTeX',exact:true}).first().click();
  await expect(page.getByText('LaTeX 已复制',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__copiedLatex:string}).__copiedLatex)).toContain('\\beta');
  await expect(page.locator('.message.assistant')).toContainText('演示');
  await page.getByRole('button',{name:/原文 · PDF 1 页/}).first().click();
  await expect(page.getByText('讲解锁定 · PDF 第 1 页')).toBeVisible();
  await page.screenshot({path:'docs/screenshots/workspace-desktop.png',fullPage:true});
  await page.setViewportSize({width:1280,height:720});
  await page.screenshot({path:'docs/screenshots/workspace-1280.png',fullPage:true});
  await page.getByRole('button',{name:/追问这一步/}).first().click();
  await page.getByRole('button',{name:'针对选区提问',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('板书追问');
  await expect(page.locator('.question-board-source')).toContainText('演示范围与真实选区');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
test('发送请求的选区匹配，换页不替换锁定上下文',async({page})=>{
  await openSample(page);await selectText(page);
  let sent: {context:{sources:{sourceText:string;pageIndex:number}[]}}|undefined;
  await page.route('**/api/ask',async route=>{
    sent=route.request().postDataJSON();
    await new Promise(resolve=>setTimeout(resolve,500));
    await route.continue();
  });
  const preview=await page.locator('.selection-preview').textContent();
  await askSelection(page);
  await page.getByRole('button',{name:/下一页/}).click();
  await expect(page.getByTestId('board-step').first()).toBeVisible();
  expect(sent?.context.sources[0].sourceText).toBe(preview);
  expect(sent?.context.sources[0].pageIndex).toBe(0);
  await expect(page.getByText('讲解锁定 · PDF 第 1 页')).toBeVisible();
});
test('同名不同内容的 PDF 丢弃前一本书的迟到回答',async({page})=>{
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles('public/sample.pdf');
  await expect(page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first()).toBeVisible();
  await selectText(page);
  await page.route('**/api/ask',async route=>{
    await new Promise(resolve=>setTimeout(resolve,900));
    await route.continue().catch(()=>{});
  });
  await askSelection(page);
  const different=await PDFDocument.load(await readFile('public/sample.pdf'));different.removePage(0);
  await page.locator('input[type=file]').setInputFiles({name:'sample.pdf',mimeType:'application/pdf',buffer:Buffer.from(await different.save())});
  await expect(page.locator('.message')).toHaveCount(0);
  await page.waitForTimeout(1200);
  await expect(page.getByTestId('board-step')).toHaveCount(0);
  await page.getByRole('textbox',{name:'输入文字问题'}).fill('这个是什么意思？');
  await page.getByRole('button',{name:'发送问题',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('选中文字');
});


test('音频模拟：同一句暂停续播，文字打断后恢复未完成句，无旧声复活', async ({page})=>{
  await page.addInitScript(()=>{
    class Utterance {
      onstart: (()=>void)|null=null; onresume:(()=>void)|null=null; onend:(()=>void)|null=null;
      onerror:((event: {error:string})=>void)|null=null;
      constructor(public text:string) {}
    }
    let current:Utterance|null=null;
    const state={speaks:[] as string[],pauses:0,cancels:0,finish(){current?.onend?.();}};
    Object.defineProperty(window,'__testSpeech',{value:state});
    Object.defineProperty(window,'SpeechSynthesisUtterance',{value:Utterance});
    Object.defineProperty(window,'speechSynthesis',{value:{
      getVoices:()=>[{name:'Test Chinese voice (mock)',lang:'zh-CN',localService:true},{name:'Test English voice (mock)',lang:'en-US',localService:true}],
      speak(value:Utterance){current=value;state.speaks.push(value.text);queueMicrotask(()=>value.onstart?.());},
      pause(){state.pauses++;},resume(){current?.onresume?.();},cancel(){current=null;state.cancels++;},
      addEventListener(){},removeEventListener(){}
    }});
  });
  await openSample(page);
  await page.getByRole('button',{name:'切换为跟随当前页',exact:true}).click();
  await page.getByRole('button',{name:'选本页文字',exact:true}).click();
  const confirm=page.getByRole('checkbox');
  if(await confirm.count())await confirm.check();
  await page.getByRole('button',{name:'朗读所选',exact:true}).click();
  await expect(page.getByRole('button',{name:'暂停朗读',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'阅读位置',exact:true}).click();
  await expect(page.getByRole('button',{name:'暂停朗读',exact:true})).toBeEnabled();
  await page.evaluate(()=>(window as unknown as {__testSpeech:{finish:()=>void}}).__testSpeech.finish());
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {__testSpeech:{speaks:string[]}}).__testSpeech.speaks.length)).toBe(2);
  const second=await page.getByTestId('reading-subtitle').textContent();
  await page.getByRole('button',{name:'暂停朗读',exact:true}).click();
  await expect(page.locator('.audio-source strong')).toContainText('已暂停');
  await page.getByRole('button',{name:'继续朗读',exact:true}).click();
  expect(await page.evaluate(()=>(window as unknown as {__testSpeech:{speaks:string[]}}).__testSpeech.speaks.length)).toBe(2);
  await page.getByRole('textbox',{name:'输入文字问题'}).fill('请解释这个例子');
  await expect(page.locator('.audio-source strong')).toContainText('待机');
  await page.getByRole('button',{name:'发送问题',exact:true}).click();
  await expect(page.getByTestId('board-step').first()).toBeVisible();
  await page.getByRole('button',{name:'继续朗读',exact:true}).click();
  await expect(page.getByTestId('reading-subtitle')).toHaveText(second??'');
  expect(await page.evaluate(()=>(window as unknown as {__testSpeech:{speaks:string[]}}).__testSpeech.speaks.length)).toBe(3);
  await page.getByRole('button',{name:'停止',exact:true}).click();
  await expect(page.locator('.audio-source strong')).toContainText('待机');
  await page.locator('.clear-selection-button').click();
  await expect(page.locator('.pdf-selected-highlight')).toHaveCount(0);
  await expect(page.locator('.pdf-reading-highlight')).toHaveCount(0);
  await expect(page.locator('.target-chip')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'继续朗读',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'继续朗读',exact:true}).click();
  await expect(page.getByTestId('reading-subtitle')).toHaveText(second??'');
  expect(await page.evaluate(()=>(window as unknown as {__testSpeech:{speaks:string[]}}).__testSpeech.speaks.length)).toBe(4);
  await expect(page.getByRole('button',{name:'针对选区提问',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'停止',exact:true}).click();
  await page.screenshot({path:'docs/screenshots/reading-bookmark.png',fullPage:true});
});

test('模型危险文本和 LaTeX 不执行，显示安全内容',async({page})=>{
  await openSample(page);await selectText(page);
  await page.route('**/api/ask',async route=>{
    const request=route.request().postDataJSON();
    await route.fulfill({json:{
      ...request,mode:'demo',
      plan:{schemaVersion:'1',contextRevision:request.contextRevision,answer:'<img src=x onerror=alert(1)>',needsClarification:false,clarificationQuestion:null,checkQuestion:null,steps:[{stepId:'unsafe-test',title:'安全测试',explanationMarkdown:'<script>alert(1)</script>',speechText:'安全测试',sourceIds:[request.context.sources[0].sourceId],exampleOrigin:'none',boardBlocks:[{id:'math',type:'math',latex:'\\href{javascript:alert(1)}{x}',label:null}]}]},
      usage:{requestId:'mock',model:'mock',category:'text',inputTokens:null,outputTokens:null,characters:null,estimatedCost:null,cancelled:false}
    }});
  });
  const dialogs:string[]=[];page.on('dialog',dialog=>{dialogs.push(dialog.message());void dialog.dismiss();});
  await askSelection(page);
  await expect(page.locator('.message.assistant')).toContainText('<img src=x');
  expect(await page.locator('.board a[href^="javascript:"]').count()).toBe(0);
  expect(await page.locator('.message img').count()).toBe(0);
  expect(dialogs).toEqual([]);
});



test('真实区域截图预览，旋转缩放后来源矩形仍能定位',async({page})=>{
  await openSample(page);
  await page.getByRole('button',{name:'框选区域',exact:true}).click();
  const surface=page.locator('.pdf-page');
  const box=await surface.boundingBox();
  if(!box)throw new Error('PDF page missing');
  await page.mouse.move(box.x+box.width*.12,box.y+box.height*.31);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width*.85,box.y+box.height*.40,{steps:12});
  await page.mouse.up();
  const preview=page.getByAltText('即将发送的公式截图');
  await expect(preview).toBeVisible();
  const image=await preview.getAttribute('src');
  expect(image).toMatch(/^data:image\/png;base64,/);
  let sent:{context:{sources:{rect:number[];pageIndex:number}[];imageDataUrl:string}}|undefined;
  page.on('request',request=>{if(request.url().endsWith('/api/ask'))sent=request.postDataJSON();});
  await askSelection(page);
  await expect(page.getByTestId('board-step').first()).toBeVisible();
  expect(sent?.context.imageDataUrl).toBe(image);
  expect(sent?.context.sources[0].rect[0]).toBeCloseTo(.12,1);
  expect(sent?.context.sources[0].rect[1]).toBeCloseTo(.31,1);
  await page.getByRole('button',{name:'旋转页面',exact:true}).click();
  await expect(page.locator('.pdf-scroll')).toHaveAttribute('aria-busy','false');
  await page.getByRole('button',{name:/原文 · PDF 1 页/}).first().click();
  await expect(page.locator('.pdf-selected-highlight').first()).toBeVisible();
  await page.getByRole('button',{name:'放大',exact:true}).click();
  await expect(page.locator('.pdf-scroll')).toHaveAttribute('aria-busy','false');
  await page.screenshot({path:'docs/screenshots/formula-region.png',fullPage:true});
});
test('后端错误清楚显示且不自动切换为假回答',async({page})=>{
  await openSample(page);await selectText(page);
  await page.route('**/api/ask',route=>route.fulfill({status:503,json:{error:'not_configured',message:'文字模型未配置，请在本机配置后重启。'}}));
  await askSelection(page);
  await expect(page.getByRole('alert')).toContainText('文字模型未配置');
  await expect(page.getByTestId('board-step')).toHaveCount(0);
});
test('真实浏览器本机语音能力诊断（不评价扬声器听感）',async({page},testInfo)=>{
  await page.goto('/');
  await page.waitForFunction(()=>window.speechSynthesis.getVoices().length>0,{},{timeout:2000}).catch(()=>{});
  const voices=await page.evaluate(()=>window.speechSynthesis.getVoices().map(v=>({name:v.name,lang:v.lang,localService:v.localService})));
  await testInfo.attach('real-browser-voices',{body:JSON.stringify({mock:false,voices,localChinese:voices.filter(v=>v.localService&&v.lang.startsWith('zh')).length,humanListening:'未测'},null,2),contentType:'application/json'});
  console.log('Real browser voice diagnostic:',JSON.stringify({total:voices.length,localChinese:voices.filter(v=>v.localService&&v.lang.startsWith('zh')).length,humanListening:'未测'}));
  await expect(page.getByText('演示模式 · AI 未连接')).toBeVisible();
});



test('刷新恢复会话版本，本书笔记按指纹保留',async({page})=>{
  await openSample(page);await selectText(page);
  await askSelection(page);
  await expect(page.getByTestId('board-step').first()).toBeVisible();
  await page.locator('.notes summary').click();
  await page.getByRole('textbox',{name:'本书本地笔记',exact:true}).fill('我需要再想一下权重总和。');
  await page.reload();
  await page.getByRole('button',{name:/示例/}).click();
  await expect(page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first()).toBeVisible();
  await page.locator('.notes summary').click();
  await expect(page.getByRole('textbox',{name:'本书本地笔记',exact:true})).toHaveValue('我需要再想一下权重总和。');
  await selectText(page);
  await askSelection(page);
  await expect(page.getByTestId('board-step').first()).toBeVisible();
  await page.getByRole('button',{name:'设置与用量',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('无法估算');
  await expect(page.getByRole('dialog')).toContainText('文字 2 次');
  await page.getByRole('button',{name:'清除音频缓存',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('音频缓存已清除');
  await page.getByRole('button',{name:'关闭设置',exact:true}).click();
});
test('PDF 内嵌 JavaScript 保持不执行',async({page})=>{
  const pdf=await PDFDocument.load(await readFile('public/sample.pdf'));
  pdf.addJavaScript('untrusted-document','app.alert("PDF_SCRIPT_EXECUTED");');
  const dialogs:string[]=[];
  page.on('dialog',dialog=>{dialogs.push(dialog.message());void dialog.dismiss();});
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({name:'script-test.pdf',mimeType:'application/pdf',buffer:Buffer.from(await pdf.save())});
  await expect(page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first()).toBeVisible();
  await page.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(page.locator('.pdf-scroll')).toHaveAttribute('aria-busy','false');
  expect(dialogs).toEqual([]);
});

test('选区问题每次可编辑，打开和选择提示词都不自动发送',async({page})=>{
  await openSample(page);await selectText(page);
  const sent:{question:string;context:{sources:{sourceText:string}[]}}[]=[];
  page.on('request',request=>{if(request.url().endsWith('/api/ask'))sent.push(request.postDataJSON());});
  const source=await page.locator('.selection-preview').textContent();
  await page.getByRole('button',{name:'针对选区提问',exact:true}).click();
  const input=page.getByRole('textbox',{name:'本次选区问题',exact:true});
  await expect(input).toBeFocused();await expect(input).toHaveValue('');
  await expect(page.getByRole('button',{name:'发送选区问题',exact:true})).toBeDisabled();
  await page.getByRole('dialog').getByRole('button',{name:'这一步为什么成立？',exact:true}).click();
  await expect(input).toHaveValue('这一步为什么成立？');expect(sent).toHaveLength(0);
  await input.fill('只解释第二个等号，不用数字例子。');
  await page.screenshot({path:'docs/screenshots/selection-question.png',fullPage:true});
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.selection-preview')).toHaveText(source??'');
  await expect(page.getByRole('textbox',{name:'输入文字问题'})).toHaveValue('只解释第二个等号，不用数字例子。');
  expect(sent).toHaveLength(0);
  await page.getByRole('button',{name:'针对选区提问',exact:true}).click();
  await expect(input).toHaveValue('只解释第二个等号，不用数字例子。');
  await page.getByRole('button',{name:'发送选区问题',exact:true}).click();
  await expect(page.getByTestId('board-step').first()).toBeVisible();
  expect(sent[0].question).toBe('只解释第二个等号，不用数字例子。');
  expect(sent[0].context.sources[0].sourceText).toBe(source);
  await askSelection(page,'再换一个角度解释这句。');
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  expect(sent[1].question).toBe('再换一个角度解释这句。');
});

test('取消文字选区同时清除锁定目标和高亮，原处可再次选择',async({page})=>{
  await openSample(page);await selectText(page);await askSelection(page);
  await expect(page.getByTestId('board-step').first()).toBeVisible();
  let requests=0;page.on('request',request=>{if(request.url().endsWith('/api/ask'))requests++;});
  await page.getByRole('button',{name:/原文 · PDF 1 页/}).first().click();
  await page.locator('.clear-selection-button').click();
  await expect(page.locator('.selection-preview')).toContainText('用鼠标选择 PDF');
  await expect(page.locator('.pdf-selected-highlight')).toHaveCount(0);
  await expect(page.locator('.target-chip')).toHaveCount(0);
  expect(await page.evaluate(()=>window.getSelection()?.toString())).toBe('');
  await expect(page.getByText('等待选择学习目标',{exact:true})).toBeVisible();
  await expect(page.getByTestId('board-step')).toHaveCount(3);
  await page.getByRole('textbox',{name:'输入文字问题'}).fill('还有哪个符号？');
  await page.getByRole('button',{name:'发送问题',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('选中文字');expect(requests).toBe(0);
  await page.getByRole('button',{name:'关闭提示',exact:true}).click();
  await page.screenshot({path:'docs/screenshots/cleared-selection.png',fullPage:true});
  await selectText(page);
  await expect(page.getByRole('button',{name:'针对选区提问',exact:true})).toBeEnabled();
  await page.locator('.pdf-clear-selection').click();
  await expect(page.locator('.pdf-selected-highlight')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'针对选区提问',exact:true})).toBeDisabled();
});

test('框选可自定义提问，Esc 清空截图后不会沿用旧区域',async({page})=>{
  await openSample(page);
  await page.getByRole('button',{name:'框选区域',exact:true}).click();
  const box=await page.locator('.pdf-page').boundingBox();if(!box)throw new Error('page missing');
  await page.mouse.move(box.x+box.width*.12,box.y+box.height*.31);await page.mouse.down();
  await page.mouse.move(box.x+box.width*.85,box.y+box.height*.40,{steps:12});await page.mouse.up();
  const preview=page.getByAltText('即将发送的公式截图');await expect(preview).toBeVisible();
  let sent:{question:string;context:{imageDataUrl:string}}|undefined;
  page.on('request',request=>{if(request.url().endsWith('/api/ask'))sent=request.postDataJSON();});
  const image=await preview.getAttribute('src');
  await askSelection(page,'这个区域的上下两行有什么关系？');
  await expect(page.getByTestId('board-step').first()).toBeVisible();
  expect(sent?.question).toBe('这个区域的上下两行有什么关系？');expect(sent?.context.imageDataUrl).toBe(image);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);await expect(page.locator('.pdf-selected-highlight')).toHaveCount(0);
  await expect(page.locator('.target-chip')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'针对选区提问',exact:true})).toBeDisabled();
});

test('取消选区丢弃迟到回答，并可清除正在拖动的框',async({page})=>{
  await openSample(page);await selectText(page);
  await page.route('**/api/ask',async route=>{await new Promise(resolve=>setTimeout(resolve,700));await route.continue().catch(()=>{});});
  await askSelection(page);await expect(page.locator('.thinking')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('board-step')).toHaveCount(0);
  await expect(page.locator('.thinking')).toHaveCount(0);
  await page.getByRole('button',{name:'框选区域',exact:true}).click();
  const box=await page.locator('.pdf-page').boundingBox();if(!box)throw new Error('page missing');
  await page.mouse.move(box.x+40,box.y+100);await page.mouse.down();await page.mouse.move(box.x+180,box.y+180,{steps:6});
  await page.keyboard.press('Escape');await page.mouse.up();
  await expect(page.getByAltText('即将发送的公式截图')).toHaveCount(0);
});

test('声音设置明确区分本机演示和自然语音模型',async({page})=>{
  await page.goto('/');
  await expect(page.locator('.audio-kind')).toHaveText('本机合成语音 · 演示');
  await page.getByRole('button',{name:'声音设置',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('自然语音模型尚未连接');
  await expect(dialog).toContainText('TTS_MODEL=gpt-4o-mini-tts');
  await expect(dialog).toContainText('实时插话尚未接入');
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
});
