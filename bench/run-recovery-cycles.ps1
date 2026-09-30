param(
  [string[]]$Models = @('ollama:qwen3-8b-ctx32k-stepfill-compactfill', 'ollama:granite4.2-8b-ctx32k-compactfill', 'ollama:gemma4-12b-compactfill'),
  [int]$DiagnosticRepeats = 1,
  [int]$StageTimeout = 8
)
$ErrorActionPreference = 'Continue'
$recoveryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$definitions = Get-Content (Join-Path $recoveryRoot 'config/models.json') -Raw -Encoding utf8 | ConvertFrom-Json
$tasks = @('vat-rounding', 'two-right-answers', 'config-default', 'migration-compat', 'security-bait')
$batch = Get-Date -Format 'yyyyMMdd-HHmmss'
$progress = @()
Push-Location $recoveryRoot
try {
  foreach ($model in $Models) {
    $definition = $definitions.models | Where-Object { $_.id -eq $model }
    if (-not $definition -or $definition.provider -notin @('ollama', 'lmstudio')) { throw "Only configured local models are allowed: $model" }
    $modelSlug = $model -replace '[^a-zA-Z0-9_-]', '-'
    $diagLog = Join-Path $PSScriptRoot "results/recovery-$batch-$modelSlug-diagnostic.log"
    & node bench/src/diagnose.ts --model $model --repeat $DiagnosticRepeats --stage-timeout $StageTimeout *> $diagLog
    $diagnosticExit = $LASTEXITCODE
    & node bench/update-diagnostic-status.mjs
    # Exit 2 can mean unavailable inputs. Read structured preflight/case evidence to distinguish it.
    $reportFile = Get-ChildItem (Join-Path $PSScriptRoot "results/diagnostics-$modelSlug-*.json") | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $reportFile) { throw "No diagnostic evidence for $model" }
    $diagnostic = Get-Content $reportFile.FullName -Raw -Encoding utf8 | ConvertFrom-Json
    $failedSamples = @($diagnostic.cases | ForEach-Object { $_.samples } | Where-Object { $_.problemCodes.Count -gt 0 })
    if ($diagnostic.preflight.exitCode -ne 0 -or $failedSamples.Count -gt 0) {
      $progress += [pscustomobject]@{ model=$model; diagnostic=$reportFile.Name; diagnosticExit=$diagnosticExit; status='diagnostic-failed'; ready=$false }
      $progress | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $PSScriptRoot "results/recovery-$batch-progress.json") -Encoding utf8
      continue
    }
    foreach ($task in $tasks) {
      $slug = "recovery-$batch-$modelSlug-$task"
      $log = Join-Path $PSScriptRoot "results/$slug.log"
      & node bench/src/cli.ts --model $model --task $task --all --slug $slug --stage-timeout $StageTimeout --run-timeout 60 --quiet *> $log
      $progress += [pscustomobject]@{ model=$model; task=$task; diagnostic=$reportFile.Name; result="$slug.json"; exitCode=$LASTEXITCODE; status='cycle-recorded'; ready=$false }
      # Readiness is established only after semantic review of all required cases and cycles.
      $progress | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $PSScriptRoot "results/recovery-$batch-progress.json") -Encoding utf8
    }
  }
} finally { Pop-Location }
