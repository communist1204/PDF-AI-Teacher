"""Download pinned, public CosyVoice assets inside this project only (no global setup)."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import shutil
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / 'cosy-tts-runtime'
CODE_REVISION = '074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc'
MATCHA_REVISION = 'dd9105b34bf2be2230f4aa1e4769fb586a3c824e'
MODEL_ID = 'FunAudioLLM/Fun-CosyVoice3-0.5B-2512'
MODEL_REVISION = '29e01c4e8d000f4bcd70751be16fa94bf3d85a18'
MODEL_DIR = RUNTIME / 'models' / MODEL_ID.split('/')[-1]
REQUIRED_FILES = {
    'README.md', 'config.json', 'configuration.json', 'cosyvoice3.yaml',
    'campplus.onnx', 'speech_tokenizer_v3.onnx', 'llm.pt', 'flow.pt', 'hift.pt',
    'CosyVoice-BlankEN/config.json', 'CosyVoice-BlankEN/generation_config.json',
    'CosyVoice-BlankEN/merges.txt', 'CosyVoice-BlankEN/model.safetensors',
    'CosyVoice-BlankEN/tokenizer_config.json', 'CosyVoice-BlankEN/vocab.json',
}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def download(url: str, destination: Path, size: int | None = None,
             expected_hash: str | None = None) -> dict:
    destination.resolve().relative_to(RUNTIME.resolve())
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and (size is None or destination.stat().st_size == size):
        actual = digest(destination)
        if expected_hash is None or actual == expected_hash:
            return {'file': str(destination.relative_to(RUNTIME)), 'bytes': destination.stat().st_size, 'sha256': actual}
    part = destination.with_suffix(destination.suffix + '.part')
    for attempt in range(3):
        try:
            offset = part.stat().st_size if part.exists() else 0
            headers = {'User-Agent': 'PDF-AI-Teacher-CosyVoice-Setup'}
            if offset:
                headers['Range'] = f'bytes={offset}-'
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
                append = offset > 0 and response.status == 206
                with part.open('ab' if append else 'wb') as target:
                    while block := response.read(1024 * 1024):
                        target.write(block)
            if size is not None and part.stat().st_size != size:
                raise ValueError('Unexpected file size for ' + destination.name)
            actual = digest(part)
            if expected_hash is not None and actual != expected_hash:
                part.unlink()
                raise ValueError('Checksum mismatch for ' + destination.name)
            part.replace(destination)
            print('Verified ' + str(destination.relative_to(RUNTIME)), flush=True)
            return {'file': str(destination.relative_to(RUNTIME)), 'bytes': destination.stat().st_size, 'sha256': actual}
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2)
    raise RuntimeError('Download failed')


def source_archive(owner_repo: str, revision: str, target: Path, archive_name: str) -> dict:
    archive = RUNTIME / archive_name
    metadata = download(f'https://codeload.github.com/{owner_repo}/zip/{revision}', archive)
    if not target.exists() or not any(target.iterdir()):
        target.resolve().relative_to(RUNTIME.resolve())
        target.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                relative = Path(*Path(member.filename).parts[1:])
                if str(relative) == '.':
                    continue
                output = (target / relative).resolve()
                output.relative_to(target.resolve())
                if member.is_dir():
                    output.mkdir(parents=True, exist_ok=True)
                else:
                    output.parent.mkdir(parents=True, exist_ok=True)
                    with source.open(member) as data, output.open('wb') as out:
                        shutil.copyfileobj(data, out)
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--workers', type=int, default=3, choices=range(1, 5))
    args = parser.parse_args()
    RUNTIME.mkdir(exist_ok=True)
    code = source_archive('QwenAudio/CosyVoice', CODE_REVISION, RUNTIME / 'repo', 'source.zip')
    matcha = source_archive('shivammehta25/Matcha-TTS', MATCHA_REVISION,
                           RUNTIME / 'repo' / 'third_party' / 'Matcha-TTS', 'matcha-source.zip')
    catalog_path = RUNTIME / 'model-files.json'
    if catalog_path.exists():
        files = json.loads(catalog_path.read_text(encoding='utf-8-sig'))
    else:
        url = f'https://huggingface.co/api/models/{MODEL_ID}/revision/{MODEL_REVISION}?blobs=true'
        with urllib.request.urlopen(url, timeout=30) as response:
            files = json.load(response)['siblings']
        catalog_path.write_text(json.dumps(files, indent=2), encoding='utf-8')
    selected = [item for item in files if item['rfilename'] in REQUIRED_FILES]
    if len(selected) != len(REQUIRED_FILES):
        raise ValueError('Required model files missing from catalog')
    print(f'Downloading {len(selected)} required files ({sum(item["size"] for item in selected)/1e9:.2f} GB)', flush=True)

    def fetch(item: dict) -> dict:
        name = item['rfilename']
        url = f'https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}/{name}?download=true'
        return download(url, MODEL_DIR / name, item['size'], (item.get('lfs') or {}).get('sha256'))

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        verified = list(pool.map(fetch, selected))
    manifest = {'modelId': MODEL_ID, 'modelRevision': MODEL_REVISION,
                'codeRevision': CODE_REVISION, 'matchaRevision': MATCHA_REVISION,
                'sourceArchives': [code, matcha], 'files': verified,
                'weightsVerified': True, 'inferenceVerified': False}
    (RUNTIME / 'install-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print('All selected model files verified; inference is not yet verified.', flush=True)


if __name__ == '__main__':
    main()
