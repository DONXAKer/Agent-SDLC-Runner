param(
  [ValidateSet('all','ollama','lmstudio')][string]$Provider = 'all',
  [ValidateRange(1,20)][int]$Repeat = 1,
  [ValidateRange(0.5,120)][double]$StageTimeout = 2,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
$config = Get-Content -Raw (Join-Path $root 'config/models.json') | ConvertFrom-Json
$available = [System.Collections.Generic.List[object]]::new()

if ($Provider -in @('all','ollama')) {
  $installedOllama = @()
  if (Get-Command ollama -ErrorAction SilentlyContinue) {
    try { $installedOllama = @(& ollama list | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ }) }
    catch { Write-Warning "Ollama unavailable: $($_.Exception.Message)" }
  }
  $ollamaEntries = @($config.models | Where-Object {
    $_.provider -eq 'ollama' -and ($installedOllama -contains $_.model -or $installedOllama -contains "$($_.model):latest")
  } | Group-Object model | ForEach-Object { $base=@($_.Group | Where-Object { $_.id -notmatch 'selfreview|reviewer|reviewfill|-rf$|compact|axisfill|explore(index|fill)' }); if ($base.Count) { $base[0] } else { $_.Group[0] } })
  foreach ($entry in $ollamaEntries) { $available.Add($entry) }
}

$lmBase = $env:LMSTUDIO_BASE_URL
if ($Provider -in @('all','lmstudio')) {
  $lmModels = @()
  if (-not $lmBase) {
    $configuredBase = $config.providers.lmstudio.baseUrl.TrimEnd('/')
    $baseCandidates = @($configuredBase, ($configuredBase -replace ':1234/', ':1434/')) | Select-Object -Unique
    foreach ($candidate in $baseCandidates) {
      try { $null = Invoke-RestMethod -Uri "$candidate/models" -TimeoutSec 3; $lmBase = $candidate; break } catch { }
    }
  }
  if ($lmBase) {
    try { $lmModels = @((Invoke-RestMethod -Uri "$($lmBase.TrimEnd('/'))/models" -TimeoutSec 3).data | ForEach-Object { $_.id }) }
    catch { Write-Warning "LM Studio API unavailable at $lmBase" }
  } else { Write-Host 'LM Studio unavailable; its profiles will be skipped.' }
  $lmEntries = @($config.models | Where-Object {
    $_.provider -eq 'lmstudio' -and $lmModels -contains $_.model
  } | Group-Object model | ForEach-Object { $base=@($_.Group | Where-Object { $_.id -notmatch 'selfreview|reviewer|reviewfill|-rf$|compact|axisfill|explore(index|fill)' }); if ($base.Count) { $base[0] } else { $_.Group[0] } })
  foreach ($entry in $lmEntries) { $available.Add($entry) }
}
if ($available.Count -eq 0) { throw 'No configured local models are currently available.' }
if ($lmBase) { $env:LMSTUDIO_BASE_URL = $lmBase.TrimEnd('/') }
Write-Host "Running $($available.Count) distinct installed local models; repeat=$Repeat; case timeout=${StageTimeout}m."
if ($WhatIf) { $available | ForEach-Object { Write-Host "$($_.provider): $($_.id) -> $($_.model)" }; exit 0 }

$summary = [System.Collections.Generic.List[object]]::new()
foreach ($entry in $available) {
  $loadedHere = $false
  if ($entry.provider -eq 'lmstudio') {
    $context = 16384; if ($entry.contextWindow) { $context = [int]$entry.contextWindow }
    $loaded = @()
    try { $loaded = @((& lms ps --json 2>$null) | ConvertFrom-Json) } catch { }
    $alreadyLoaded = $loaded | Where-Object { $_.identifier -eq $entry.model -or $_.modelKey -eq $entry.model }
    if (-not $alreadyLoaded) {
      Write-Host "`n=== Load $($entry.model), context=$context ==="
      & lms load $entry.model -c $context --parallel 1 --gpu max --yes *> $null
      if ($LASTEXITCODE -ne 0) { & lms load $entry.model -c $context --parallel 1 --gpu 0.8 --yes *> $null }
      if ($LASTEXITCODE -ne 0) {
        $summary.Add([pscustomobject]@{ id=$entry.id; provider=$entry.provider; model=$entry.model; status='load-failed'; exitCode=$LASTEXITCODE })
        $summary.ToArray() | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath 'bench/results/local-diagnostic-batch-latest.json' -Encoding utf8
        continue
      }
      $loadedHere = $true
    }
  }
  Write-Host "`n=== Diagnostic $($entry.id) ==="
  & npm.cmd run bench:diagnose -- --model $entry.id --repeat $Repeat --stage-timeout $StageTimeout
  $code = $LASTEXITCODE
  $safe = $entry.id -replace '[^a-zA-Z0-9_-]', '-'
  $reportFile = Get-ChildItem (Join-Path $root 'bench/results') -Filter "diagnostics-$safe-*.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $preflight = $null; $measured = 0; $timeouts = 0
  if ($reportFile) {
    $report = Get-Content -Raw $reportFile.FullName | ConvertFrom-Json
    $preflight = $report.preflight.exitCode
    $samples = @($report.cases | ForEach-Object samples)
    $measured = @($samples | Where-Object outcome -in @('completed','completed-with-findings')).Count
    $timeouts = @($samples | Where-Object timedOut -eq $true).Count
  }
  $summary.Add([pscustomobject]@{ id=$entry.id; provider=$entry.provider; model=$entry.model; exitCode=$code; preflight=$preflight; measuredCases=$measured; timeouts=$timeouts; report=$(if($reportFile){$reportFile.Name}else{$null}); completedAt=(Get-Date).ToString('o') })
  $summary.ToArray() | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath 'bench/results/local-diagnostic-batch-latest.json' -Encoding utf8
  if ($loadedHere) { & lms unload $entry.model *> $null }
}
Write-Host "`nSummary: bench/results/local-diagnostic-batch-latest.json"