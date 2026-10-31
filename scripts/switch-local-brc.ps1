#Requires -Version 7.0
[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$packagePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'artifacts\inoceanlee-brc-2.1.0.tgz'
$dataRoot = Join-Path $env:LOCALAPPDATA 'BRC'
$agentLog = Join-Path $dataRoot 'logs\agent.log'
$hostKey = 'tx-air-iol.tail78c9d3.ts.net:443'
$publicUrl = 'https://tx-air-iol.tail78c9d3.ts.net'
$startJob = $null
$oldStopped = $false

function Run-Native([string]$command, [string[]]$arguments) {
  & $command @arguments
  if ($LASTEXITCODE -ne 0) { throw "$command failed with exit code $LASTEXITCODE." }
}
function Get-FunnelTarget {
  $raw = & tailscale funnel status --json
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Funnel status.' }
  $entry = ($raw | ConvertFrom-Json).Web.PSObject.Properties[$hostKey]
  if (-not $entry) { throw 'Expected Funnel host was not found.' }
  $handler = $entry.Value.Handlers.PSObject.Properties['/']
  if (-not $handler) { throw 'Expected Funnel route was not found.' }
  return [string]$handler.Value.Proxy
}
function Find-LegacyProcesses {
  $all = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and
    $_.CommandLine -match 'node_modules[/\\]brc-(relay|agent)[/\\]dist[/\\]cli\.js'
  })
  $relay = @($all | Where-Object { $_.CommandLine -match 'node_modules[/\\]brc-relay[/\\]dist[/\\]cli\.js' })
  $agent = @($all | Where-Object { $_.CommandLine -match 'node_modules[/\\]brc-agent[/\\]dist[/\\]cli\.js' })
  if ($relay.Count -ne 1 -or $agent.Count -ne 1) {
    throw "Expected one legacy Relay and one Agent; found $($relay.Count) and $($agent.Count)."
  }
  return @{ Relay = $relay[0]; Agent = $agent[0] }
}
function Stop-Legacy($snapshot, [string]$name) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($snapshot.ProcessId)"
  if (-not $current -or $current.CommandLine -ne $snapshot.CommandLine -or
      $current.CreationDate -ne $snapshot.CreationDate) {
    throw "$name process identity changed; refusing to stop."
  }
  Stop-Process -Id $current.ProcessId -ErrorAction Stop
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 150
  }
  throw "$name process did not exit."
}
function Test-LocalProxy {
  try {
    $r = Invoke-WebRequest 'http://127.0.0.1:13001/.well-known/oauth-authorization-server' -TimeoutSec 2
    return $r.StatusCode -eq 200
  } catch { return $false }
}
function Preflight {
  foreach ($name in @('pnpm', 'node', 'tar', 'tailscale', 'brc-relay', 'brc-agent')) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "Missing command: $name" }
  }
  if (Get-Command brc -ErrorAction SilentlyContinue) { throw 'brc is already installed; inspect it first.' }
  if (Test-Path -LiteralPath $dataRoot) { throw 'New BRC data root already exists; inspect it first.' }
  if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw 'Local .tgz package missing.' }
  $raw = & tar -xOzf $packagePath package/package.json
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the local package.' }
  $manifest = $raw | ConvertFrom-Json
  if ($manifest.name -ne '@inoceanlee/brc' -or $manifest.version -ne '2.1.0' -or
      $manifest.bin.brc -ne 'dist/cli.js') { throw 'Unexpected package manifest.' }
  $legacy = Find-LegacyProcesses
  $target = Get-FunnelTarget
  if ($target -ne 'http://127.0.0.1:3000') { throw "Unexpected Funnel target: $target" }
  $health = Invoke-RestMethod 'http://127.0.0.1:3000/health' -TimeoutSec 5
  if (-not $health.ok) { throw 'Legacy Relay is not healthy.' }
  Write-Host 'Preflight OK: package, old processes, Relay and Funnel.'
  return $legacy
}

try {
  $legacy = Preflight
  if (-not $Apply) {
    Write-Host 'Read-only check finished. Rerun with -Apply for the local cutover.'
    exit 0
  }
  Write-Host 'The old Agent/Relay will stop and the current remote connection will close.'
  Write-Host 'Keep their original terminal windows open for recovery.'
  if ((Read-Host 'Type CUTOVER to confirm') -cne 'CUTOVER') { throw 'Cancelled before changes.' }

  Stop-Legacy $legacy.Agent 'Legacy Agent'
  $oldStopped = $true
  Stop-Legacy $legacy.Relay 'Legacy Relay'
  Write-Host 'Old Node processes stopped.'

  Run-Native pnpm @('add', '-g', $packagePath)
  Run-Native brc @('help')
  Write-Host 'Create the new administrator (password input remains local).'
  Run-Native brc @('setup')
  Run-Native brc @('config', 'set', 'services.publicUrl', $publicUrl)

  Write-Host 'Starting Relay, Traefik and Agent; waiting for first pairing.'
  $startJob = Start-Job -ScriptBlock {
    $env:BRC_RUNTIME_STARTUP_TIMEOUT_MS = '900000'
    & brc start
    if ($LASTEXITCODE -ne 0) { throw 'brc start failed.' }
  }
  $ready = $false
  for ($i = 0; $i -lt 90; $i++) {
    if (Test-LocalProxy) { $ready = $true; break }
    if ($startJob.State -ne 'Running') { break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'New Relay/Traefik did not become available.' }

  $code = $null
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-Path -LiteralPath $agentLog) {
      $text = (Get-Content -LiteralPath $agentLog -Tail 90 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
      $matches = [regex]::Matches($text, 'code:\s+([A-Z0-9-]+)')
      if ($matches.Count) { $code = $matches[$matches.Count - 1].Groups[1].Value; break }
    }
    if ($startJob.State -ne 'Running') { break }
    Start-Sleep -Seconds 1
  }

  Write-Host 'Open http://127.0.0.1:13001/device/verify in the local browser.'
  Write-Host 'Log in as the NEW administrator and approve the new Agent.'
  if ($code) { Write-Host "Pairing code: $code" }
  else { Write-Host 'Read the pairing code with: brc logs agent' }
  $null = Read-Host 'After approving the pairing request, press Enter'

  $null = Wait-Job -Job $startJob -Timeout 90
  Receive-Job -Job $startJob -ErrorAction Stop
  if ($startJob.State -ne 'Completed') { throw 'BRC startup did not complete after pairing.' }
  $status = (& brc status) -join [Environment]::NewLine
  if ($LASTEXITCODE -ne 0 -or
      $status -notmatch '(?m)^relay:\s+running' -or
      $status -notmatch '(?m)^traefik:\s+running' -or
      $status -notmatch '(?m)^agent:\s+running') {
    throw "New services are not all healthy: $status"
  }

  Run-Native tailscale @('funnel', '--bg', '--yes', '--https=443', '13001')
  $actual = Get-FunnelTarget
  if ($actual -ne 'http://127.0.0.1:13001') { throw "Funnel target mismatch: $actual" }
  $test = Invoke-WebRequest "$publicUrl/.well-known/oauth-authorization-server" -TimeoutSec 15
  if ($test.StatusCode -ne 200) { throw 'Public OAuth discovery failed.' }

  Write-Host 'Cutover complete. Reauthorize ChatGPT OAuth/MCP for the NEW Relay.'
  Write-Host 'After reconnection, verify the new Agent and tools from ChatGPT.'
} catch {
  Write-Warning ("Cutover stopped: " + $_.Exception.Message)
  if ($oldStopped) {
    Write-Host 'RECOVERY:'
    Write-Host '1. Run brc stop if the new CLI has been installed.'
    Write-Host '2. Restart brc-relay in its ORIGINAL terminal and environment.'
    Write-Host '3. Restart brc-agent in its ORIGINAL terminal with the original arguments.'
    Write-Host '4. If Funnel moved, restore it using: tailscale funnel --bg --yes --https=443 3000'
    Write-Host '5. Check the original /health endpoint and Agent connection.'
  }
  exit 1
} finally {
  if ($startJob) {
    if ($startJob.State -eq 'Running') { Stop-Job -Job $startJob -ErrorAction SilentlyContinue }
    Remove-Job -Job $startJob -Force -ErrorAction SilentlyContinue
  }
}
