[CmdletBinding()]
param(
  [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Require-Env([string]$Name) {
  $Value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "Missing required environment variable: $Name"
  }
  return $Value
}

function Ensure-Command([string]$Name, [string]$WingetId) {
  if (Get-Command $Name -ErrorAction SilentlyContinue) { return }
  if ($SkipDependencyInstall) { throw "$Name is required." }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "$Name is required and winget is unavailable. Install $Name, then run this command again."
  }
  winget install --id $WingetId --exact --silent --accept-package-agreements --accept-source-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was installed but is not available in PATH yet. Open a new PowerShell window and run the command again."
  }
}

function Write-EnvFile([string]$Path, [hashtable]$Values) {
  $Lines = foreach ($Key in $Values.Keys) {
    $Value = [string]$Values[$Key]
    "$Key=$Value"
  }
  [IO.File]::WriteAllLines($Path, $Lines, [Text.UTF8Encoding]::new($false))
}

function Register-TrooperTask([string]$Name, [string]$ScriptPath) {
  $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
  $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
  Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Trigger -Settings $Settings -Description "Trooper local Windows host service" -Force | Out-Null
  Start-ScheduledTask -TaskName $Name
}

$OrgId = Require-Env "ORG_ID"
$ApiUrl = Require-Env "API_URL"
$GatewayToken = Require-Env "GATEWAY_TOKEN"
$BridgeAuthToken = Require-Env "BRIDGE_AUTH_TOKEN"

$TrooperHome = if ($env:TROOPER_HOME) { $env:TROOPER_HOME } else { Join-Path $env:LOCALAPPDATA "Trooper\runtime" }
$BridgeDir = if ($env:BRIDGE_DIR) { $env:BRIDGE_DIR } else { Join-Path $TrooperHome "bridge" }
$BinDir = Join-Path $TrooperHome "bin"
$LogDir = Join-Path $TrooperHome "logs"
$EnvFile = Join-Path $TrooperHome "trooper-local-host.env"
$BridgePort = if ($env:BRIDGE_PORT) { $env:BRIDGE_PORT } else { "3002" }
$GatewayPort = if ($env:GATEWAY_PORT) { $env:GATEWAY_PORT } else { "18789" }
$HostDeviceId = if ($env:HOST_DEVICE_ID) { $env:HOST_DEVICE_ID } else { "windows-$($env:COMPUTERNAME.ToLowerInvariant())" }
$BridgeRepo = if ($env:TROOPER_BRIDGE_REPO_URL) { $env:TROOPER_BRIDGE_REPO_URL } else { "https://github.com/absurdfounder/trooper-bridge.git" }

New-Item -ItemType Directory -Force -Path $TrooperHome, $BinDir, $LogDir | Out-Null
Ensure-Command "git" "Git.Git"
Ensure-Command "node" "OpenJS.NodeJS.LTS"
Ensure-Command "cloudflared" "Cloudflare.cloudflared"

if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) {
  Invoke-Expression (Invoke-WebRequest -UseBasicParsing "https://openclaw.ai/install.ps1").Content
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) {
  throw "OpenClaw installed but is not available in PATH yet. Open a new PowerShell window and run the command again."
}

if (-not (Test-Path (Join-Path $BridgeDir ".git"))) {
  git clone $BridgeRepo $BridgeDir
} else {
  git -C $BridgeDir fetch --all --prune
  git -C $BridgeDir pull --ff-only
}
if ($env:OPENCLAWBRIDGE_GIT_SHA) {
  git -C $BridgeDir checkout $env:OPENCLAWBRIDGE_GIT_SHA
}
npm --prefix $BridgeDir install --omit=dev

Write-EnvFile $EnvFile @{
  ORG_ID = $OrgId
  API_URL = $ApiUrl
  GATEWAY_TOKEN = $GatewayToken
  BRIDGE_AUTH_TOKEN = $BridgeAuthToken
  HOST_DEVICE_ID = $HostDeviceId
  BRIDGE_PORT = $BridgePort
  PORT = $BridgePort
  GATEWAY_PORT = $GatewayPort
  OPENCLAW_GATEWAY_URL = "http://127.0.0.1:$GatewayPort"
  PUBLIC_BRIDGE_URL = $env:PUBLIC_BRIDGE_URL
  PUBLIC_GATEWAY_URL = $env:PUBLIC_GATEWAY_URL
  TUNNEL_ID = $env:TUNNEL_ID
  TUNNEL_PROVIDER = $(if ($env:TUNNEL_PROVIDER) { $env:TUNNEL_PROVIDER } else { "cloudflare" })
  BROWSER_MODE = $(if ($env:BROWSER_MODE) { $env:BROWSER_MODE } else { "managed" })
  TROOPER_LOCAL_HOST = "1"
  TROOPER_LOCAL_WINDOWS_HOST = "1"
  TROOPER_BRIDGE_DIR = $BridgeDir
  TROOPER_HOME = $TrooperHome
  TROOPER_ALLOW_EXISTING_BROWSER = $(if ($env:TROOPER_ALLOW_EXISTING_BROWSER) { $env:TROOPER_ALLOW_EXISTING_BROWSER } else { "0" })
  TROOPER_WINDOWS_SCREEN_CAPTURE = "1"
  TROOPER_WINDOWS_NOTIFICATIONS = "1"
}

$LoadEnv = @'
$EnvFile = Join-Path $env:LOCALAPPDATA "Trooper\runtime\trooper-local-host.env"
Get-Content $EnvFile | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process") }
}
'@

[IO.File]::WriteAllText((Join-Path $BinDir "start-bridge.ps1"), @"
$LoadEnv
Set-Location `$env:TROOPER_BRIDGE_DIR
node index.mjs *>> `"$LogDir\bridge.log`"
"@)

[IO.File]::WriteAllText((Join-Path $BinDir "start-gateway.ps1"), @"
$LoadEnv
openclaw gateway install *>> `"$LogDir\gateway-install.log`"
openclaw gateway status --json *>> `"$LogDir\gateway-status.log`"
"@)

[IO.File]::WriteAllText((Join-Path $BinDir "start-tunnel.ps1"), @"
$LoadEnv
cloudflared tunnel --url http://127.0.0.1:`$env:BRIDGE_PORT --no-autoupdate *>> `"$LogDir\tunnel.log`"
"@)

[IO.File]::WriteAllText((Join-Path $BinDir "heartbeat.ps1"), @"
$LoadEnv
while (`$true) {
  try {
    `$Health = Invoke-RestMethod -Uri "http://127.0.0.1:`$env:BRIDGE_PORT/health" -TimeoutSec 5
  } catch { `$Health = @{} }
  `$TunnelLog = if (Test-Path "$LogDir\tunnel.log") { Get-Content "$LogDir\tunnel.log" -Raw } else { "" }
  `$Match = [regex]::Match(`$TunnelLog, 'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
  `$PublicBridgeUrl = if (`$env:PUBLIC_BRIDGE_URL) { `$env:PUBLIC_BRIDGE_URL } elseif (`$Match.Success) { `$Match.Value } else { "" }
  `$Body = @{
    token = `$env:BRIDGE_AUTH_TOKEN; hostDeviceId = `$env:HOST_DEVICE_ID; platform = "Windows"
    bridgeUrl = `$PublicBridgeUrl; gatewayUrl = `$env:PUBLIC_GATEWAY_URL; tunnelId = `$env:TUNNEL_ID
    tunnelProvider = `$env:TUNNEL_PROVIDER; status = `$(if (`$Health.status -eq "ok") { "ready" } else { "local_pending" })
    health = `$Health; browserModes = @{ default = `$env:BROWSER_MODE; managed = `$true; existingOsBrowser = `$true; vpsDesktop = `$false }
    permissions = @{ screenRecording = `$true; notifications = `$true; existingBrowser = (`$env:TROOPER_ALLOW_EXISTING_BROWSER -eq "1") }
  } | ConvertTo-Json -Depth 12
  try { Invoke-RestMethod -Method Post -ContentType "application/json" -Uri "`$env:API_URL/api/organizations/`$env:ORG_ID/local-host/heartbeat" -Body `$Body | Out-Null } catch {}
  if (`$PublicBridgeUrl) {
    try { Invoke-RestMethod -Method Post -ContentType "application/json" -Uri "`$env:API_URL/api/organizations/`$env:ORG_ID/local-host/complete" -Body `$Body | Out-Null } catch {}
  }
  Start-Sleep -Seconds 30
}
"@)

Register-TrooperTask "Trooper Local Gateway" (Join-Path $BinDir "start-gateway.ps1")
Register-TrooperTask "Trooper Local Bridge" (Join-Path $BinDir "start-bridge.ps1")
Register-TrooperTask "Trooper Local Tunnel" (Join-Path $BinDir "start-tunnel.ps1")
Register-TrooperTask "Trooper Local Heartbeat" (Join-Path $BinDir "heartbeat.ps1")

Write-Host ""
Write-Host "Trooper Local Windows Host installed." -ForegroundColor Green
Write-Host "Host device: $HostDeviceId"
Write-Host "Runtime directory: $TrooperHome"
Write-Host "Bridge: http://127.0.0.1:$BridgePort"
Write-Host "Gateway: http://127.0.0.1:$GatewayPort"
Write-Host "Trooper will mark the workspace ready after the secure tunnel becomes reachable."
