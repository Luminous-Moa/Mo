param(
  [string]$DataDir = 'C:\Codex\Apps\CodexRemoteWeb\data',
  [string]$NodeExe = 'C:\Codex\Apps\Development-SDKs-2026-09-20\node-lts\node.exe'
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSCommandPath
$ConfigPath = Join-Path $DataDir 'runtime-config.json'
$LogDir = Join-Path $DataDir 'logs'
$OwnedPath = Join-Path $DataDir 'owned-processes.json'
$UrlOutput = 'C:\Codex\2026-09-22\new-chat\outputs\CodexRemoteWeb-url.txt'
if (!(Test-Path -LiteralPath $ConfigPath)) { throw "Run node setup.mjs first: $ConfigPath" }
if (!(Test-Path -LiteralPath $NodeExe)) { throw "Node executable not found: $NodeExe" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$Cloudflared = $Config.cloudflaredPath
if ([string]::IsNullOrWhiteSpace($Cloudflared) -or !(Test-Path -LiteralPath $Cloudflared)) { throw 'Set an existing cloudflaredPath in runtime-config.json.' }
$Port = [int]$Config.port
if ($Port -lt 1 -or $Port -gt 65535) { throw 'runtime-config.json has an invalid port.' }
if (Test-Path -LiteralPath $OwnedPath) {
  $Existing = Get-Content -LiteralPath $OwnedPath -Raw | ConvertFrom-Json
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
$Tunnel = Start-Process -FilePath $Cloudflared -ArgumentList @('--no-autoupdate','tunnel','--url',("http://127.0.0.1:$Port")) -WindowStyle Hidden -RedirectStandardOutput $TunnelOut -RedirectStandardError $TunnelErr -PassThru
$Deadline = (Get-Date).AddSeconds(30); $Url = $null
while ((Get-Date) -lt $Deadline -and !$Url) {
  if ($Tunnel.HasExited) { throw 'cloudflared stopped before issuing a tunnel URL.' }
  $Log = (Get-Content -LiteralPath $TunnelOut -Raw -ErrorAction SilentlyContinue) + (Get-Content -LiteralPath $TunnelErr -Raw -ErrorAction SilentlyContinue)
  $Match = [regex]::Match($Log, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($Match.Success) { $Url = $Match.Value; break }
  Start-Sleep -Milliseconds 500
}
if (!$Url) { Stop-Process -Id $Tunnel.Id -ErrorAction SilentlyContinue; throw 'No valid Quick Tunnel URL appeared within 30 seconds.' }
$Config.publicOrigin = $Url
$TempConfig = "$ConfigPath.$PID.tmp"
[System.IO.File]::WriteAllText($TempConfig, ($Config | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $TempConfig -Destination $ConfigPath -Force
$PreviousConfig = $env:CODEX_REMOTE_CONFIG; $env:CODEX_REMOTE_CONFIG = $ConfigPath
try { $Server = Start-Process -FilePath $NodeExe -ArgumentList @((Join-Path $Root 'server.mjs')) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $ServerOut -RedirectStandardError $ServerErr -PassThru } finally { $env:CODEX_REMOTE_CONFIG = $PreviousConfig }
$HealthDeadline = (Get-Date).AddSeconds(15); $Healthy = $false
while ((Get-Date) -lt $HealthDeadline) { if ($Server.HasExited) { throw 'Node server stopped during startup.' }; try { if ((Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2).StatusCode -eq 200) { $Healthy = $true; break } } catch {}; Start-Sleep -Milliseconds 300 }
if (!$Healthy) { throw 'Node server did not pass its localhost health check within 15 seconds.' }
$Server.Refresh()
if ($Server.HasExited) { throw 'Node server stopped after its health check.' }
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
