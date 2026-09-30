import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { QwenTtsProvider, QWEN_CODEC, QWEN_TALKER, validateQwenWave, type QwenTtsOptions } from '../../apps/server/src/qwenTts';
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: spawnMock }));
vi.mock('node:fs', async original => { const actual = await original<typeof import('node:fs')>(); return { ...actual, statSync: vi.fn(actual.statSync) }; });
vi.mock('node:fs/promises', async original => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) }; });
class FakeChild extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  stdout = Object.assign(new EventEmitter(), { resume: vi.fn() });
  stderr = new EventEmitter();
  kill = vi.fn(() => { queueMicrotask(() => this.emit('close', null)); return true; });
  constructor(readonly args: string[]) { super(); }
  async complete(audio: Buffer = wave(), code = 0) { await writeFile(this.args[this.args.indexOf('-o') + 1], audio); this.emit('close', code); }
}
function wave() {
  const value = Buffer.alloc(48);
  value.write('RIFF', 0); value.writeUInt32LE(40, 4); value.write('WAVEfmt ', 8); value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22); value.writeUInt32LE(24000, 24); value.writeUInt32LE(48000, 28);
  value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34); value.write('data', 36); value.writeUInt32LE(4, 40);
  value.writeInt16LE(3210, 44); value.writeInt16LE(-3210, 46); return value;
}
const testRoot = resolve('test-results');
let directory = '';
let options: QwenTtsOptions;
let children: FakeChild[] = [];
let resources: Map<string, number>;
let actualFs: typeof import('node:fs');
let actualPromises: typeof import('node:fs/promises');
const owned: QwenTtsProvider[] = [];
function provider(patch: Partial<QwenTtsOptions> = {}) { const value = new QwenTtsProvider({ ...options, ...patch }); owned.push(value); return value; }
async function running(value = provider(), controller = new AbortController(), text = '二零二六年，先看这句话。') {
  const count = children.length; const promise = value.speak(text, 1, controller.signal); void promise.catch(() => {});
  await vi.waitFor(() => expect(children).toHaveLength(count + 1)); return { promise, child: children[count], controller, value };
}
beforeAll(async () => {
  actualFs = await vi.importActual('node:fs'); actualPromises = await vi.importActual('node:fs/promises');
  await mkdir(testRoot, { recursive: true }); directory = await mkdtemp(join(testRoot, 'qwen-unit-'));
  options = { runtimePath: join(directory, 'runtime'), workPath: join(directory, 'work'), voice: 'serena', instructions: '自然平和地朗读。' };
});
beforeEach(() => {
  children = [];
  resources = new Map([[join(options.runtimePath, 'bin', 'qwen-tts.exe'), 100], [join(options.runtimePath, 'model', QWEN_TALKER), 1182631296], [join(options.runtimePath, 'model', QWEN_CODEC), 291150624], [join(options.runtimePath, 'model', 'manifest.json'), 100]]);
  vi.mocked(statSync).mockImplementation((path, opts) => resources.has(String(path)) ? { isFile: () => true, size: resources.get(String(path)) } as ReturnType<typeof statSync> : actualFs.statSync(path, opts));
  vi.mocked(readFile).mockReset().mockImplementation(actualPromises.readFile); vi.mocked(stat).mockReset().mockImplementation(actualPromises.stat);
  spawnMock.mockReset().mockImplementation((_exe: string, args: string[]) => { const child = new FakeChild(args); children.push(child); return child; });
});
afterEach(() => { owned.splice(0).forEach(value => value.dispose()); vi.useRealTimers(); vi.unstubAllEnvs(); });
afterAll(async () => { if (!directory.startsWith(testRoot + sep)) throw Error('Unsafe fixture path'); await rm(directory, { recursive: true, force: true }); });

describe('Qwen CPU child adapter (mock process, real temporary files)', () => {
  it('checks complete executable, both large model files and manifest before claiming readiness', async () => {
    expect(provider().ready()).toBe(true);
    for (const [file, size] of resources) { resources.set(file, 0); expect(provider().ready()).toBe(false); resources.set(file, size); }
    resources.set(join(options.runtimePath, 'model', QWEN_TALKER), 100);
    await expect(provider().speak('你好', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'qwen_tts_missing' }); expect(spawnMock).not.toHaveBeenCalled();
  });
  it('validates voice/style/text/speed and pre-aborted input before spawning', async () => {
    for (const voice of ['serena', 'vivian', 'uncle_fu']) expect(provider({ voice }).ready()).toBe(true);
    expect(() => provider({ voice: '../other' })).toThrow('音色'); expect(() => provider({ instructions: 'x'.repeat(1001) })).toThrow('1000'); expect(() => provider({ instructions: 'bad\0style' })).toThrow('1000');
    const value = provider();
    for (const text of ['', ' \n', 'x'.repeat(6001), 'a\0b']) await expect(value.speak(text, 1, new AbortController().signal)).rejects.toMatchObject({ code: 'qwen_tts_text' });
    for (const speed of [NaN, Infinity, 0.24, 2.01]) await expect(value.speak('文本', speed, new AbortController().signal)).rejects.toMatchObject({ code: 'qwen_tts_speed' });
    await expect(value.speak('文本', 1, AbortSignal.abort())).rejects.toMatchObject({ code: 'qwen_tts_cancelled' }); expect(spawnMock).not.toHaveBeenCalled();
  });
  it('sends private original text only through stdin and isolates CPU environment from credentials', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-private-test'); vi.stubEnv('NODE_OPTIONS', '--inspect=secret'); vi.stubEnv('HTTPS_PROXY', 'private-proxy');
    const original = '私有原文 & $(do-not-run)\n“只读这些字”'; const run = await running(provider(), new AbortController(), original);
    const [exe, args, settings] = spawnMock.mock.calls[0]; expect(exe).toBe(join(options.runtimePath, 'bin', 'qwen-tts.exe')); expect(JSON.stringify(args)).not.toContain(original);
    expect(settings).toMatchObject({ windowsHide: true, shell: false, cwd: join(options.runtimePath, 'bin'), stdio: ['pipe', 'pipe', 'pipe'] });
    expect(settings.env).toMatchObject({ GGML_BACKEND: 'CPU', PDF_AI_TTS_THREADS: '2' }); expect(JSON.stringify(settings.env)).not.toMatch(/sk-private-test|--inspect|private-proxy/);
    expect(run.child.stdin.end).toHaveBeenCalledWith(original, 'utf8'); expect(args).not.toContain('--speed'); await run.child.complete(); expect((await run.promise).audio).toEqual(wave()); expect(await readdir(options.workPath)).toEqual([]);
  });
  it('serializes generation, kills only its owned process on cancellation, then accepts a new sentence', async () => {
    const run = await running(); await expect(run.value.speak('第二句', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'qwen_tts_busy' }); run.controller.abort('private cancel reason');
    await expect(run.promise).rejects.toMatchObject({ code: 'qwen_tts_cancelled' }); expect(run.child.kill).toHaveBeenCalledOnce(); expect(await readdir(options.workPath)).toEqual([]);
    const next = await running(run.value); await next.child.complete(); await expect(next.promise).resolves.toMatchObject({ audio: wave() }); expect(next.child.kill).not.toHaveBeenCalled();
  });
  it('does not release the active slot until the cancelled process closes', async () => {
    const run = await running(); run.child.kill.mockImplementation(() => true); run.controller.abort();
    await expect(run.value.speak('第二句', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'qwen_tts_busy' });
    expect(await readdir(options.workPath)).toHaveLength(1); run.child.emit('close', null);
    await expect(run.promise).rejects.toMatchObject({ code: 'qwen_tts_cancelled' }); expect(await readdir(options.workPath)).toEqual([]);
  });
  it('dispose stops active generation and permanently closes this provider', async () => {
    const run = await running(); run.value.dispose(); await expect(run.promise).rejects.toMatchObject({ code: 'qwen_tts_cancelled' });
    expect(run.child.kill).toHaveBeenCalledOnce(); expect(run.value.ready()).toBe(false); await expect(run.value.speak('下一句', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'qwen_tts_closed' });
  });
  it('returns safe process failures without exposing original text or diagnostic contents', async () => {
    const run = await running(); run.child.stderr.emit('data', Buffer.from('private-book-text sk-secret')); run.child.emit('close', 1);
    await expect(run.promise).rejects.toMatchObject({ code: 'qwen_tts_failed', message: expect.not.stringContaining('private-book-text') }); expect(await readdir(options.workPath)).toEqual([]);
  });
  it('handles stdin failure by stopping the owned child and removing temporary data', async () => {
    const run = await running(); run.child.stdin.emit('error', Error('private-book-text')); await expect(run.promise).rejects.toMatchObject({ code: 'qwen_tts_failed' });
    expect(run.child.kill).toHaveBeenCalledOnce(); expect(await readdir(options.workPath)).toEqual([]);
  });
  it('rejects capped generation even when the child exits successfully with a valid WAV', async () => {
    const run = await running(); run.child.stderr.emit('data', Buffer.from('PDF_AI_TTS_FRAME_')); run.child.stderr.emit('data', Buffer.from('LIMIT_REACHED'));
    await run.child.complete(); await expect(run.promise).rejects.toMatchObject({ code: 'qwen_tts_truncated' }); expect(await readdir(options.workPath)).toEqual([]);
  });
  it('cannot lose a truncation marker when later diagnostics exceed the retained tail', async () => {
    const run = await running(); run.child.stderr.emit('data', Buffer.from('PDF_AI_TTS_FRAME_LIMIT_REACHED')); run.child.stderr.emit('data', Buffer.from('x'.repeat(70000)));
    await run.child.complete(); await expect(run.promise).rejects.toMatchObject({ code: 'qwen_tts_truncated' });
  });
  it('checks cancellation after asynchronous WAV reading, not only before reading', async () => {
    let release!: (buffer: Buffer) => void; vi.mocked(readFile).mockImplementation(() => new Promise<Buffer>(resolve => { release = resolve; }) as ReturnType<typeof readFile>);
    const run = await running(); await run.child.complete(); await vi.waitFor(() => expect(readFile).toHaveBeenCalledOnce()); run.controller.abort(); release(wave());
    await expect(run.promise).rejects.toMatchObject({ code: 'qwen_tts_cancelled' });
  });
  it('times out after five minutes, terminates the child, and clears its temporary output', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const run = await running(); await vi.advanceTimersByTimeAsync(300000);
    await expect(run.promise).rejects.toMatchObject({ code: 'qwen_tts_timeout' }); expect(run.child.kill).toHaveBeenCalledOnce(); expect(await readdir(options.workPath)).toEqual([]);
  });
  it.each(['empty', 'wrong-header', 'truncated-data', 'wrong-rate', 'stereo', 'oversized'] as const)('rejects invalid output: %s', async kind => {
    const run = await running(); let audio: Buffer<ArrayBufferLike> = wave();
    if (kind === 'empty') audio = Buffer.alloc(0); if (kind === 'wrong-header') audio.write('FAKE', 0); if (kind === 'truncated-data') audio = audio.subarray(0, 46);
    if (kind === 'wrong-rate') audio.writeUInt32LE(22050, 24); if (kind === 'stereo') audio.writeUInt16LE(2, 22);
    if (kind === 'oversized') vi.mocked(stat).mockResolvedValue({ size: 9 * 1024 * 1024 } as Awaited<ReturnType<typeof stat>>);
    await run.child.complete(audio); await expect(run.promise).rejects.toMatchObject({ code: 'qwen_tts_failed' }); expect(await readdir(options.workPath)).toEqual([]);
  });
  it('validates WAV container sizes and mono 24 kHz PCM16 rather than accepting a RIFF prefix', () => {
    expect(validateQwenWave(wave())).toBe(true);
    for (const offset of [4, 16, 20, 22, 24, 28, 32, 34, 40]) { const audio = wave(); audio[offset] ^= 1; expect(validateQwenWave(audio)).toBe(false); }
    expect(validateQwenWave(Buffer.concat([wave(), Buffer.from([1])]))).toBe(false);
  });
});


describe('bounded Qwen CPU thread options', () => {
  it.each([2, 4] as const)('uses %s threads only within its own child environment', async threads => {
    const run = await running(provider({ threads }));
    expect(spawnMock.mock.calls[0][2].env).toMatchObject({ GGML_BACKEND: 'CPU', PDF_AI_TTS_THREADS: String(threads) });
    await run.child.complete(); await expect(run.promise).resolves.toMatchObject({ audio: wave() });
  });
  it('rejects unsupported counts before starting a process', () => {
    for (const threads of [0, 1, 3, 8, NaN]) expect(() => provider({ threads: threads as 2 })).toThrow('线程数');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});


describe('explicit Qwen GPU selection (mock process, no GPU inference)',()=>{
 it('requires the separate CUDA runtime instead of silently using the CPU binary',async()=>{
  const value=provider({device:'cuda'});expect(value.ready()).toBe(false);
  await expect(value.speak('你好',1,new AbortController().signal)).rejects.toMatchObject({code:'qwen_tts_missing'});expect(spawnMock).not.toHaveBeenCalled();
 });
 it('selects CUDA0 only within its own child environment and preserves the existing WAV path',async()=>{
  for(const name of ['qwen-tts.exe','cublas64_12.dll','cublasLt64_12.dll','manifest.json'])resources.set(join(options.runtimePath,'bin-cuda',name),100);
  vi.stubEnv('CUDA_PATH','do-not-inherit-cuda');vi.stubEnv('PATH','do-not-inherit-path');vi.stubEnv('OPENAI_API_KEY','private-fake-value');
  const run=await running(provider({device:'cuda'}));const [exe,,settings]=spawnMock.mock.calls[0];
  expect(exe).toBe(join(options.runtimePath,'bin-cuda','qwen-tts.exe'));expect(settings.cwd).toBe(join(options.runtimePath,'bin-cuda'));
  expect(settings.env.GGML_BACKEND).toBe('CUDA0');expect(JSON.stringify(settings.env)).not.toMatch(/do-not-inherit|private-fake-value/);
  await run.child.complete();expect((await run.promise).audio).toEqual(wave());
 });
 it('rejects unsupported devices without spawning',()=>{
  expect(()=>provider({device:'automatic' as 'cpu'})).toThrow('GPU');expect(spawnMock).not.toHaveBeenCalled();
 });
});

describe('complete CUDA runtime resources',()=>{
 it.each(['cublas64_12.dll','cublasLt64_12.dll'])('reports missing GPU resources when %s is absent',async missing=>{
  for(const name of ['qwen-tts.exe','cublas64_12.dll','cublasLt64_12.dll','manifest.json'])resources.set(join(options.runtimePath,'bin-cuda',name),100);
  resources.delete(join(options.runtimePath,'bin-cuda',missing));
  const value=provider({device:'cuda'});expect(value.ready()).toBe(false);
  await expect(value.speak('你好',1,new AbortController().signal)).rejects.toMatchObject({code:'qwen_tts_missing'});expect(spawnMock).not.toHaveBeenCalled();
 });
});

describe('GPU execution failure',()=>{
 it('returns an explicit failure without spawning a CPU retry',async()=>{
  for(const name of ['qwen-tts.exe','cublas64_12.dll','cublasLt64_12.dll','manifest.json'])resources.set(join(options.runtimePath,'bin-cuda',name),100);
  const run=await running(provider({device:'cuda'}));await run.child.complete(wave(),1);
  await expect(run.promise).rejects.toMatchObject({code:'qwen_tts_failed',message:expect.stringContaining('GPU')});expect(spawnMock).toHaveBeenCalledOnce();
 });
});
