import {build} from 'esbuild';
import {cp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
const root=process.cwd();const stage=resolve(root,'desktop-build');
if(dirname(stage)!==root||!stage.endsWith('desktop-build'))throw Error('Unsafe build directory');
await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
await build({entryPoints:['apps/desktop/main.ts'],outfile:resolve(stage,'main.cjs'),bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron','bufferutil','utf-8-validate'],logLevel:'info'});
await build({entryPoints:['apps/desktop/preload.ts'],outfile:resolve(stage,'preload.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'info'});
await cp(resolve(root,'dist'),resolve(stage,'dist'),{recursive:true});await cp(resolve(root,'assets'),resolve(stage,'assets'),{recursive:true});
const pkg=JSON.parse(await readFile('package.json','utf8'));
await writeFile(resolve(stage,'package.json'),JSON.stringify({name:'pdf-ai-teacher-desktop',productName:'PDF AI Teacher',version:pkg.version,private:true,main:'main.cjs',description:'本机 PDF 阅读与 AI 教学工作台'},null,2));
await writeFile(resolve(stage,'LICENSES.txt'),'Electron / Chromium licenses are included in the distribution. PDF.js bundled assets retain their upstream licenses.\n');
console.log('Desktop application built: '+stage);

// The native CPU runtime stays outside asar, separate from account data.
const runtime=resolve(root,'local-tts-runtime');
await mkdir(runtime,{recursive:true});
await cp(resolve(root,'scripts/local-tts-worker.cjs'),resolve(runtime,'local-tts-worker.cjs'));
if((await import('node:fs')).existsSync(resolve(root,'assets/third-party-tts')))await cp(resolve(root,'assets/third-party-tts'),resolve(runtime,'licenses'),{recursive:true});
