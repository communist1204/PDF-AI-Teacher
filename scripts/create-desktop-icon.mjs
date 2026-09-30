import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{const page=await browser.newPage({viewport:{width:256,height:256},deviceScaleFactor:1});await page.setContent('<style>body{margin:0;background:transparent}</style>'+await readFile('assets/app.svg','utf8'));const png=await page.locator('svg').screenshot({omitBackground:true});await writeFile('assets/app.png',png);const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);await writeFile('assets/app.ico',Buffer.concat([header,png]));}finally{await browser.close();}
