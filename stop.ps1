param([string]$DataDir = '')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSCommandPath
# DataDir as in start.ps1: parameter > CODEX_REMOTE_DATA_DIR > local.settings.json dataDir > %LOCALAPPDATA%\CodexRemoteWeb\data.
# Only dataDir is resolved here, so a bad outputDir/nodeExe value cannot keep the panel from being stopped, and with
# -DataDir or CODEX_REMOTE_DATA_DIR the settings file is skipped entirely.
# --- shared path resolution: keep identical in start.ps1 and stop.ps1 (test/portable-config.test.mjs compares them) ---
# Same rules as server.mjs resolveSettings: case-sensitive keys; missing/null/blank values mean "not set"; any other
# non-string value stops; paths must be drive-absolute (C:\ or C:/) or UNC; JSON errors never echo the file content
# (runtime-config.json holds the password hash and session key).
function Test-PathSafe([string]$Path, [string]$Type = 'Any') {
  # Test-Path throws (not just $false) for an unreachable UNC share; treat that as "not there".
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  try { return [bool](Test-Path -LiteralPath $Path -PathType $Type -ErrorAction Stop) } catch { return $false }
}
function Test-AbsolutePath([string]$Value) { return ($Value -match '^[A-Za-z]:[\\/]') -or ($Value -match '^\\\\') }
function Read-JsonFile([string]$Path, [string]$Label) {
  # An empty file is invalid JSON too (ConvertFrom-Json would quietly return nothing), as in server.mjs.
  try { $Text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8; if ([string]::IsNullOrWhiteSpace($Text)) { throw 'empty' }; return ($Text | ConvertFrom-Json) } catch { throw "$Label is not valid JSON: $Path" }
}
function Read-LocalSettings([string]$Root) {
  $File = if (![string]::IsNullOrWhiteSpace($env:CODEX_REMOTE_SETTINGS)) { $env:CODEX_REMOTE_SETTINGS.Trim() } else { Join-Path $Root 'local.settings.json' }
  $Data = $null
  if (Test-PathSafe $File 'Container') { throw "Cannot read ${File}: it is a folder" }
  if (Test-PathSafe $File 'Leaf') {
    try { $Text = Get-Content -LiteralPath $File -Raw -Encoding UTF8; if ([string]::IsNullOrWhiteSpace($Text)) { throw 'empty' }; $Data = $Text | ConvertFrom-Json } catch { throw "$File is not valid JSON" }
    if ($Data -isnot [System.Management.Automation.PSCustomObject]) { throw "$File must contain a JSON object" }
  }
  return @{ File = $File; Data = $Data }
}
function Resolve-Setting($Settings, [string]$Explicit, [string]$EnvName, [string]$Key, [string]$Default) {
  $Value = ''; $Source = ''
  $FromEnv = [Environment]::GetEnvironmentVariable($EnvName)
  if (![string]::IsNullOrWhiteSpace($Explicit)) { $Value = $Explicit; $Source = 'parameter' }
  elseif (![string]::IsNullOrWhiteSpace($FromEnv)) { $Value = $FromEnv; $Source = "env:$EnvName" }
  elseif ($null -ne $Settings.Data) {
    $Property = @($Settings.Data.PSObject.Properties | Where-Object { $_.Name -ceq $Key }) | Select-Object -First 1
    if ($Property -and $null -ne $Property.Value) {
      if ($Property.Value -isnot [string]) { throw "$Key in $($Settings.File) must be a string" }
      $Value = $Property.Value; $Source = 'local.settings.json'
    }
  }
  if ([string]::IsNullOrWhiteSpace($Value)) { return @{ Value = $Default; Source = 'default' } }
  $Value = $Value.Trim()
  if (!(Test-AbsolutePath $Value)) { throw "$Key must be an absolute path (${Source}): $Value" }
  return @{ Value = $Value; Source = $Source }
}
function Get-DefaultDataDir {
  $Base = if (![string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { $env:LOCALAPPDATA.Trim() }
    elseif (![string]::IsNullOrWhiteSpace($env:USERPROFILE)) { Join-Path $env:USERPROFILE.Trim() 'AppData\Local' }
    else { Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData\Local' }
  return (Join-Path $Base 'CodexRemoteWeb\data')
}
# --- end shared path resolution ---
# With -DataDir (or CODEX_REMOTE_DATA_DIR) the settings file is not read at all, so a broken local.settings.json can be
# bypassed to stop the panel.
$Settings = if ([string]::IsNullOrWhiteSpace($DataDir) -and [string]::IsNullOrWhiteSpace($env:CODEX_REMOTE_DATA_DIR)) { Read-LocalSettings $Root } else { @{ File = ''; Data = $null } }
$DataDir = (Resolve-Setting $Settings $DataDir 'CODEX_REMOTE_DATA_DIR' 'dataDir' (Get-DefaultDataDir)).Value
$OwnedPath = Join-Path $DataDir 'owned-processes.json'
if (!(Test-PathSafe $OwnedPath)) { Write-Output "No owned process record found: $OwnedPath"; exit 0 }
$Owned = Read-JsonFile $OwnedPath 'owned-processes.json'
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
