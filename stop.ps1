param([string]$DataDir = 'C:\Codex\Apps\CodexRemoteWeb\data')
$ErrorActionPreference = 'Stop'
$OwnedPath = Join-Path $DataDir 'owned-processes.json'
if (!(Test-Path -LiteralPath $OwnedPath)) { Write-Output 'No owned process record found.'; exit 0 }
$Owned = Get-Content -LiteralPath $OwnedPath -Raw | ConvertFrom-Json
foreach ($Name in @('server','tunnel')) {
  $Entry = $Owned.$Name; if (!$Entry) { continue }
  try {
    $Process = Get-Process -Id ([int]$Entry.pid) -ErrorAction Stop
    $MatchesStart = $Process.StartTime.ToUniversalTime().ToString('o') -eq [string]$Entry.started
    $MatchesPath = $Process.Path -eq [string]$Entry.path
    if ($MatchesStart -and $MatchesPath) { Stop-Process -Id $Process.Id -ErrorAction Stop; Write-Output "Stopped owned $Name process $($Process.Id)." }
    else { Write-Warning "Skipped ${Name}: PID ownership validation failed." }
  } catch { Write-Output "Skipped ${Name}: process is already absent." }
}
