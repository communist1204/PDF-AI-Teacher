$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$runtimePath = Join-Path $projectRoot 'cosy-tts-runtime'
$pythonPath = Join-Path $runtimePath 'venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    & py -3.11 -m venv (Join-Path $runtimePath 'venv')
    if ($LASTEXITCODE -ne 0) { throw '需要本机 Python 3.11；未修改全局环境。' }
}
# Everything is confined to this project venv/cache. The driver is not changed.
& $pythonPath -m pip install 'setuptools==80.9.0' 'wheel==0.48.0' --cache-dir .model-cache/cosy-pip --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw '本项目构建依赖安装失败。' }
& $pythonPath -m pip install 'torch==2.8.0' 'torchaudio==2.8.0' --index-url https://download.pytorch.org/whl/cu128 --cache-dir .model-cache/cosy-pip --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw '本项目 GPU PyTorch 安装失败。' }
# Whisper's pinned source release needs pkg_resources from setuptools<81 while building.
& $pythonPath -m pip install --no-build-isolation -r scripts/cosy-requirements-lock.txt --cache-dir .model-cache/cosy-pip --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw '本项目语音依赖安装失败。' }
& $pythonPath -m pip check
if ($LASTEXITCODE -ne 0) { throw '语音依赖校验失败。' }
& $pythonPath -u scripts/setup-cosy-tts.py
if ($LASTEXITCODE -ne 0) { throw '模型文件下载或校验失败。' }
Write-Host '安装完成。真实 GPU 验证：py -3.11 -u scripts/verify-cosy-runtime.py。'
