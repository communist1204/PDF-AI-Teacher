import { expect, test, type Page } from '@playwright/test';
import { mockCloudSpeech } from './cloudSpeechHarness';

async function selectText(page: Page, reopen = false) {
  if (!reopen) await page.getByRole('button', {name:/示例/}).click();
  await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
  const span=page.locator('.textLayer span').filter({hasText:'指数移动平均将过去'}).first();await expect(span).toBeVisible();const box=(await span.boundingBox())!;
  await page.mouse.move(box.x+1,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width-1,box.y+box.height/2,{steps:12});await page.mouse.up();
}

test('解题为演示时云音频仍可读原文与讲解，暂停续读和刷新恢复均不回退系统声音',async({page})=>{
  await mockCloudSpeech(page);const speech:string[]=[];const remote:string[]=[];page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/tts')speech.push(request.postDataJSON().text);if(url.protocol.startsWith('http')&&!['127.0.0.1','localhost'].includes(url.hostname))remote.push(request.url());});
  await page.goto('/');await selectText(page);await expect(page.locator('.audio-kind')).toHaveText('豆包 2.0 AI 语音 · 云端');
  await page.getByRole('button',{name:'朗读所选',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');const source=await page.getByTestId('reading-subtitle').textContent();
  await page.getByRole('button',{name:'暂停朗读',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('已暂停');
  await page.getByRole('button',{name:'继续朗读',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  await page.getByRole('textbox',{name:'输入文字问题'}).fill('这里的历史权重怎样相加？');await page.getByRole('button',{name:'发送问题',exact:true}).click();await expect(page.locator('.message.assistant')).toBeVisible();
  await page.getByRole('button',{name:'听这次讲解',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');
  await page.getByRole('button',{name:'回原文继续',exact:true}).click();await expect(page.getByTestId('reading-subtitle')).toHaveText(source??'');expect(speech.length).toBeGreaterThan(2);expect(remote).toEqual([]);
  await page.getByRole('button',{name:'停止',exact:true}).click();await page.reload();await expect(page.locator('.textLayer span').first()).toBeVisible();await expect(page.locator('main')).toHaveAttribute('aria-busy','false');
  await page.getByRole('button',{name:'继续朗读',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');await expect(page.getByTestId('reading-subtitle')).toHaveText(source??'');
  await page.getByRole('button',{name:'停止',exact:true}).click();
});

test('未连接解题模型可独立使用已配置豆包，缺少语音凭证时不发请求',async({page})=>{
  await mockCloudSpeech(page);let ready=false;const speech:string[]=[];
  await page.route('**/api/config',async route=>{const response=await route.fetch();const config=await response.json();await route.fulfill({json:{...config,mode:'unconfigured',capabilities:{...config.capabilities,tts:ready?'supported':'unconfigured'},speech:{engine:'doubao',ready,voice:'mock',style:'模拟',instructionsSupported:true}}});});
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/tts')speech.push(request.postDataJSON().text);});
  await page.goto('/');await selectText(page);await page.getByRole('button',{name:'朗读所选',exact:true}).click();await expect(page.getByRole('alert')).toContainText('豆包语音尚未配置');expect(speech).toEqual([]);
  ready=true;await page.reload();await selectText(page,true);await page.getByRole('button',{name:'朗读所选',exact:true}).click();await expect(page.locator('.audio-source strong')).toContainText('正在朗读');expect(speech.length).toBeGreaterThan(0);await page.getByRole('button',{name:'停止',exact:true}).click();
});

test('云语音取消记录不误标成本地免费',async({page})=>{
  await mockCloudSpeech(page);await page.route('**/api/usage',route=>route.fulfill({json:{records:[{category:'tts',model:'MOCK_DOUBAO_NOT_PAID',requestId:'mock-cloud-cancel',cancelled:true,inputTokens:null,outputTokens:null,characters:12}],requestCount:1,maxRequests:100,cache:{entries:0,bytes:0,maxBytes:33554432}}}));
  await page.goto('/');await page.getByRole('button',{name:'声音设置',exact:true}).click();await page.locator('.usage-details summary').click();const row=page.locator('.usage-details tbody tr').first();
  await expect(row).toContainText('可能已计费');await expect(row).not.toContainText('本地免费');
});
