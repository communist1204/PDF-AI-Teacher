import {packager} from '@electron/packager';
import {resolve,dirname} from 'node:path';
import {readFile} from 'node:fs/promises';
const root=process.cwd();const out=resolve(root,'release');if(dirname(out)!==root)throw Error('Unsafe package directory');
const pkg=JSON.parse(await readFile('package.json','utf8'));
const paths=await packager({dir:resolve(root,'desktop-build'),out,name:'PDF AI Teacher',executableName:'PDF AI Teacher',platform:'win32',arch:'x64',electronVersion:pkg.devDependencies.electron,asar:true,overwrite:true,prune:false,extraResource:[resolve(root,'local-tts-runtime'),resolve(root,'qwen-tts-runtime')],icon:resolve(root,'assets/app.ico'),download:{checksums:JSON.parse(await readFile('node_modules/electron/checksums.json','utf8'))},win32metadata:{ProductName:'PDF AI Teacher',FileDescription:'PDF AI Teacher - 本机学习工作台',CompanyName:'PDF AI Teacher'}});
console.log(paths.join('\n'));
