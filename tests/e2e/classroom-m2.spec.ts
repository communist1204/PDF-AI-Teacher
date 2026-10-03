import { mockCloudSpeech } from './cloudSpeechHarness';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

async function sample(page:Page){await page.goto('/');await page.getByRole('button',{name:/示例/}).click();await expect(page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first()).toBeVisible();await expect(page.locator('main')).toHaveAttribute('aria-busy','false');}
async function select(page:Page){const text=page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first();const b=await text.boundingBox();if(!b)throw Error('text missing');await page.mouse.move(b.x+1,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width-1,b.y+b.height/2,{steps:12});await page.mouse.up();await expect(page.locator('.selection-preview')).toContainText('指数移动平均');}
const mockSpeech = mockCloudSpeech;
async function finishWhile(page:Page,label:string){for(let i=0;i<35;i++){if(!(await page.locator('.classroom-progress').textContent())?.includes(label))return;await page.evaluate(()=>(window as unknown as {__speech:{finish:()=>void}}).__speech.finish());await page.waitForTimeout(30);}throw Error('audio did not complete');}
async function saved(page:Page){return page.evaluate(async()=>new Promise<Record<string,unknown>[]>((resolve,reject)=>{const open=indexedDB.open('pdf-ai-teacher-learning');open.onsuccess=()=>{const db=open.result;const request=db.transaction('books').objectStore('books').getAll();request.onsuccess=()=>{resolve(request.result);db.close();};request.onerror=()=>reject(request.error);};open.onerror=()=>reject(open.error);}));}
async function ask(page:Page,text:string){await page.getByRole('textbox',{name:'输入文字问题'}).fill(text);await page.getByRole('button',{name:'发送问题',exact:true}).click();await expect(page.locator('.message.assistant').last()).toBeVisible();}
async function settings(page:Page){await page.getByRole('button',{name:'设置与用量',exact:true}).click();}

test('逐段陪读先原文后教案、先板书后语音，打断后回原步骤并恢复',async({page})=>{
  await mockSpeech(page);await sample(page);await select(page);
  await page.locator('.classroom-controls summary').click();await page.getByRole('button',{name:'开始陪读',exact:true}).click();
  await expect(page.locator('.classroom-progress')).toContainText('正在读原文');await expect(page.getByTestId('board-step')).toHaveCount(0);
  await finishWhile(page,'正在读原文');await expect(page.locator('.classroom-progress')).toContainText('正在讲解');
  await expect(page.getByTestId('board-step')).toHaveCount(1);await expect(page.locator('.active-step')).toContainText('演示范围');
  await finishWhile(page,'正在讲解');await expect(page.locator('.classroom-progress')).toContainText('停一停');
  await expect(page.getByTestId('board-step')).toHaveCount(1);
  await page.getByRole('button',{name:'继续陪读',exact:true}).click();await expect(page.getByTestId('board-step')).toHaveCount(2);
  await expect(page.getByRole('img',{name:'教学计算图'})).toBeVisible();const before=await page.getByTestId('reading-subtitle').textContent();
  await ask(page,'为什么历史权重要这样变化？');await expect(page.locator('.classroom-progress')).toContainText('已中断');
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  await page.getByRole('button',{name:'继续陪读',exact:true}).click();await expect(page.locator('.active-step')).toContainText('EMA 与零初始化');
  await expect(page.getByTestId('reading-subtitle')).toHaveText(before??'');
  await page.getByRole('button',{name:'停止',exact:true}).click();
  await expect.poll(async()=>(await saved(page))[0]?.teachingProgress).toBeTruthy();
  await page.screenshot({path:'docs/screenshots/m2-classroom.png',fullPage:true});
  await page.reload();await expect(page.locator('.textLayer span').first()).toBeVisible();await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
  await page.locator('.classroom-controls summary').click();await expect(page.locator('.classroom-progress')).toContainText('已中断');
  expect(await page.evaluate(()=>(window as unknown as {__speech:{texts:string[]}}).__speech.texts.length)).toBe(0);
  await page.getByRole('button',{name:'继续陪读',exact:true}).click();await expect(page.locator('.classroom-progress')).toContainText('正在讲解');
  await expect(page.locator('.active-step')).toContainText('EMA 与零初始化');
});

test('校对文本拥有新版本，刷新恢复书签但不自动发声',async({page})=>{
  await mockSpeech(page);await sample(page);await select(page);
  await page.getByRole('button',{name:'校对朗读文本',exact:true}).click();
  await page.getByRole('textbox',{name:'确认后的朗读文本'}).fill('beta 一的 t 次方。然后继续第二句。');
  await page.getByRole('button',{name:'使用校对文本',exact:true}).click();await page.getByRole('button',{name:'朗读所选',exact:true}).click();
  await expect(page.getByTestId('reading-subtitle')).toHaveText('beta 一的 t 次方。');
  await page.evaluate(()=>(window as unknown as {__speech:{finish:()=>void}}).__speech.finish());
  await expect(page.getByTestId('reading-subtitle')).toHaveText('然后继续第二句。');
  await page.getByRole('button',{name:'暂停朗读',exact:true}).click();
  await expect.poll(async()=>((await saved(page))[0]?.readingBookmark as {cursor:{sentenceIndex:number}})?.cursor.sentenceIndex).toBe(1);
  await page.reload();await expect(page.locator('.textLayer span').first()).toBeVisible();await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
  await expect(page.getByRole('button',{name:'继续朗读',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>(window as unknown as {__speech:{texts:string[]}}).__speech.texts.length)).toBe(0);
  await page.getByRole('button',{name:'继续朗读',exact:true}).click();await expect(page.getByTestId('reading-subtitle')).toHaveText('然后继续第二句。');
});

test('JSON/Markdown导出、清书记录及导入恢复，其他书不被删除',async({page})=>{
  await sample(page);await select(page);await ask(page,'请解释这里的权重。');
  await page.locator('.notes summary').click();await page.getByRole('textbox',{name:'本书本地笔记',exact:true}).fill('需要复习 beta 的幂。');
  await expect.poll(async()=>(await saved(page))[0]?.note).toBe('需要复习 beta 的幂。');
  await settings(page);const jsonDownload=page.waitForEvent('download');await page.getByRole('button',{name:'导出学习 JSON',exact:true}).click();const json=await readFile(await (await jsonDownload).path(),'utf8');
  const record=JSON.parse(json);expect(record.entries.length).toBe(1);expect(json).not.toMatch(/csrfToken|OPENAI_API_KEY|sessionId/);
  const mdDownload=page.waitForEvent('download');await page.getByRole('button',{name:'导出笔记 Markdown',exact:true}).click();const markdown=await readFile(await (await mdDownload).path(),'utf8');expect(markdown).toContain('需要复习 beta');expect(markdown).toContain('latex');
  await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  const different=await PDFDocument.load(await readFile('public/sample.pdf'));different.removePage(0);
  await page.locator('input[type=file]').setInputFiles({name:'sample.pdf',mimeType:'application/pdf',buffer:Buffer.from(await different.save())});await expect(page.getByRole('spinbutton',{name:'PDF 页序号'})).toHaveAttribute('max','1');await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
  await page.getByRole('textbox',{name:'本书本地笔记',exact:true}).fill('另一本书的笔记');
  await expect(page.getByRole('textbox',{name:'本书本地笔记',exact:true})).toHaveValue('另一本书的笔记');
  await expect.poll(async()=>(await saved(page)).find(item=>(item.document as {documentId:string}).documentId!==record.document.documentId)?.note).toBe('另一本书的笔记');
  await page.locator('input[type=file]').setInputFiles('public/sample.pdf');await expect(page.getByRole('spinbutton',{name:'PDF 页序号'})).toHaveAttribute('max','2');await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
  await expect(page.getByRole('textbox',{name:'本书本地笔记',exact:true})).toHaveValue('需要复习 beta 的幂。');
  await settings(page);await page.getByRole('button',{name:'删除本书记录',exact:true}).click();await page.getByRole('button',{name:'确认删除本书记录',exact:true}).click();
  await expect.poll(async()=>(await saved(page)).length).toBe(1);await page.waitForTimeout(350);expect((await saved(page))[0].note).toBe('另一本书的笔记');
  await expect(page.locator('.message')).toHaveCount(0);
  await page.getByLabel('导入学习记录文件').setInputFiles({name:'learning.json',mimeType:'application/json',buffer:Buffer.from(json)});
  await expect(page.getByRole('dialog')).toContainText('学习记录已导入');
  await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  await expect(page.locator('.message.assistant')).toHaveCount(1);await expect(page.getByRole('textbox',{name:'本书本地笔记',exact:true})).toHaveValue('需要复习 beta 的幂。');
});

test('存储配额错误保留页面内容，可导出且不静默丢记录',async({page})=>{
  await page.addInitScript(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore['put']>){if(this.name==='books'&&(window as unknown as {__quotaFull:boolean}).__quotaFull)throw new DOMException('full','QuotaExceededError');return put.apply(this,args);};});
  await sample(page);await select(page);await expect.poll(async()=>(await saved(page)).length).toBe(1);await page.evaluate(()=>{(window as unknown as {__quotaFull:boolean}).__quotaFull=true;});await ask(page,'请解释当前原文。');
  await expect(page.getByRole('alert')).toContainText('存储已满');await expect(page.getByTestId('board-step')).toHaveCount(3);
  await settings(page);const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出学习 JSON',exact:true}).click();expect((await download).suggestedFilename()).toBe('pdf-teacher-learning.json');
});

test('导入记录含跨书来源或额外凭证字段会被拒绝',async({page})=>{
  await sample(page);await select(page);await ask(page,'解释所选文字。');await expect.poll(async()=>(await saved(page)).length).toBe(1);
  const record=(await saved(page))[0];await settings(page);
  await page.getByLabel('导入学习记录文件').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...record,csrfToken:'not-a-real-token'}))});
  await expect(page.getByRole('alert')).toBeVisible();await expect(page.locator('.message.assistant')).toHaveCount(1);
});

test('讲解结束后可回原文继续，连续20次文字打断不丢句级位置（音频模拟）',async({page})=>{
  await mockSpeech(page);await sample(page);await select(page);
  await page.getByRole('button',{name:'朗读所选',exact:true}).click();
  await page.evaluate(()=>(window as unknown as {__speech:{finish:()=>void}}).__speech.finish());
  await expect(page.getByTestId('reading-subtitle')).not.toHaveText('');const sentence=await page.getByTestId('reading-subtitle').textContent();
  await ask(page,'请讲一下这个步骤。');
  await page.getByRole('button',{name:'讲这一步',exact:true}).first().click();
  await page.locator('.classroom-controls summary').click();
  await finishWhile(page,'正在讲解');await expect(page.locator('.classroom-progress')).toContainText('停一停');
  await page.getByRole('button',{name:'回原文继续',exact:true}).click();await expect(page.getByTestId('reading-subtitle')).toHaveText(sentence??'');
  for(let i=0;i<20;i++){
    await ask(page,`第 ${i+1} 次追问：这个系数代表什么？`);
    await expect(page.locator('.message.assistant')).toHaveCount(i+2);
    await page.getByRole('button',{name:'继续朗读',exact:true}).click();
    await expect(page.getByTestId('reading-subtitle')).toHaveText(sentence??'');
  }
  await page.getByRole('button',{name:'停止',exact:true}).click();
  await expect(page.locator('.audio-source strong')).toContainText('待机');
});

test('记录替换期间不能重开保存，关闭再打开设置也保持操作锁',async({page})=>{
  await page.addInitScript(()=>{
    const original=IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete=function(key:IDBValidKey|IDBKeyRange){
      if(this.name==='books'){
        const tx=this.transaction;const done=tx.oncomplete;
        tx.oncomplete=function(event){(window as unknown as {__releaseDelete:()=>void}).__releaseDelete=()=>done?.call(tx,event);};
      }
      return original.call(this,key);
    };
  });
  await sample(page);await select(page);await ask(page,'保存后检查删除竞态。');
  await expect.poll(async()=>((await saved(page))[0]?.entries as unknown[])?.length).toBe(1);
  await settings(page);await page.getByRole('button',{name:'删除本书记录',exact:true}).click();
  await page.getByRole('button',{name:'确认删除本书记录',exact:true}).click();
  await expect(page.getByRole('button',{name:'确认删除本书记录',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'重新开启本书自动保存',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'关闭设置',exact:true}).click();await settings(page);
  await expect(page.getByRole('button',{name:'重新开启本书自动保存',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'导入学习记录',exact:true})).toBeDisabled();
  await expect.poll(async()=>page.evaluate(()=>typeof (window as unknown as {__releaseDelete:unknown}).__releaseDelete)).toBe('function');
  await page.evaluate(()=>(window as unknown as {__releaseDelete:()=>void}).__releaseDelete());
  await expect(page.getByRole('button',{name:'重新开启本书自动保存',exact:true})).toBeEnabled();
  await expect(page.locator('.message')).toHaveCount(0);
  await page.waitForTimeout(350);expect(await saved(page)).toHaveLength(0);
});
