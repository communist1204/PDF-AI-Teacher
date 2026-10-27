import {packager} from '@electron/packager';
import {resolve,dirname} from 'node:path';
import {readFile} from 'node:fs/promises';
const root=process.cwd();const out=resolve(root,'release');if(dirname(out)!==root)throw Error('Unsafe package directory');
const pkg=JSON.parse(await readFile('package.json','utf8'));
const paths=await packager({dir:resolve(root,'desktop-build'),out,name:'QingRead',executableName:'QingRead',platform:'win32',arch:'x64',electronVersion:pkg.devDependencies.electron,asar:{unpack:'**/windows-ocr.ps1'},overwrite:true,prune:false,icon:resolve(root,'assets/qingread.ico'),download:{checksums:JSON.parse(await readFile('node_modules/electron/checksums.json','utf8'))},win32metadata:{ProductName:'轻读',FileDescription:'轻读 - 截图朗读工具',CompanyName:'QingRead'}});
console.log(paths.join('\n'));
