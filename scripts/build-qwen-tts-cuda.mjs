import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, createReadStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, '.model-cache/qwen-native-source');
const build = resolve(root, '.model-cache/qwen-native-cuda-build');
const commit = '6fae92914045cd83364d2845ceaa0f7969727319';
const ggmlCommit = '40e16e4a814f7fe851a0c486fb9e8c722e957830';
const vsRoot = process.env.PDF_AI_VS_ROOT || 'C:/BuildTools';
const cudaRoot = process.env.PDF_AI_CUDA_ROOT || 'C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.9';
if (!existsSync(resolve(cudaRoot, 'bin/nvcc.exe'))) throw new Error('Existing CUDA toolkit not found; this script does not install or modify CUDA.');
const cmake = resolve(vsRoot, 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe');
if (process.platform !== 'win32') throw new Error('This build recipe targets Windows x64 with an existing Visual Studio C++ toolchain.');
if (!existsSync(cmake)) throw new Error('Existing CMake not found. Set PDF_AI_VS_ROOT to the existing Visual Studio installation; do not install global tools.');
mkdirSync(resolve(root, '.model-cache'), { recursive: true });
function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, { cwd, windowsHide: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.status}`);
  return (result.stdout || '').trim();
}
function git(args, cwd = source, capture = false) {
  return run('git', ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, ...args], cwd, capture);
}
if (!existsSync(resolve(source, '.git'))) {
  run('git', ['clone', '--no-checkout', 'https://github.com/ServeurpersoCom/qwentts.cpp.git', source]);
  git(['checkout', '--detach', commit]);
}
const current = git(['rev-parse', 'HEAD'], source, true);
if (current !== commit) {
  if (git(['status', '--porcelain'], source, true)) throw new Error('Native source has local changes; refusing to replace it.');
  git(['fetch', 'origin', commit]);
  git(['checkout', '--detach', commit]);
}
git(['submodule', 'update', '--init', '--recursive']);
if (git(['rev-parse', 'HEAD'], resolve(source, 'ggml'), true) !== ggmlCommit) throw new Error('Unexpected GGML revision.');
const patches = ['scripts/qwen-tts-native.patch', 'scripts/qwen-tts-windows-utf8.patch'].map(path => resolve(root, path));
for (const patch of patches) {
const reverse = spawnSync('git', ['-c', `safe.directory=${source.replaceAll('\\', '/')}`, 'apply', '--ignore-space-change', '--reverse', '--check', patch], { cwd: source, windowsHide: true, encoding: 'utf8' });
if (reverse.status !== 0) {
  git(['apply', '--ignore-space-change', '--check', patch]);
  git(['apply', '--ignore-space-change', patch]);
}
}
// Builds against the existing CUDA 12.9 toolkit only. No driver, toolkit, Conda, Python, or global environment changes.
const off = ['VULKAN', 'METAL', 'SYCL', 'HIP', 'HIPBLAS', 'BLAS', 'OPENCL', 'RPC', 'CANN', 'WEBGPU', 'HEXAGON', 'OPENMP', 'BACKEND_DL'];
run(cmake, ['-S', source, '-B', build, '-G', 'Visual Studio 17 2022', '-A', 'x64', '-T', `cuda=${cudaRoot}`, `-DCMAKE_GENERATOR_INSTANCE=${vsRoot}`, '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=ON', '-DGGML_CPU=ON', '-DGGML_CUDA=ON', '-DGGML_STATIC=ON', '-DGGML_CUDA_GRAPHS=ON', '-DCMAKE_CUDA_ARCHITECTURES=120a-real', ...off.map(name => `-DGGML_${name}=OFF`)]);
run(cmake, ['--build', build, '--config', 'Release', '--target', 'qwen-tts', 'test-abi-c', '--parallel', '2', '--', '/verbosity:quiet', '/clp:ErrorsOnly']);
const runtimeDlls = ['cublas64_12.dll', 'cublasLt64_12.dll'];
for (const dll of runtimeDlls) copyFileSync(resolve(cudaRoot, 'bin', dll), resolve(build, 'Release', dll));
copyFileSync(resolve(cudaRoot, 'EULA.txt'), resolve(build, 'Release/LICENSE-NVIDIA-CUDA.txt'));
run(resolve(build, 'Release/test-abi-c.exe'), []);
const exe = resolve(build, 'Release/qwen-tts.exe');
const files = [];
for (const name of ['qwen-tts.exe', ...runtimeDlls]) {
  const file = resolve(build, 'Release', name);
  const hash = createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  files.push({ name, size: statSync(file).size, sha256: hash.digest('hex') });
}
writeFileSync(resolve(build, 'Release/manifest.json'), JSON.stringify({ source: 'https://github.com/ServeurpersoCom/qwentts.cpp', commit, ggmlCommit, device: 'CUDA0', cudaVersion: '12.9', sm: '120a', windowsUtf8Argv: true, files }, null, 2));
if (!existsSync(exe)) throw new Error('Native CLI output is missing.');
writeFileSync(resolve(build, 'build-provenance.json'), JSON.stringify({ source: 'https://github.com/ServeurpersoCom/qwentts.cpp', commit, ggmlCommit, cpuOnly: false, gpu: 'NVIDIA SM120a', cudaVersion: '12.9', defaultThreads: 2, allowedThreads: [2, 4], env: 'PDF_AI_TTS_THREADS', cmake, exe, patches: patches.map(patch => readFileSync(patch, 'utf8')) }, null, 2));
const runtime = resolve(root, 'qwen-tts-runtime/bin-cuda');
mkdirSync(runtime, { recursive: true });
for (const name of ['qwen-tts.exe', ...runtimeDlls, 'manifest.json', 'LICENSE-NVIDIA-CUDA.txt']) copyFileSync(resolve(build, 'Release', name), resolve(runtime, name));
copyFileSync(resolve(build, 'build-provenance.json'), resolve(runtime, 'build-provenance.json'));
console.log(`CUDA Qwen TTS installed: ${runtime}`);
console.log('Child environment GGML_BACKEND=CUDA0, PDF_AI_TTS_THREADS=2 (default) or 4. Input UTF-8 stdin; --max-new caps audio frames. No model inference has been performed by this script.');
