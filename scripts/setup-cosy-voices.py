"""Prepare the user's six public sample references for local, approximate TTS."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request
import wave

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / 'cosy-tts-runtime' / 'voices'


def safe_destination(path: Path) -> Path:
    if path.is_symlink():
        raise ValueError('Reference installer does not overwrite or remove symbolic links')
    resolved = path.resolve()
    resolved.relative_to(ROOT.resolve())
    resolved.relative_to(DEST.resolve())
    return resolved


def publish(path: Path, data: bytes) -> None:
    target = safe_destination(path)
    part = safe_destination(path.with_name(path.name + '.part'))
    part.write_bytes(data)
    part.replace(target)


def main() -> None:
    manifest_path = ROOT / 'assets' / 'cosy-voices.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    DEST.resolve().relative_to(ROOT.resolve())
    DEST.mkdir(parents=True, exist_ok=True)
    binary_dir = ROOT / 'cosy-tts-runtime' / 'venv' / 'Lib' / 'site-packages' / 'imageio_ffmpeg' / 'binaries'
    encoders = list(binary_dir.glob('ffmpeg-*.exe'))
    if len(encoders) != 1:
        raise RuntimeError('Install the project CosyVoice runtime before preparing reference voices.')
    source_dir = safe_destination(DEST / 'source-mp3')
    source_dir.mkdir(exist_ok=True)
    for voice in manifest['voices']:
        target = safe_destination(DEST / voice['file'])
        data = target.read_bytes() if target.exists() else b''
        if hashlib.sha256(data).hexdigest() != voice['sha256']:
            raw = safe_destination(source_dir / (voice['id'] + '.mp3'))
            original = raw.read_bytes() if raw.exists() else b''
            if hashlib.sha256(original).hexdigest() != voice['sourceSha256']:
                url = voice['url']
                if not url.startswith('https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/'):
                    raise ValueError('Unexpected official sample host')
                request = urllib.request.Request(url, headers={'User-Agent': 'PDF-AI-Teacher-Reference-Setup'})
                with urllib.request.urlopen(request, timeout=60) as response:
                    original = response.read(8 * 1024 * 1024)
                if len(original) != voice['sourceBytes'] or hashlib.sha256(original).hexdigest() != voice['sourceSha256']:
                    raise ValueError('Public source checksum mismatch: ' + voice['id'])
                publish(raw, original)
            converted = safe_destination(target.with_name(target.name + '.conversion.wav'))
            try:
                subprocess.run([str(encoders[0]), '-v', 'error', '-y', '-i', str(raw), '-map_metadata', '-1',
                                '-fflags', '+bitexact', '-flags:a', '+bitexact', '-ac', '1', '-ar', '24000',
                                '-c:a', 'pcm_s16le', '-f', 'wav', str(converted)], check=True,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                data = converted.read_bytes()
                if len(data) != voice['bytes'] or hashlib.sha256(data).hexdigest() != voice['sha256']:
                    raise ValueError('Decoded reference checksum mismatch: ' + voice['id'])
                publish(target, data)
            finally:
                if converted.exists():
                    converted.unlink()
        with wave.open(str(target), 'rb') as recording:
            duration = recording.getnframes() / recording.getframerate()
            if recording.getnchannels() != 1 or not 2 <= duration <= 30 or recording.getframerate() < 16000:
                raise ValueError('Unsupported reference recording: ' + voice['id'])
        print(f"Verified {voice['id']}: {duration:.2f}s", flush=True)
    # Publish the manifest only after every recording passes validation.
    publish(DEST / 'NOTICE.txt', (ROOT / 'assets' / 'COSY-REFERENCE-NOTICE.txt').read_bytes())
    publish(DEST / 'manifest.json', manifest_path.read_bytes())
    # User requested replacing the old voice choices. Remove only known files
    # created by our previous installer, after the replacement is valid.
    for name in ['cosy_female_1.wav','cosy_female_2.wav','cosy_male_1.wav','cosy_male_2.wav','cosy_male_3.wav']:
        old = safe_destination(DEST / name)
        if old.exists():
            old.unlink()
    old_license = safe_destination(DEST / 'LICENSE.txt')
    if old_license.exists() and old_license.read_bytes() == (ROOT / 'assets' / 'APACHE-2.0.txt').read_bytes():
        old_license.unlink()
    print('Six approximate local reference voices verified; no cloud synthesis was called.', flush=True)


if __name__ == '__main__':
    main()
