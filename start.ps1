param(
  [string]$DataDir = '',
  [string]$NodeExe = '',
  [string]$OutputDir = '',
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSCommandPath

# Per-machine paths. For each value the first non-empty source wins:
#   parameter > environment variable > local.settings.json (repository root, git-ignored) > portable default.
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
$Settings = Read-LocalSettings $Root
$DataSetting = Resolve-Setting $Settings $DataDir 'CODEX_REMOTE_DATA_DIR' 'dataDir' (Get-DefaultDataDir)
$DataDir = $DataSetting.Value
$OutputSetting = Resolve-Setting $Settings $OutputDir 'CODEX_REMOTE_OUTPUT_DIR' 'outputDir' $DataDir
$OutputDir = $OutputSetting.Value
$NodeSetting = Resolve-Setting $Settings $NodeExe 'CODEX_REMOTE_NODE_EXE' 'nodeExe' ''

# PATH lookup with the rule of bridge/app-server.mjs findOnPath: absolute PATH entries only ('.' or another relative
# entry would pick up files from the current folder); within a folder, the given extensions in order.
function Find-OnPath([string]$Name, [string[]]$Extensions) {
  foreach ($Raw in ([string]$env:PATH -split ';')) {
    $Dir = $Raw.Trim().Trim('"')
    if (!$Dir -or !(Test-AbsolutePath $Dir)) { continue }
    foreach ($Extension in $Extensions) {
      # A PATH entry with characters that are invalid in paths (for example a stray quote: "C:\x"\bin) is skipped.
      try { $Candidate = [System.IO.Path]::Combine($Dir, $Name + $Extension) } catch { continue }
      if (Test-PathSafe $Candidate 'Leaf') { return $Candidate }
    }
  }
  return ''
}
# Text from Node is read by Windows PowerShell in the console code page (949 on Korean Windows), which garbles
# non-ASCII paths. Node therefore prints percent-encoded (pure ASCII) text and it is decoded here.
function ConvertFrom-NodeAscii($Output) {
  $Text = "$(@($Output) -join '')".Trim()
  if (!$Text) { return '' }
  try { return [Uri]::UnescapeDataString($Text) } catch { return '' }
}
# PATH may hold a shim (Volta, nvm-windows, a .cmd wrapper): ask it for the real node.exe so the process started and
# recorded below is the one that owns the listener. The expression has no spaces or cmd.exe metacharacters.
function Get-NodeRealPath([string]$Command) {
  $PreviousPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $Output = & $Command -p 'encodeURIComponent(process.execPath)' 2>$null } catch { $Output = '' } finally { $ErrorActionPreference = $PreviousPreference }
  $Real = ConvertFrom-NodeAscii $Output
  if ($Real -and (Test-AbsolutePath $Real) -and (Test-PathSafe $Real 'Leaf')) { return $Real }
  return ''
}
$NodeNote = ''
if ($NodeSetting.Source -eq 'default') {
  $PathExt = @(([string]$env:PATHEXT -split ';') | Where-Object { $_ })
  if (!$PathExt.Count) { $PathExt = @('.COM', '.EXE', '.BAT', '.CMD') }
  $NodeFound = Find-OnPath 'node' $PathExt
  $NodeReal = ''
  if (!$NodeFound) { $NodeNote = '(node not found on PATH) - install Node.js or set nodeExe in local.settings.json' }
  else {
    $NodeReal = Get-NodeRealPath $NodeFound
    if (!$NodeReal -and $NodeFound -match '\.exe$') { $NodeReal = $NodeFound }
    if (!$NodeReal) { $NodeNote = "(node on PATH, $NodeFound, did not report its node.exe) - set nodeExe in local.settings.json" }
  }
  $NodeSetting = @{ Value = $NodeReal; Source = 'PATH' }
}
$NodeExe = $NodeSetting.Value
$ConfigPath = Join-Path $DataDir 'runtime-config.json'
$LogDir = Join-Path $DataDir 'logs'
$OwnedPath = Join-Path $DataDir 'owned-processes.json'
$UrlOutput = Join-Path $OutputDir 'CodexRemoteWeb-url.txt'

# cloudflared: runtime-config cloudflaredPath when set, otherwise PATH, otherwise the Cloudflare installer (winget)
# folders, which a shell opened before the install does not have on PATH yet.
function Resolve-Cloudflared([string]$Configured) {
  if (![string]::IsNullOrWhiteSpace($Configured)) { return @{ Path = $Configured; Source = 'runtime-config.json'; Exists = (Test-PathSafe $Configured 'Leaf') } }
  $OnPath = Find-OnPath 'cloudflared' @('.exe')
  if ($OnPath) { return @{ Path = $OnPath; Source = 'PATH'; Exists = $true } }
  foreach ($Base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
    if ([string]::IsNullOrWhiteSpace($Base)) { continue }
    $Candidate = Join-Path $Base 'cloudflared\cloudflared.exe'
    if (Test-PathSafe $Candidate 'Leaf') { return @{ Path = $Candidate; Source = 'install folder'; Exists = $true } }
  }
  return @{ Path = ''; Source = 'not found'; Exists = $false }
}
function Get-LogTail([string]$Path, [int]$Count = 20) {
  if (!(Test-PathSafe $Path 'Leaf')) { return '' }
  $Lines = @(Get-Content -LiteralPath $Path -Tail $Count -Encoding UTF8 -ErrorAction SilentlyContinue)
  if (!$Lines.Count) { return '' }
  return "`n--- last lines of ${Path} ---`n" + ($Lines -join "`n")
}
# Start-Process in Windows PowerShell 5.1 joins -ArgumentList items with spaces without quoting them, so a path with
# spaces arrives split. Build one command line with the standard Windows (CommandLineToArgvW) quoting instead.
function ConvertTo-CommandLine([string[]]$Arguments) {
  $Parts = foreach ($Argument in $Arguments) {
    if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') { $Argument; continue }
    $Text = '"'; $Slashes = 0
    foreach ($Char in $Argument.ToCharArray()) {
      if ($Char -eq [char]'\') { $Slashes++; continue }
      if ($Char -eq [char]'"') { $Text += ('\' * ($Slashes * 2 + 1)) + '"' } else { $Text += ('\' * $Slashes) + $Char }
      $Slashes = 0
    }
    $Text + ('\' * ($Slashes * 2)) + '"'
  }
  return ($Parts -join ' ')
}

if ($CheckOnly) {
  # Reports only; starts nothing and writes nothing. Exit code 1 when something required is missing.
  $Problems = 0
  function Show([string]$Label, [string]$Text) { Write-Output ('{0,-15} {1}' -f $Label, $Text) }
  function State([bool]$Ok) { if ($Ok) { 'OK' } else { $script:Problems++; 'MISSING' } }
  Show 'Settings file' ("$($Settings.File) " + $(if ($null -ne $Settings.Data) { '(used)' } else { '(not present, defaults apply)' }))
  Show 'Data folder' ("$DataDir [$($DataSetting.Source)] " + $(if (Test-PathSafe $DataDir 'Container') { 'exists' } else { 'not created yet' }))
  $HasConfig = Test-PathSafe $ConfigPath 'Leaf'
  $Config = $null; $ConfigError = ''
  if ($HasConfig) { try { $Config = Read-JsonFile $ConfigPath 'runtime-config.json' } catch { $ConfigError = $_.Exception.Message } }
  if ($ConfigError) { $script:Problems++; Show 'Runtime config' "$ConfigError INVALID - fix or recreate it (the content is not shown)" }
  else { Show 'Runtime config' ("$ConfigPath " + (State $HasConfig) + $(if (!$HasConfig) { ' - run: node setup.mjs' } else { '' })) }
  Show 'Output folder' ("$OutputDir [$($OutputSetting.Source)] (access password file, tunnel URL file)")
  $HasNode = ![string]::IsNullOrWhiteSpace($NodeExe) -and (Test-PathSafe $NodeExe 'Leaf')
  $NodeVersion = ''
  if ($HasNode) { $NodeVersion = (& $NodeExe --version) 2>$null }
  Show 'Node' ("$(if ($NodeExe) { $NodeExe } elseif ($NodeNote) { $NodeNote } else { '(not set)' }) [$($NodeSetting.Source)] $NodeVersion " + (State $HasNode))
  if ($Config) {
    Show 'Port' ([string]$Config.port)
    $Allowed = @($Config.allowedRoots | Where-Object { $_ })
    Show 'allowedRoots' $(if ($Allowed.Count) { ($Allowed | ForEach-Object { "$_ (" + $(if (Test-PathSafe $_ 'Container') { 'exists' } else { 'missing' }) + ')' }) -join '; ' } else { '(empty) - new tasks cannot start until you add a folder' })
    $Resume = @($Config.resumeRoots | Where-Object { $_ })
    Show 'resumeRoots' $(if ($Resume.Count) { $Resume -join '; ' } else { '(empty)' })
  }
  # Codex: the server's own resolution (bridge/app-server.mjs resolveCodexExe), run in Node without starting anything.
  if ($HasNode) {
    $Previous = @($env:CODEX_REMOTE_CHECK_BRIDGE, $env:CODEX_REMOTE_CHECK_CODEX)
    $env:CODEX_REMOTE_CHECK_BRIDGE = Join-Path $Root 'bridge\app-server.mjs'
    $env:CODEX_REMOTE_CHECK_CODEX = $(if ($Config) { [string]$Config.codexExe } else { '' })
    $Codex = $null
    $PreviousPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $Probe = 'const {pathToFileURL}=await import(`node:url`);const m=await import(pathToFileURL(process.env.CODEX_REMOTE_CHECK_BRIDGE).href);process.stdout.write(encodeURIComponent(JSON.stringify(m.resolveCodexExe(process.env.CODEX_REMOTE_CHECK_CODEX))))'
      $ProbeOut = & $NodeExe --input-type=module -e $Probe 2>$null
      if ($LASTEXITCODE -eq 0) { $ProbeJson = ConvertFrom-NodeAscii $ProbeOut; if ($ProbeJson) { $Codex = $ProbeJson | ConvertFrom-Json } }
    } catch { $Codex = $null } finally { $ErrorActionPreference = $PreviousPreference; $env:CODEX_REMOTE_CHECK_BRIDGE = $Previous[0]; $env:CODEX_REMOTE_CHECK_CODEX = $Previous[1] }
    $CodexOk = [bool]($Codex -and $Codex.source -and $Codex.source -ne 'none' -and $Codex.command)
    $CodexNote = if ($Codex -and $Codex.missing) { " (configured codexExe not found: $($Codex.missing))" } else { '' }
    if (!$Codex) { Show 'Codex' ('(check failed: could not run the Codex lookup in Node) ' + (State $false)) }
    else { Show 'Codex' ("$(if ($CodexOk) { $Codex.command } else { '(not found) - install and sign in to the Codex desktop app, put codex.exe on PATH, or set codexExe' }) [$($Codex.source)]$CodexNote " + (State $CodexOk)) }
  } else { Show 'Codex' ('(needs Node to check) ' + (State $false)) }
  $Tunnel = Resolve-Cloudflared $(if ($Config) { [string]$Config.cloudflaredPath } else { '' })
  Show 'cloudflared' ("$(if ($Tunnel.Path) { $Tunnel.Path } else { '(not found) - winget install --id Cloudflare.cloudflared' }) [$($Tunnel.Source)] " + (State $Tunnel.Exists))
  Show 'URL file' $UrlOutput
  if ($Problems) { Write-Output "$Problems required item(s) missing."; exit 1 }
  Write-Output 'All required items found. Nothing was started.'
  exit 0
}

if (!(Test-PathSafe $ConfigPath)) { throw "Run node setup.mjs first: $ConfigPath" }
if ([string]::IsNullOrWhiteSpace($NodeExe)) { throw "Node.js is not usable: $(if ($NodeNote) { $NodeNote } else { 'not found' }). Install Node.js, or set nodeExe in local.settings.json (or -NodeExe)." }
if (!(Test-PathSafe $NodeExe)) { throw "Node executable not found: $NodeExe" }
$Config = Read-JsonFile $ConfigPath 'runtime-config.json'
$TunnelInfo = Resolve-Cloudflared ([string]$Config.cloudflaredPath)
if (!$TunnelInfo.Exists) {
  if ($TunnelInfo.Source -eq 'runtime-config.json') { throw "cloudflaredPath in runtime-config.json does not exist: $($TunnelInfo.Path). Fix it, or empty it to use cloudflared from PATH." }
  throw 'cloudflared was not found. Install it (winget install --id Cloudflare.cloudflared) or set cloudflaredPath in runtime-config.json.'
}
$Cloudflared = $TunnelInfo.Path
$Port = [int]$Config.port
if ($Port -lt 1 -or $Port -gt 65535) { throw 'runtime-config.json has an invalid port.' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if (Test-PathSafe $OwnedPath) {
  $Existing = Read-JsonFile $OwnedPath 'owned-processes.json'
  foreach ($Name in @('server','tunnel')) {
    $Entry = $Existing.$Name
    if ($Entry) {
      $Process = Get-Process -Id ([int]$Entry.pid) -ErrorAction SilentlyContinue
      if ($Process -and $Process.StartTime.ToUniversalTime().ToString('o') -eq [string]$Entry.started -and $Process.Path -eq [string]$Entry.path) { throw "A live owned $Name process already exists. Run stop.ps1 first." }
    }
  }
}
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$TunnelOut = Join-Path $LogDir "cloudflared-$Stamp.stdout.log"
$TunnelErr = Join-Path $LogDir "cloudflared-$Stamp.stderr.log"
$ServerOut = Join-Path $LogDir "server-$Stamp.stdout.log"
$ServerErr = Join-Path $LogDir "server-$Stamp.stderr.log"
$Tunnel = $null; $Server = $null
try {
$Tunnel = Start-Process -FilePath $Cloudflared -ArgumentList (ConvertTo-CommandLine @('--no-autoupdate','tunnel','--url',("http://127.0.0.1:$Port"))) -WindowStyle Hidden -RedirectStandardOutput $TunnelOut -RedirectStandardError $TunnelErr -PassThru
$Deadline = (Get-Date).AddSeconds(30); $Url = $null
while ((Get-Date) -lt $Deadline -and !$Url) {
  if ($Tunnel.HasExited) { throw ('cloudflared stopped before issuing a tunnel URL.' + (Get-LogTail $TunnelErr)) }
  $Log = (Get-Content -LiteralPath $TunnelOut -Raw -ErrorAction SilentlyContinue) + (Get-Content -LiteralPath $TunnelErr -Raw -ErrorAction SilentlyContinue)
  $Match = [regex]::Match($Log, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($Match.Success) { $Url = $Match.Value; break }
  Start-Sleep -Milliseconds 500
}
if (!$Url) { Stop-Process -Id $Tunnel.Id -ErrorAction SilentlyContinue; throw ('No valid Quick Tunnel URL appeared within 30 seconds.' + (Get-LogTail $TunnelErr)) }
$Config.publicOrigin = $Url
$TempConfig = "$ConfigPath.$PID.tmp"
[System.IO.File]::WriteAllText($TempConfig, ($Config | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $TempConfig -Destination $ConfigPath -Force
$PreviousConfig = $env:CODEX_REMOTE_CONFIG; $env:CODEX_REMOTE_CONFIG = $ConfigPath
try { $Server = Start-Process -FilePath $NodeExe -ArgumentList (ConvertTo-CommandLine @((Join-Path $Root 'server.mjs'))) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $ServerOut -RedirectStandardError $ServerErr -PassThru } finally { $env:CODEX_REMOTE_CONFIG = $PreviousConfig }
$HealthDeadline = (Get-Date).AddSeconds(15); $Healthy = $false
while ((Get-Date) -lt $HealthDeadline) { if ($Server.HasExited) { throw ('Node server stopped during startup.' + (Get-LogTail $ServerErr)) }; try { if ((Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2).StatusCode -eq 200) { $Healthy = $true; break } } catch {}; Start-Sleep -Milliseconds 300 }
if (!$Healthy) { throw ('Node server did not pass its localhost health check within 15 seconds.' + (Get-LogTail $ServerErr)) }
$Server.Refresh()
if ($Server.HasExited) { throw ('Node server stopped after its health check.' + (Get-LogTail $ServerErr)) }
$OwnedListener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $Server.Id }
if (!$OwnedListener) { throw 'The health endpoint is not owned by the newly started Node server.' }
$Tunnel.Refresh(); $Server.Refresh()
$Record = [ordered]@{ tunnel = @{ pid=$Tunnel.Id; path=(Resolve-Path -LiteralPath $Cloudflared).Path; started=$Tunnel.StartTime.ToUniversalTime().ToString('o') }; server = @{ pid=$Server.Id; path=(Resolve-Path -LiteralPath $NodeExe).Path; started=$Server.StartTime.ToUniversalTime().ToString('o') } }
$TempOwned = "$OwnedPath.$PID.tmp"; $Record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $TempOwned -Encoding utf8; Move-Item -LiteralPath $TempOwned -Destination $OwnedPath -Force
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $UrlOutput) | Out-Null
[System.IO.File]::WriteAllText($UrlOutput, $Url, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "Tunnel URL: $Url"
Write-Output "URL file: $UrlOutput"
} catch {
  if ($Server -and !$Server.HasExited) { Stop-Process -Id $Server.Id -ErrorAction SilentlyContinue }
  if ($Tunnel -and !$Tunnel.HasExited) { Stop-Process -Id $Tunnel.Id -ErrorAction SilentlyContinue }
  throw
}
