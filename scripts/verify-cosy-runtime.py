"""Opt-in real local GPU benchmark; generated text is original, no cloud requests."""
from __future__ import annotations

import base64
import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / 'cosy-tts-runtime'
OUT = RUNTIME / 'verification'
CASES = [
    ('first', '我们先读一小段文字，看看声音能否自然地开始。遇到公式就先跳过，重点听清楚概念。'),
    ('warm', '二零二六年，我们重新整理这份学习笔记。注意力机制让每个位置参考其他位置的信息；权重越大，对当前输出的影响就越明显。'),
    ('long', '学习一个新概念时，不必一口气记住所有细节。先想清楚它要解决什么问题，再看每一步用了哪些已知信息。比如，注意力机制允许模型根据当前的问题，从不同位置选择有用的内容。这里的选择不是把其他内容完全删除，而是给它们分配不同的权重。权重大的部分影响更多，权重小的部分影响更少。接着，我们可以用一个简单的例子来检查自己的理解。当你在一段文字里看到代词时，通常会回头找它指的是谁；模型也需要利用上下文，建立位置之间的联系。这个类比有局限，但能帮助我们抓住直觉。阅读时可以适当停下来，问自己：输入是什么，输出是什么，中间发生了哪些变化？如果仍然不明白，就回到最短的一句话，重新梳理。现在继续往下读，保持同一个声音，观察段落之间有没有因为生成来不及而中断。'),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cancel-only', action='store_true')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    env = {key: value for key, value in os.environ.items()
           if key.lower() in ('path', 'systemroot', 'windir', 'temp', 'tmp', 'comspec', 'pathext', 'userprofile')}
    env.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    started = time.perf_counter()
    with (OUT / 'worker-stderr.log').open('w', encoding='utf-8') as diagnostic:
        child = subprocess.Popen([str(RUNTIME / 'venv/Scripts/python.exe'), '-u',
                                  str(ROOT / 'scripts/cosy-tts-worker.py'), '--runtime-dir', str(RUNTIME)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=diagnostic,
                                 text=True, encoding='utf-8', env=env,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        events = queue.Queue()
        def read():
            for line in child.stdout:
                try:
                    events.put((time.perf_counter(), json.loads(line)))
                except ValueError:
                    events.put((time.perf_counter(), {'type': 'invalid_frame'}))
            events.put((time.perf_counter(), {'type': 'exit'}))
        threading.Thread(target=read, daemon=True).start()
        def send(frame):
            child.stdin.write(json.dumps(frame, ensure_ascii=True) + '\n')
            child.stdin.flush()
        def next_event(timeout=180):
            when, event = events.get(timeout=timeout)
            if event['type'] in ('exit', 'invalid_frame'):
                raise RuntimeError(event['type'])
            return when, event
        results = {'cases': [], 'humanListening': 'not-tested'}
        try:
            when, ready = next_event()
            if ready['type'] != 'ready':
                print(json.dumps(ready), flush=True)
                raise RuntimeError('Model did not load; inspect local diagnostic')
            results['ready'] = ready
            results['coldReadyMs'] = round((when-started)*1000)
            print(json.dumps({'ready': ready, 'coldReadyMs': results['coldReadyMs']}), flush=True)
            for case_id, text in ([] if args.cancel_only else CASES):
                begin = time.perf_counter()
                send({'type': 'speak', 'id': case_id, 'text': text, 'voice': 'local_longanyang'})
                chunks, times = [], []
                while True:
                    when, event = next_event()
                    if event.get('id') != case_id:
                        raise RuntimeError('Unexpected response id')
                    if event['type'] == 'audio':
                        chunks.append(base64.b64decode(event['data'], validate=True))
                        times.append(round((when-begin)*1000))
                    elif event['type'] == 'done':
                        break
                    else:
                        print(json.dumps(event), flush=True)
                        raise RuntimeError('Synthesis failed')
                audio = b''.join(chunks)
                (OUT / (case_id + '.mp3')).write_bytes(audio)
                record = {'id': case_id, 'text': text, 'characters': len(text), 'bytes': len(audio),
                          'firstReceivedMs': times[0], 'lastReceivedMs': times[-1],
                          'receivedChunkTimesMs': times, **event['metrics']}
                record['realTimeFactor'] = round(record['totalMs']/1000/record['audioSeconds'], 3)
                results['cases'].append(record)
                print(json.dumps({key: value for key, value in record.items() if key not in ('text', 'receivedChunkTimesMs')}), flush=True)
            # Cancel before the first token, then prove the same warm process can read again.
            begin = time.perf_counter()
            send({'type': 'speak', 'id': 'cancel', 'text': CASES[-1][1]})
            send({'type': 'cancel', 'id': 'cancel'})
            while True:
                when, event = next_event(30)
                if event['type'] == 'error' and event.get('id') == 'cancel':
                    assert event['code'] == 'cancelled'
                    results['cancelBeforeFirstTokenMs'] = round((when-begin)*1000)
                    break
                assert event['type'] != 'audio', 'Late audio after immediate cancel'
            send({'type': 'speak', 'id': 'after-cancel', 'text': '取消以后，同一个模型仍然可以继续朗读。'})
            while True:
                _, event = next_event(60)
                assert event.get('id') == 'after-cancel'
                if event['type'] == 'done':
                    results['afterCancel'] = event['metrics']
                    break
                assert event['type'] == 'audio'
            send({'type': 'speak', 'id': 'mid-cancel', 'text': CASES[-1][1]})
            while True:
                _, event = next_event(60)
                assert event.get('id') == 'mid-cancel' and event['type'] == 'audio'
                begin = time.perf_counter()
                send({'type': 'cancel', 'id': 'mid-cancel'})
                break
            while True:
                when, event = next_event(30)
                assert event.get('id') == 'mid-cancel'
                if event['type'] == 'error':
                    assert event['code'] == 'cancelled'
                    results['cancelDuringGenerationMs'] = round((when-begin)*1000)
                    break
                # Audio already queued in the pipe may arrive; the Node owner rejects it.
                assert event['type'] == 'audio'
            send({'type': 'speak', 'id': 'after-mid-cancel', 'text': '中途停止以后，再读这句话，确认模型没有卡住。'})
            while True:
                _, event = next_event(60)
                assert event.get('id') == 'after-mid-cancel'
                if event['type'] == 'done':
                    results['afterMidCancel'] = event['metrics']
                    break
                assert event['type'] == 'audio'
            (OUT / ('cancellation.json' if args.cancel_only else 'results.json')).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
            print('Real local GPU synthesis and immediate cancellation completed.', flush=True)
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.terminate()
                child.wait(timeout=10)


if __name__ == '__main__':
    main()
