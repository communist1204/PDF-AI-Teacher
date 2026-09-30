import {_electron as electron,expect} from '@playwright/test';
import {resolve} from 'node:path';import {writeFile} from 'node:fs/promises';
const env={...process.env,PDF_TEACHER_DATA_DIR:resolve('test-results','login-open-'+Date.now()),PDF_TEACHER_TEST_MODE:'1'};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:resolve('release/PDF AI Teacher-win32-x64/PDF AI Teacher.exe'),args:[],env,timeout:45000});
try{
 await app.evaluate(({shell})=>{const original=shell.openExternal.bind(shell);globalThis.__loginOpen=[];shell.openExternal=async(url,options)=>{const parsed=new URL(url);const entry={origin:parsed.origin,path:parsed.pathname,opened:false};globalThis.__loginOpen.push(entry);await original(url,options);entry.opened=true;};});
 const page=await app.firstWindow();await page.getByRole('button',{name:'设置与用量',exact:true}).click();await page.getByRole('button',{name:'使用 ChatGPT 登录',exact:true}).click();
 await expect.poll(()=>app.evaluate(()=>globalThis.__loginOpen),{timeout:20000}).toEqual([{origin:'https://auth.openai.com',path:'/api/accounts/authorize',opened:true}]);
 await expect(page.getByRole('button',{name:'取消登录',exact:true})).toBeVisible();await expect(page.locator('.desktop-account-card [role=alert]')).toHaveCount(0);
 await page.screenshot({path:'docs/screenshots/desktop-login-opened.png',fullPage:true});
 const result={date:new Date().toISOString(),packagedExe:true,realButtonClicked:true,discoveryNotMocked:true,systemBrowserCall:await app.evaluate(()=>globalThis.__loginOpen),loginPending:true,authorizationCompleted:false,paidCalls:0};
 await writeFile('docs/desktop-login-opened.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
 await page.getByRole('button',{name:'取消登录',exact:true}).click();await expect(page.locator('.desktop-account-card')).toContainText('已取消本次登录');
}finally{await app.close();}
