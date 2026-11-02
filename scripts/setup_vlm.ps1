$ErrorActionPreference = 'Stop'
$TaskRoot = Split-Path -Parent $PSScriptRoot
$TaskPython = Join-Path $TaskRoot '.venv\Scripts\python.exe'
$TaskVlmPython = Join-Path $TaskRoot '.venv-vlm\Scripts\python.exe'
Push-Location $TaskRoot
try {
    if (-not (Test-Path -LiteralPath $TaskVlmPython)) {
        & uv venv --python $TaskPython .venv-vlm
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated training environment.' }
    }
    & uv pip install --python $TaskVlmPython torch==2.8.0 --index-url https://download.pytorch.org/whl/cu126
    if ($LASTEXITCODE -ne 0) { throw 'CUDA PyTorch installation failed.' }
    & uv pip install --python $TaskVlmPython -r requirements-vlm.txt
    if ($LASTEXITCODE -ne 0) { throw 'Training dependencies could not be installed.' }
    & $TaskVlmPython scripts/prepare_vlm_runtime.py
    if ($LASTEXITCODE -ne 0) { throw 'The local base model could not be prepared.' }
    & $TaskVlmPython scripts/vlm_worker.py probe
    if ($LASTEXITCODE -ne 0) { throw 'GPU training verification failed.' }
} finally {
    Pop-Location
}
