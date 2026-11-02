$ErrorActionPreference = 'Stop'
$TaskRoot = Split-Path -Parent $PSScriptRoot
$TaskPython = Join-Path $TaskRoot '.venv\Scripts\python.exe'
$TaskTrainingPython = Join-Path $TaskRoot '.venv-vlm\Scripts\python.exe'
Push-Location $TaskRoot
try {
    if (-not (Test-Path -LiteralPath $TaskTrainingPython)) {
        & uv venv --python $TaskPython .venv-vlm
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated training environment.' }
    }
    & uv pip install --python $TaskTrainingPython torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu126
    if ($LASTEXITCODE -ne 0) { throw 'CUDA training package installation failed.' }
    & uv pip install --python $TaskTrainingPython -r requirements-scalp-training.txt
    if ($LASTEXITCODE -ne 0) { throw 'Scalp training dependencies could not be installed.' }
    Write-Output 'Scalp training runtime is ready. Training downloads the official 9.8 MB MobileNet weights on first use.'
} finally {
    Pop-Location
}
