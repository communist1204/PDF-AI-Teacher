/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node worker. */
/* global require */
const { join, isAbsolute } = require('node:path');
const { existsSync } = require('node:fs');
const voices = Object.freeze({ zf_001: 3, zf_002: 4, zf_003: 5, zm_010: 59, zm_011: 60, zm_012: 61 });
const [runtimePath, modelDir, voice, threadCount] = process.argv.slice(2);
const threads = Number(threadCount);
let tts;
let sherpa;

function send(value) {
  if (!process.connected || !process.send) return;
  process.send(value, error => { if (error) process.exit(1); });
}
function wave(samples, sampleRate) {
  if (!(samples instanceof Float32Array) || !samples.length || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || samples.length * 2 + 44 > 8 * 1024 * 1024) throw Error('Invalid audio');
  const bytes = samples.length * 2;
  const result = Buffer.alloc(44 + bytes);
  result.write('RIFF', 0); result.writeUInt32LE(36 + bytes, 4); result.write('WAVE', 8);
  result.write('fmt ', 12); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24); result.writeUInt32LE(sampleRate * 2, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(bytes, 40);
  for (let index = 0; index < samples.length; index++) {
    if (!Number.isFinite(samples[index])) throw Error('Invalid audio');
    const sample = Math.max(-1, Math.min(1, samples[index]));
    result.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + index * 2);
  }
  return result;
}

try {
  if (!runtimePath || !modelDir || !isAbsolute(runtimePath) || !isAbsolute(modelDir) || !Object.hasOwn(voices, voice) || !Number.isInteger(threads) || threads < 1 || threads > 8) throw Error('Invalid configuration');
  sherpa = require(join(runtimePath, 'node_modules', 'sherpa-onnx-node'));
  const rules = ['date-zh.fst', 'number-zh.fst', 'phone-zh.fst'].map(file => join(modelDir, file)).filter(file => existsSync(file));
  // Official Kokoro v1.1 Node API; dictDir is unused by this model.
  tts = new sherpa.OfflineTts({
    model: {
      kokoro: { model: join(modelDir, 'model.onnx'), voices: join(modelDir, 'voices.bin'), tokens: join(modelDir, 'tokens.txt'), dataDir: join(modelDir, 'espeak-ng-data'), lexicon: [join(modelDir, 'lexicon-us-en.txt'), join(modelDir, 'lexicon-zh.txt')].join(',') },
      numThreads: threads, provider: 'cpu', debug: false,
    },
    maxNumSentences: 1,
    ...(rules.length ? { ruleFsts: rules.join(',') } : {}),
  });
  send({ type: 'ready' });
} catch { send({ type: 'error' }); process.exitCode = 1; }

process.on('disconnect', () => process.exit(0));
process.on('message', message => {
  if (!tts || !message || message.type !== 'speak' || typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(message.id)) return;
  if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 6000) { send({ type: 'error', id: message.id }); return; }
  try {
    const audio = tts.generate({ text: message.text, generationConfig: new sherpa.GenerationConfig({ sid: voices[voice], speed: 1, silenceScale: 1 }) });
    send({ type: 'audio', id: message.id, audio: wave(audio.samples, audio.sampleRate) });
  } catch { send({ type: 'error', id: message.id }); }
});
