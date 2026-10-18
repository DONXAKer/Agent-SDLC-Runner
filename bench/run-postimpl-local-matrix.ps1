$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logRoot = Join-Path $PSScriptRoot 'results/final-postimpl-local-matrix'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

$models = @(
  'ollama:gpt-oss-20b-compactfill',
  'ollama:ministral3-14b-instruct-ctx32k-compactfill'
)
$tasks = @(
  'vat-rounding',
  'two-right-answers',
  'config-default',
  'migration-compat',
  'security-bait'
)
$completed = @()

foreach ($model in $models) {
  $modelSlug = $model.Split(':')[1]
  foreach ($task in $tasks) {
    $slug = "final-postimpl-$modelSlug-$task"
    $result = Join-Path $PSScriptRoot "results/$slug.json"
    if (Test-Path -LiteralPath $result) {
      $completed += [pscustomobject]@{ slug = $slug; status = 'existing result preserved'; exitCode = $null }
      continue
    }

    $log = Join-Path $logRoot "$slug.log"
    Push-Location $root
    try {
      & npm.cmd run bench -- --model $model --control-verify $model --task $task --all --no-preflight --no-raw-log --slug $slug *> $log
      $code = $LASTEXITCODE
    } catch {
      $_ | Out-String | Add-Content -LiteralPath $log
      $code = 1
    } finally {
      Pop-Location
    }
    $status = if (Test-Path -LiteralPath $result) { 'result recorded' } else { 'no result file' }
    $completed += [pscustomobject]@{ slug = $slug; status = $status; exitCode = $code }
    $completed | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $logRoot 'progress.json') -Encoding utf8
  }
}

$completed | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $logRoot 'progress.json') -Encoding utf8
