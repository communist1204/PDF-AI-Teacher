"""Real local GPU, six voices, same original paragraph; no cloud or listening claims."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / 'cosy-tts-runtime'
OUT = RUNTIME / 'verification' / 'local-references'
TEXT = ('学习一个新概念时，不必一口气记住所有细节。先想清楚它要解决什么问题，再看每一步用了哪些已知信息。'
        '比如，注意力机制允许模型根据当前的问题，从不同位置选择有用的内容。这里的选择不是把其他内容完全删除，'
        '而是给它们分配不同的权重。权重大的部分影响更多，权重小的部分影响更少。现在继续往下读，保持同一个声音，'
        '观察段落之间有没有因为生成来不及而中断。')


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / 'assets' / 'cosy-voices.json').read_text(encoding='utf-8'))
    voices = [item['id'] for item in manifest['voices']]
    env = {key: value for key, value in os.environ.items()
           if key.lower() in ('path', 'systemroot', 'windir', 'temp', 'tmp', 'comspec', 'pathext', 'userprofile')}
    env.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    started = time.perf_counter()
    result = {'kind': 'real-local-GPU-six-user-selected-acoustic-references', 'date': time.strftime('%Y-%m-%d'),
              'text': TEXT, 'characters': len(TEXT), 'cases': [], 'cloudRequests': False,
              'humanListening': 'Not tested; files are available for user audition.'}
    with (OUT / 'worker-stderr.log').open('w', encoding='utf-8') as diagnostic:
        child = subprocess.Popen([str(RUNTIME / 'venv/Scripts/python.exe'), '-u',
                                  str(ROOT / 'scripts/cosy-tts-worker.py'), '--runtime-dir', str(RUNTIME)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=diagnostic,
                                 text=True, encoding='utf-8', env=env,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        events = queue.Queue()
        def receive():
            for line in child.stdout:
                events.put((time.perf_counter(), json.loads(line)))
            events.put((time.perf_counter(), {'type': 'exit'}))
        threading.Thread(target=receive, daemon=True).start()
        def send(frame):
            child.stdin.write(json.dumps(frame) + '\n')
            child.stdin.flush()
        def next_event():
            when, event = events.get(timeout=180)
            if event['type'] == 'exit':
                raise RuntimeError('Worker exited')
            return when, event
        try:
            when, ready = next_event()
            assert ready['type'] == 'ready', ready
            result['ready'] = ready
            result['coldReadyMs'] = round((when-started)*1000)
            print(json.dumps(ready), flush=True)
            send({'type': 'speak', 'id': 'bad-voice', 'text': '这段不能被播放。', 'voice': '../outside'})
            _, rejection = next_event()
            assert rejection.get('code') == 'invalid_request'
            result['invalidVoiceRejected'] = True
            for voice in voices:
                begin = time.perf_counter()
                send({'type': 'speak', 'id': voice, 'voice': voice, 'text': TEXT})
                chunks, arrival = [], []
                while True:
                    when, event = next_event()
                    assert event.get('id') == voice, event
                    if event['type'] == 'done':
                        break
                    assert event['type'] == 'audio', event
                    chunks.append(base64.b64decode(event['data'], validate=True))
                    arrival.append(round((when-begin)*1000))
                audio = b''.join(chunks)
                assert len(audio) > 24000 and event['metrics']['audioSeconds'] > 10
                assert event['metrics']['voice'] == voice
                (OUT / (voice + '.mp3')).write_bytes(audio)
                record = {'id': voice, 'bytes': len(audio), 'sha256': hashlib.sha256(audio).hexdigest(),
                          'firstReceivedMs': arrival[0], 'chunkTimesMs': arrival, **event['metrics']}
                record['realTimeFactor'] = round(record['totalMs']/1000/record['audioSeconds'], 3)
                result['cases'].append(record)
                print(json.dumps({k: v for k, v in record.items() if k != 'chunkTimesMs'}), flush=True)
            # Re-select an already encoded voice without reloading the model or reference.
            send({'type': 'speak', 'id': 'warm-switch-back', 'voice': voices[0],
                  'text': '切换回刚才的音色，继续朗读下一段内容。'})
            while True:
                _, event = next_event()
                assert event.get('id') == 'warm-switch-back'
                if event['type'] == 'done':
                    assert event['metrics']['referenceLoadMs'] == 0
                    result['warmSwitchBack'] = event['metrics']
                    break
                assert event['type'] == 'audio', event
            assert len({case['sha256'] for case in result['cases']}) == len(voices)
            # Distinct hashes alone are not a perceptual speaker-distinctness test.
            (ROOT / 'docs' / 'cosy-local-references-verification.json').write_text(
                json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print('All six voices synthesized; warm reference reuse verified.', flush=True)
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.terminate()
                child.wait(timeout=10)


if __name__ == '__main__':
    main()
