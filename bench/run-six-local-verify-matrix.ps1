param(
  [double]$StageTimeoutMinutes = 8,
  [string[]]$OnlyModels = @()
)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$batch = Get-Date -Format 'yyyyMMdd-HHmmss'
$logRoot = Join-Path $PSScriptRoot "results/six-local-verify-$batch"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

# Pair each executor profile with its same-weight self-review profile.  The
# runner requires the reviewer rank to be strictly higher than the executor.
$models = @(
  @{ executor = 'ollama:qwen3.8-27b-iq4'; reviewer = 'ollama:qwen3.8-27b-iq4-selfreview'; taskTimeout = 120 },
  @{ executor = 'ollama:devstral-small-2'; reviewer = 'ollama:devstral-small-2-selfreview'; taskTimeout = 120 },
  @{ executor = 'ollama:qwen3-coder-30b-ctx32k-stepfill-compactfill'; reviewer = 'ollama:qwen3-coder-30b-ctx32k-stepfill-compactfill-selfreview'; taskTimeout = 90 },
  @{ executor = 'ollama:gpt-oss-20b-compactfill'; reviewer = 'ollama:gpt-oss-20b-compactfill-selfreview'; taskTimeout = 90 },
  @{ executor = 'ollama:ministral3-14b-instruct-ctx32k-compactfill'; reviewer = 'ollama:ministral3-14b-instruct-ctx32k-compactfill-selfreview'; taskTimeout = 45 },
  @{ executor = 'ollama:gemma4-12b-compactfill'; reviewer = 'ollama:gemma4-12b-selfreview'; taskTimeout = 45 }
)
if ($OnlyModels.Count -gt 0) {
  $models = @($models | Where-Object { $_.executor -in $OnlyModels })
}

# Cover three task families with shorter intent forms; existing runs showed
# the larger notify task can consume most of a run in form filling alone.
$tasks = @('two-right-answers', 'refuse-dangerous', 'zero-change-verify')
$progress = @()

Push-Location $root
try {
  foreach ($pair in $models) {
    $model = $pair.executor
    $reviewer = $pair.reviewer
    foreach ($task in $tasks) {
      $modelSlug = $model -replace '[^a-zA-Z0-9]+', '-'
      $slug = "six-local-$batch-$modelSlug-$task"
      $result = Join-Path $PSScriptRoot "results/$slug.json"
      $log = Join-Path $logRoot "$slug.log"
      try {
        $taskTimeout = [int]$pair.taskTimeout
        & node bench/src/cli.ts --model $model --control-verify $reviewer --task $task --all --no-preflight --no-raw-log --slug $slug --stage-timeout $StageTimeoutMinutes --run-timeout $taskTimeout *> $log
        $exitCode = $LASTEXITCODE
      } catch {
        $_ | Out-String | Add-Content -LiteralPath $log
        $exitCode = 2
      }
      $runRecord = $null
      if (Test-Path -LiteralPath $result) {
        try { $runRecord = Get-Content -LiteralPath $result -Raw -Encoding utf8 | ConvertFrom-Json } catch { }
      }
      $record = [pscustomobject]@{
        model = $model
        reviewer = $reviewer
        task = $task
        stageTimeoutMinutes = $StageTimeoutMinutes
        runTimeoutMinutes = [int]$pair.taskTimeout
        slug = $slug
        result = if (Test-Path -LiteralPath $result) { Split-Path -Leaf $result } else { $null }
        exitCode = $exitCode
        state = if ($null -eq $runRecord) { 'no-result' } else { $runRecord.diagnostics.state }
        completedStages = if ($null -eq $runRecord) { @() } else { @($runRecord.driver.stages | ForEach-Object { "{0}:{1}" -f $_.stage,$_.ok }) }
        stopped = if ($null -eq $runRecord) { 'no-result' } else { $runRecord.driver.stopped }
        blocker = if ($null -eq $runRecord -or $runRecord.driver.stages.Count -eq 0) { $null } else { $runRecord.driver.stages[-1].note }
        finishedAt = (Get-Date).ToString('o')
      }
      $progress += $record
      $progress | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $logRoot 'progress.json') -Encoding utf8
    }
  }
} finally {
  Pop-Location
}
