import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { LocalTtsProvider, LOCAL_TTS_VOICES, type LocalTtsOptions } from '../../apps/server/src/localTts';

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), fork: forkMock }));

class FakeWorker extends EventEmitter {
  sent: Array<{ type: string; id: string; text: string }> = [];
  kill = vi.fn(() => true);
  send = vi.fn((message: { type: string; id: string; text: string }, callback?: (error: Error | null) => void) => {
    this.sent.push(message); callback?.(null); return true;
  });
}
const owned: LocalTtsProvider[] = [];
let children: FakeWorker[] = [];
let directory = '';
let options: LocalTtsOptions;
const testRoot = resolve('test-results');
function provider(patch: Partial<LocalTtsOptions> = {}) { const value = new LocalTtsProvider({ ...options, ...patch }); owned.push(value); return value; }
function wav() {
  const value = Buffer.alloc(48);
  value.write('RIFF', 0); value.writeUInt32LE(40, 4); value.write('WAVEfmt ', 8); value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22); value.writeUInt32LE(24000, 24); value.writeUInt32LE(48000, 28);
  value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34); value.write('data', 36); value.writeUInt32LE(4, 40);
  return value;
}
beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
  directory = await mkdtemp(join(testRoot, 'local-tts-'));
  options = { workerPath: join(directory, 'worker.cjs'), runtimePath: directory, modelDir: join(directory, 'model'), voice: 'zf_001' };
  const files = [options.workerPath, ...['package.json', 'sherpa-onnx.js', 'addon.js'].map(file => join(directory, 'node_modules', 'sherpa-onnx-node', file)), ...['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'onnxruntime.dll'].map(file => join(directory, 'node_modules', 'sherpa-onnx-win-x64', file)), ...['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'number-zh.fst'].map(file => join(options.modelDir, file))];
  for (const file of files) { await mkdir(resolve(file, '..'), { recursive: true }); await writeFile(file, 'fixture'); }
  await mkdir(join(options.modelDir, 'espeak-ng-data'), { recursive: true });
});
beforeEach(() => {
  children = [];
  forkMock.mockReset().mockImplementation(() => { const child = new FakeWorker(); children.push(child); return child as unknown as ChildProcess; });
});
afterEach(() => { for (const value of owned.splice(0)) value.dispose(); vi.useRealTimers(); });
afterAll(async () => {
  if (!directory.startsWith(testRoot + sep)) throw Error('Unsafe fixture directory');
  await rm(directory, { recursive: true, force: true });
});

describe('isolated local TTS provider', () => {
  it('checks model/runtime files before claiming resources are ready', () => {
    expect(provider().ready()).toBe(true);
    expect(provider({ modelDir: join(directory, 'missing') }).ready()).toBe(false);
    expect(provider({ runtimePath: join(directory, 'missing') }).ready()).toBe(false);
    expect(provider({ workerPath: join(directory, 'missing.cjs') }).ready()).toBe(false);
    expect(forkMock).not.toHaveBeenCalled();
  });
  it('rejects missing resources with a local message and no process', async () => {
    await expect(provider({ modelDir: join(directory, 'missing') }).speak('你好', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'local_tts_missing' });
    expect(forkMock).not.toHaveBeenCalled();
  });
  it('accepts only the six verified speaker IDs and bounded CPU threads', () => {
    expect(LOCAL_TTS_VOICES).toEqual({ zf_001: 3, zf_002: 4, zf_003: 5, zm_010: 59, zm_011: 60, zm_012: 61 });
    for (const voice of Object.keys(LOCAL_TTS_VOICES)) expect(provider({ voice }).ready()).toBe(true);
    expect(() => provider({ voice: '__proto__' })).toThrow('音色');
    expect(() => provider({ voice: 'arbitrary-path-secret' })).toThrow('音色');
    expect(() => provider({ threads: 0 })).toThrow('线程');
    expect(() => provider({ threads: 9 })).toThrow('线程');
  });
  it('rejects empty/oversized text, invalid speeds and pre-aborted requests', async () => {
    const value = provider(); const signal = new AbortController().signal;
    for (const text of ['', ' \n ', 'a'.repeat(6001)]) await expect(value.speak(text, 1, signal)).rejects.toMatchObject({ code: 'local_tts_text' });
    for (const speed of [NaN, Infinity, 0.24, 3.01]) await expect(value.speak('你好', speed, signal)).rejects.toMatchObject({ code: 'local_tts_speed' });
    await expect(value.speak('你好', 1, AbortSignal.abort('private cancellation reason'))).rejects.toMatchObject({ code: 'local_tts_cancelled' });
    expect(forkMock).not.toHaveBeenCalled();
  });
  it('keeps one worker for consecutive sentences and leaves playback speed to the player', async () => {
    const value = provider(); const signal = new AbortController().signal;
    const first = value.speak(' 第一段原文。 ', 0.25, signal); const child = children[0];
    expect(child.sent).toEqual([]); child.emit('message', { type: 'ready' });
    expect(child.sent[0]).toEqual({ type: 'speak', id: expect.any(String), text: ' 第一段原文。 ' });
    child.emit('message', { type: 'audio', id: child.sent[0].id, audioBase64: wav().toString('base64') });
    expect((await first).audio).toEqual(wav());
    const second = value.speak('第二段。', 2, signal);
    child.emit('message', { type: 'audio', id: child.sent[0].id, audioBase64: wav().toString('base64') });
    child.emit('message', { type: 'audio', id: child.sent[1].id, audioBase64: wav().toString('base64') });
    await expect(second).resolves.toMatchObject({ audio: wav() });
    expect(forkMock).toHaveBeenCalledTimes(1); expect(child.kill).not.toHaveBeenCalled();
    const args = forkMock.mock.calls[0];
    expect(args[0]).toBe(options.workerPath); expect(args[1]).toEqual([directory, options.modelDir, 'zf_001', '2']);
    expect(args[2]).toMatchObject({ execPath: process.execPath, execArgv: [], windowsHide: true, serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    expect(args[2].env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(Object.keys(args[2].env).every(key => ['systemroot', 'windir', 'temp', 'tmp', 'pathext', 'lang', 'lc_all', 'path', 'electron_run_as_node'].includes(key.toLowerCase()))).toBe(true);
  });
  it('refuses overlap without replacing the first pending sentence', async () => {
    const value = provider(); const first = value.speak('第一句', 1, new AbortController().signal);
    await expect(value.speak('第二句', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'local_tts_busy' });
    const child = children[0]; child.emit('message', { type: 'ready' }); child.emit('message', { type: 'audio', id: child.sent[0].id, audioBase64: wav().toString('base64') });
    await expect(first).resolves.toBeDefined(); expect(forkMock).toHaveBeenCalledTimes(1);
  });
  it('cancels its own child and ignores late messages/exit from the old process', async () => {
    const value = provider(); const controller = new AbortController();
    const first = value.speak('第一句', 1, controller.signal); const rejection = expect(first).rejects.toMatchObject({ code: 'local_tts_cancelled' });
    const old = children[0]; old.emit('message', { type: 'ready' }); controller.abort('private reason'); await rejection; expect(old.kill).toHaveBeenCalledOnce();
    const second = value.speak('第二句', 1, new AbortController().signal); const next = children[1]; next.emit('message', { type: 'ready' });
    old.emit('message', { type: 'audio', id: next.sent[0].id, audioBase64: wav().toString('base64') }); old.emit('exit', 1); old.emit('error', Error('sensitive native path'));
    expect(next.kill).not.toHaveBeenCalled(); next.emit('message', { type: 'audio', id: next.sent[0].id, audioBase64: wav().toString('base64') });
    await expect(second).resolves.toMatchObject({ audio: wav() });
  });
  it.each(['exit', 'error', 'worker-error', 'bad-audio'])('sanitizes %s and permits a fresh worker on retry', async event => {
    const value = provider(); const first = value.speak('原文不得进入错误', 1, new AbortController().signal);
    const rejection = expect(first).rejects.toMatchObject({ code: 'local_tts_failed', message: expect.not.stringContaining('sk-native-secret') });
    const child = children[0]; child.emit('message', { type: 'ready' });
    if (event === 'exit') child.emit('exit', 123);
    else if (event === 'error') child.emit('error', Error('sk-native-secret'));
    else child.emit('message', { type: event === 'worker-error' ? 'error' : 'audio', id: child.sent[0].id, message: 'sk-native-secret', audioBase64: 'sk-native-secret' });
    await rejection;
    const second = value.speak('重试', 1, new AbortController().signal); const next = children[1]; next.emit('message', { type: 'ready' }); next.emit('message', { type: 'audio', id: next.sent[0].id, audioBase64: wav().toString('base64') });
    await expect(second).resolves.toBeDefined();
  });
  it('rejects malformed, noncanonical, oversized base64 and inconsistent WAV headers', async () => {
    const invalidWave = wav(); invalidWave.writeUInt32LE(1, 28);
    const malformed: unknown[] = ['', '!!!!', wav().toString('base64') + '\n', wav().toString('base64') + '=', { type: 'Buffer', data: [1, 2] }, 'A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4 + 4), invalidWave.toString('base64')];
    for (const audioBase64 of malformed) {
      const value = provider(); const result = value.speak('fixture', 1, new AbortController().signal);
      const rejection = expect(result).rejects.toMatchObject({ code: 'local_tts_failed' });
      const child = children.at(-1)!; child.emit('message', { type: 'ready' });
      child.emit('message', { type: 'audio', id: child.sent[0].id, audioBase64 }); await rejection;
    }
  });
  it('settles initialization failure, timeout, spawn failure and disposal without retaining jobs', async () => {
    const initializing = provider(); const initial = initializing.speak('你好', 1, new AbortController().signal);
    const initFailure = expect(initial).rejects.toMatchObject({ code: 'local_tts_failed' }); children[0].emit('message', { type: 'error', message: 'native-secret' }); await initFailure;
    vi.useFakeTimers();
    const timeout = provider(); const timed = timeout.speak('你好', 1, new AbortController().signal); const timedFailure = expect(timed).rejects.toMatchObject({ code: 'local_tts_timeout' });
    await vi.advanceTimersByTimeAsync(120000); await timedFailure; vi.useRealTimers();
    forkMock.mockImplementationOnce(() => { throw Error('private path'); });
    await expect(provider().speak('你好', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'local_tts_failed' });
    const closing = provider(); const pending = closing.speak('你好', 1, new AbortController().signal); const closedFailure = expect(pending).rejects.toMatchObject({ code: 'local_tts_closed' }); closing.dispose(); await closedFailure;
    expect(closing.ready()).toBe(false); await expect(closing.speak('你好', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'local_tts_closed' });
  });
  it('runs the actual worker protocol with a fake native engine and produces bounded PCM16 WAV', async () => {
    const runtime = join(directory, 'node_modules', 'sherpa-onnx-node');
    await writeFile(join(runtime, 'package.json'), JSON.stringify({ main: 'sherpa-onnx.js' }));
    await writeFile(join(runtime, 'sherpa-onnx.js'), `let calls=0; module.exports={GenerationConfig:class {constructor(value){Object.assign(this,value);}},OfflineTts:class {
      constructor(config){if(config.model.provider!=='cpu'||config.model.numThreads!==2||config.model.debug!==false||!config.ruleFsts.endsWith('number-zh.fst'))throw Error('private-config');}
      generate({text,generationConfig,enableExternalBuffer}){if(enableExternalBuffer!==false||generationConfig.sid!==3||generationConfig.speed!==1||generationConfig.silenceScale!==1)throw Error('private-speed');if(text==='error')throw Error('source-text-secret');return {samples:new Float32Array([-1,0,.5,1,++calls/10]),sampleRate:24000};}
    }};`);
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    forkMock.mockImplementationOnce(actual.fork);
    const value = provider({ workerPath: resolve('scripts/local-tts-worker.cjs') });
    const first = (await value.speak('测试原文', 0.25, new AbortController().signal)).audio;
    expect(first.toString('ascii', 0, 4)).toBe('RIFF'); expect(first.readUInt32LE(24)).toBe(24000); expect(first.readUInt16LE(34)).toBe(16);
    expect([0, 1, 2, 3, 4].map(index => first.readInt16LE(44 + index * 2))).toEqual([-32768, 0, 16384, 32767, 3277]);
    const second = (await value.speak('下一句', 3, new AbortController().signal)).audio; expect(second.readInt16LE(52)).toBe(6553); expect(forkMock).toHaveBeenCalledTimes(1);
    await expect(value.speak('error', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'local_tts_failed', message: expect.not.stringContaining('source-text-secret') });
    const worker = await readFile(resolve('scripts/local-tts-worker.cjs'), 'utf8'); expect(worker).not.toContain('console.'); expect(worker).not.toContain('writeFile');
  });
});
