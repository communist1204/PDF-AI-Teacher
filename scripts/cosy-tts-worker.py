"""Private stdio GPU worker. stdout contains only framed JSON, never source text."""
from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import json
import logging
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time

OUTPUT = sys.stdout
OUTPUT_LOCK = threading.Lock()
STOP = threading.Event()
JOBS: queue.Queue = queue.Queue(maxsize=4)
CANCEL: dict[str, threading.Event] = {}
CANCEL_LOCK = threading.Lock()
CURRENT = threading.Event()
DEFAULT_VOICE = 'local_longanyang'
VOICE_IDS = frozenset((DEFAULT_VOICE, 'local_longanhuan_v3', 'local_longfei_v3',
                       'local_longxiaochun_v3', 'local_longxiaoxia_v3', 'local_longanyun_v3'))


class VoiceReferenceError(Exception):
    """An optional reference is missing or invalid; the GPU model remains usable."""


def load_voice_reference(runtime: Path, voice: str) -> Path:
    if voice not in VOICE_IDS:
        raise VoiceReferenceError('Unknown local reference voice')
    try:
        folder = runtime / 'voices'
        manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
        matching = [item for item in manifest['voices'] if item['id'] == voice]
        if len(matching) != 1:
            raise ValueError('Voice missing or duplicate')
        item = matching[0]
        path = (folder / item['file']).resolve()
        path.relative_to(folder.resolve())
        if path.name != voice + '.wav' or path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('Invalid reference file')
        if hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Invalid reference checksum')
        if item.get('mode') != 'cross_lingual':
            raise ValueError('Unsupported reference mode')
        return path
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise VoiceReferenceError('Reference unavailable') from exc


def emit(event: dict) -> None:
    with OUTPUT_LOCK:
        OUTPUT.write(json.dumps(event, ensure_ascii=True) + '\n')
        OUTPUT.flush()


def error(job_id: str | None, code: str, message: str) -> None:
    emit({'type': 'error', 'id': job_id, 'code': code, 'message': message})


def receive() -> None:
    for line in sys.stdin:
        try:
            if len(line) > 20000:
                raise ValueError('frame too large')
            msg = json.loads(line)
            job_id = msg.get('id')
            if not isinstance(job_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', job_id):
                raise ValueError('invalid id')
            if msg.get('type') == 'cancel':
                with CANCEL_LOCK:
                    event = CANCEL.get(job_id)
                    if event is not None:
                        event.set()
            elif msg.get('type') == 'speak':
                text = msg.get('text')
                voice = msg.get('voice', DEFAULT_VOICE)
                if not isinstance(text, str) or not text.strip() or len(text) > 4000 or not isinstance(voice, str) or voice not in VOICE_IDS:
                    error(job_id, 'invalid_request', '朗读参数无效。')
                    continue
                with CANCEL_LOCK:
                    if job_id in CANCEL:
                        raise ValueError('duplicate id')
                    event = threading.Event()
                    CANCEL[job_id] = event
                try:
                    JOBS.put_nowait((job_id, text, voice, event))
                except queue.Full:
                    with CANCEL_LOCK:
                        CANCEL.pop(job_id, None)
                    error(job_id, 'busy', '本地朗读队列已满，请稍后重试。')
            else:
                error(job_id, 'invalid_request', '不支持的朗读操作。')
        except (ValueError, TypeError, AttributeError):
            error(None, 'invalid_request', '本地朗读请求格式无效。')
    STOP.set()
    with CANCEL_LOCK:
        for event in CANCEL.values():
            event.set()


def main() -> None:
    global CURRENT
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime-dir', required=True)
    args = parser.parse_args()
    runtime = Path(args.runtime_dir).resolve()
    repo = runtime / 'repo'
    model_path = runtime / 'models' / 'Fun-CosyVoice3-0.5B-2512'
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['HF_HOME'] = str(runtime / 'cache' / 'huggingface')
    os.environ['MODELSCOPE_CACHE'] = str(runtime / 'cache' / 'modelscope')
    os.environ['MPLCONFIGDIR'] = str(runtime / 'cache' / 'matplotlib')
    os.environ['NUMBA_CACHE_DIR'] = str(runtime / 'cache' / 'numba')
    os.environ['TQDM_DISABLE'] = '1'
    sys.path[:0] = [str(repo), str(repo / 'third_party' / 'Matcha-TTS')]
    # Upstream logs include the synthesis text at INFO; disable before imports.
    logging.disable(logging.CRITICAL)
    loaded_at = time.perf_counter()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import torch
            import imageio_ffmpeg
            if not torch.cuda.is_available():
                raise RuntimeError('CUDA unavailable')
            torch.set_num_threads(4)
            torch.set_num_interop_threads(1)
            # An actual device operation rejects an unsupported wheel/architecture early.
            torch.ones(1, device='cuda').add_(1)
            torch.cuda.synchronize()
            from cosyvoice.cli.cosyvoice import AutoModel
            cosy = AutoModel(model_dir=str(model_path), load_trt=False, load_vllm=False, fp16=True)
            if str(cosy.model.device) != 'cuda':
                raise RuntimeError('GPU required')
            # Each selected reference is encoded lazily. No legacy demonstration
            # voice is loaded or used as a fallback.
            loaded_voices = set()
            encoder = imageio_ffmpeg.get_ffmpeg_exe()
        # Wrap the token iterator only to honor cancellation; full upstream cleanup still runs.
        original_inference = cosy.model.llm.inference
        def cancellable_inference(*positional, **keywords):
            generator = original_inference(*positional, **keywords)
            try:
                for token in generator:
                    if CURRENT.is_set() or STOP.is_set():
                        break
                    yield token
            finally:
                generator.close()
        cosy.model.llm.inference = cancellable_inference
        llm_errors = []
        original_llm_job = cosy.model.llm_job
        def safe_llm_job(*positional, **keywords):
            job_uuid = keywords.get('uuid', positional[-1] if positional else None)
            try:
                original_llm_job(*positional, **keywords)
            except Exception as exc:
                llm_errors.append(type(exc).__name__)
            finally:
                # Upstream's consumer otherwise waits forever on a failed LLM thread.
                with cosy.model.lock:
                    if job_uuid in cosy.model.llm_end_dict:
                        cosy.model.llm_end_dict[job_uuid] = True
        cosy.model.llm_job = safe_llm_job
        original_token2wav = cosy.model.token2wav
        def cancellable_token2wav(*positional, **keywords):
            if CURRENT.is_set() or STOP.is_set() or llm_errors:
                # Drain upstream normally so its per-request dictionaries are removed,
                # including cancellation before the first token (empty-token input).
                # The high-level wrapper divides by output duration even with logs
                # disabled. One discarded sample lets it finish its cleanup safely.
                return torch.zeros((1, 1))
            return original_token2wav(*positional, **keywords)
        cosy.model.token2wav = cancellable_token2wav
        initial_hop = cosy.model.token_hop_len
        emit({'type': 'ready', 'sampleRate': cosy.sample_rate, 'device': 'cuda',
              'deviceName': torch.cuda.get_device_name(), 'referenceEncoderDevice': 'cpu',
              'model': 'Fun-CosyVoice3-0.5B-2512', 'loadMs': round((time.perf_counter()-loaded_at)*1000)})
    except Exception as exc:
        sys.stderr.write('CosyVoice initialization failed: ' + type(exc).__name__ + '\n')
        error(None, 'initialization_failed', 'CosyVoice 3 初始化失败，请检查本机模型和 GPU 运行环境。')
        return

    threading.Thread(target=receive, daemon=True).start()
    while not STOP.is_set():
        try:
            job_id, text, voice, cancelled = JOBS.get(timeout=0.2)
        except queue.Empty:
            continue
        CURRENT = cancelled
        process = None
        reader = None
        total_samples = 0
        first_pcm_ms = None
        first_mp3_ms = None
        reference_load_ms = 0
        started = time.perf_counter()
        encoder_failed = threading.Event()
        fatal = False
        llm_errors.clear()
        try:
            if cancelled.is_set():
                error(job_id, 'cancelled', '朗读已取消。')
                continue
            if voice not in loaded_voices:
                prompt_path = load_voice_reference(runtime, voice)
                reference_started = time.perf_counter()
                with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
                    # This cache contains acoustic features, not a guessed transcript.
                    cosy.add_zero_shot_spk('', str(prompt_path), voice)
                loaded_voices.add(voice)
                reference_load_ms = round((time.perf_counter() - reference_started) * 1000)
            if cancelled.is_set() or STOP.is_set():
                error(job_id, 'cancelled', '朗读已取消。')
                continue
            process = subprocess.Popen([
                encoder, '-hide_banner', '-loglevel', 'error', '-f', 'f32le',
                '-ar', str(cosy.sample_rate), '-ac', '1', '-probesize', '32', '-analyzeduration', '0', '-i', 'pipe:0',
                '-codec:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3',
                '-write_xing', '0', '-id3v2_version', '0', '-write_id3v1', '0',
                '-flush_packets', '1', 'pipe:1',
            ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
               bufsize=0, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            def send_audio() -> None:
                nonlocal first_mp3_ms
                try:
                    while block := os.read(process.stdout.fileno(), 4096):
                        if not cancelled.is_set() and not STOP.is_set():
                            if first_mp3_ms is None:
                                first_mp3_ms = round((time.perf_counter()-started)*1000)
                            emit({'type': 'audio', 'id': job_id, 'data': base64.b64encode(block).decode('ascii')})
                except (OSError, ValueError):
                    encoder_failed.set()
                    cancelled.set()
                    if process.poll() is None:
                        process.terminate()
            reader = threading.Thread(target=send_audio, daemon=True)
            reader.start()
            # Upstream grows this instance field during a stream; restore its original first-hop budget.
            cosy.model.token_hop_len = initial_hop
            with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
                for output in cosy.inference_cross_lingual('You are a helpful assistant.<|endofprompt|>' + text,
                                                           '', zero_shot_spk_id=voice,
                                                           stream=True, speed=1.0, text_frontend=False):
                    if cancelled.is_set() or STOP.is_set() or llm_errors:
                        continue
                    if encoder_failed.is_set():
                        raise RuntimeError('Audio encoder reader failed')
                    samples = output['tts_speech'].detach().float().cpu().contiguous().numpy().reshape(-1)
                    if first_pcm_ms is None:
                        first_pcm_ms = round((time.perf_counter()-started)*1000)
                    total_samples += samples.size
                    remaining = memoryview(samples.astype('<f4', copy=False).tobytes())
                    while remaining:
                        count = process.stdin.write(remaining)
                        if not count:
                            raise RuntimeError('Audio encoder pipe closed')
                        remaining = remaining[count:]
            if llm_errors or encoder_failed.is_set():
                raise RuntimeError('Local synthesis failed')
            process.stdin.close()
            if process.wait(timeout=15) != 0:
                raise RuntimeError('Audio encoding failed')
            reader.join(timeout=5)
            if reader.is_alive():
                raise RuntimeError('Audio output did not finish')
            if cancelled.is_set() or STOP.is_set():
                error(job_id, 'cancelled', '朗读已取消。')
            elif total_samples == 0:
                error(job_id, 'empty_audio', '本地模型没有生成可播放声音。')
            else:
                emit({'type': 'done', 'id': job_id, 'metrics': {
                    'voice': voice, 'referenceLoadMs': reference_load_ms,
                    'firstPcmMs': first_pcm_ms, 'firstMp3Ms': first_mp3_ms,
                    'totalMs': round((time.perf_counter()-started)*1000),
                    'audioSeconds': total_samples / cosy.sample_rate,
                    'gpuAllocatedMiB': round(torch.cuda.memory_allocated()/1024**2),
                }})
        except VoiceReferenceError:
            error(job_id, 'voice_unavailable', '所选音色参考文件缺失或损坏，请运行项目的 setup-cosy-voices.py 修复后重试。')
        except Exception as exc:
            fatal = True
            sys.stderr.write('CosyVoice synthesis failed: ' + type(exc).__name__ + '\n')
            error(job_id, 'cancelled' if cancelled.is_set() else 'synthesis_failed',
                  '朗读已取消。' if cancelled.is_set() else 'CosyVoice 3 本地合成失败，请重试短一些的文字。')
        finally:
            if process is not None:
                if process.stdin and not process.stdin.closed:
                    try:
                        process.stdin.close()
                    except OSError:
                        pass
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                if reader:
                    reader.join(timeout=2)
                if process.stdout:
                    process.stdout.close()
            with CANCEL_LOCK:
                CANCEL.pop(job_id, None)
            JOBS.task_done()
        if fatal:
            # A failed generator may retain a model thread/cache. Never reuse it;
            # the owning Node process can start a clean worker on the next request.
            os._exit(1)


if __name__ == '__main__':
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        STOP.set()
