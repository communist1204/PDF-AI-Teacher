"""Install five small, pinned public TTS reference recordings in the local runtime."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import urllib.request
import wave

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / 'cosy-tts-runtime' / 'voices'


def safe_destination(path: Path) -> Path:
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
    for voice in manifest['voices']:
        target = safe_destination(DEST / voice['file'])
        data = target.read_bytes() if target.exists() else b''
        if hashlib.sha256(data).hexdigest() != voice['sha256']:
            url = ('https://huggingface.co/datasets/AISHELL/AISHELL-3/resolve/'
                   + manifest['revision'] + '/' + voice['sourcePath'])
            request = urllib.request.Request(url, headers={'User-Agent': 'PDF-AI-Teacher-Voice-Setup'})
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(2 * 1024 * 1024)
            if len(data) != voice['bytes'] or hashlib.sha256(data).hexdigest() != voice['sha256']:
                raise ValueError('Reference recording checksum mismatch: ' + voice['id'])
            publish(target, data)
        with wave.open(str(target), 'rb') as recording:
            duration = recording.getnframes() / recording.getframerate()
            if recording.getnchannels() != 1 or not 2 <= duration <= 30 or recording.getframerate() < 16000:
                raise ValueError('Unsupported reference recording: ' + voice['id'])
        print(f"Verified {voice['id']}: {duration:.2f}s", flush=True)
    # Publish the manifest only after every recording passes validation.
    publish(DEST / 'NOTICE.txt', (ROOT / 'assets' / 'AISHELL-3-NOTICE.txt').read_bytes())
    publish(DEST / 'LICENSE.txt', (ROOT / 'assets' / 'APACHE-2.0.txt').read_bytes())
    publish(DEST / 'manifest.json', manifest_path.read_bytes())
    print('Five additional references installed; the existing CosyVoice demo remains available.', flush=True)


if __name__ == '__main__':
    main()
