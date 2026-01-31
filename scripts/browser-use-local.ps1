# Usage:
#   pwsh scripts/browser-use-local.ps1 -Task "Open example.com and take a screenshot"
#   or: $env:BROWSER_USE_TASK="..." ; pwsh scripts/browser-use-local.ps1
param(
  [string]$Task = $env:BROWSER_USE_TASK
)

if (-not $Task) {
  Write-Error "Set -Task or BROWSER_USE_TASK"
  exit 1
}

$venvPath = ".venv-browser-use"
if (-not (Test-Path $venvPath)) {
  Write-Host "Creating venv at $venvPath"
  python -m venv $venvPath
}

$activate = Join-Path $venvPath "Scripts\Activate.ps1"
if (-not (Test-Path $activate)) {
  Write-Error "Virtualenv activate script not found ($activate)"
  exit 1
}
. $activate

python -m pip install --upgrade pip >$null
python -m pip install --upgrade browser-use >$null

$model = $env:BROWSER_USE_MODEL
if (-not $model) { $model = "ollama/llama3" }
$llmBase = $env:OLLAMA_URL
if (-not $llmBase) { $llmBase = "http://localhost:11434" }
$llmBase = "$llmBase/v1"

Write-Host "Running browser-use locally with model=$model llmBase=$llmBase"
python -m browser_use run --model $model --llm-base-url $llmBase --task "$Task"
