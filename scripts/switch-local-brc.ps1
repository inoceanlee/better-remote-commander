#Requires -Version 7.0
[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$sourceRoot = Split-Path -Parent $PSScriptRoot
$packageVersion = (Get-Content -LiteralPath (Join-Path $sourceRoot 'packages\cli\package.json') -Raw | ConvertFrom-Json).version
$packagePath = Join-Path (Split-Path -Parent $sourceRoot) "artifacts\inoceanlee-brc-$packageVersion.tgz"
$dataRoot = Join-Path $env:LOCALAPPDATA 'BRC'
$agentLog = Join-Path $dataRoot 'logs\agent.log'
$hostKey = 'tx-air-iol.tail78c9d3.ts.net:443'
$publicUrl = 'https://tx-air-iol.tail78c9d3.ts.net'
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
  if ($relay.Count -eq 0 -and $agent.Count -eq 0) { return $null }
  if ($relay.Count -gt 1 -or $agent.Count -gt 1) {
    throw "Ambiguous legacy process state: Relay $($relay.Count), Agent $($agent.Count)."
  }
  $remainingRelay = if ($relay.Count) { $relay[0] } else { $null }
  $remainingAgent = if ($agent.Count) { $agent[0] } else { $null }
  return @{ Relay = $remainingRelay; Agent = $remainingAgent }
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
  foreach ($name in @('pnpm', 'node', 'tailscale')) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "Missing command: $name" }
  }
  $hasCli = [bool](Get-Command brc -ErrorAction SilentlyContinue)
  if ($hasCli) {
    $helpOutput = (& brc help) -join [Environment]::NewLine
    if ($LASTEXITCODE -ne 0 -or $helpOutput -notmatch 'BRC unified CLI') {
      throw 'Existing brc command does not match the expected CLI.'
    }
  }
  if ((Test-Path -LiteralPath $dataRoot) -and -not $hasCli) {
    throw 'BRC data exists but the unified CLI is missing; inspect the state before retrying.'
  }
  if (-not $hasCli) {
    if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { throw 'Missing command: tar' }
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw 'Local .tgz package missing.' }
    $raw = & tar -xOzf $packagePath package/package.json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the local package.' }
    $manifest = $raw | ConvertFrom-Json
    if ($manifest.name -ne '@inoceanlee/brc' -or $manifest.version -ne $packageVersion -or
        $manifest.bin.brc -ne 'dist/cli.js') { throw 'Unexpected package manifest.' }
  }
  $legacy = Find-LegacyProcesses
  if ($legacy) {
    if ($legacy.Relay -and -not (Get-Command 'brc-relay' -ErrorAction SilentlyContinue)) {
      throw 'Missing legacy command: brc-relay'
    }
    if ($legacy.Agent -and -not (Get-Command 'brc-agent' -ErrorAction SilentlyContinue)) {
      throw 'Missing legacy command: brc-agent'
    }
  }
  $target = Get-FunnelTarget
  if ($target -notin @('http://127.0.0.1:3000', 'http://127.0.0.1:13001')) {
    throw "Unexpected Funnel target: $target"
  }
  if ($legacy) {
    if ($target -ne 'http://127.0.0.1:3000') { throw 'Legacy processes still run but Funnel already targets the new proxy.' }
    if ($legacy.Relay) {
      $health = Invoke-RestMethod 'http://127.0.0.1:3000/health' -TimeoutSec 5
      if (-not $health.ok) { throw 'Legacy Relay is not healthy.' }
    }
  } elseif (-not $hasCli) {
    throw 'Neither the legacy processes nor the new CLI are available.'
  }
  Write-Host 'Preflight OK: existing installation and Funnel state verified.'
  return @{ Legacy = $legacy; HasCli = $hasCli; Funnel = $target }
}

try {
  $state = Preflight
  $legacy = $state.Legacy
  if (-not $Apply) {
    Write-Host 'Read-only check finished. Rerun with -Apply for the local cutover.'
    exit 0
  }
  if ($legacy) {
    Write-Host 'The old Agent/Relay will stop and the current remote connection will close.'
    Write-Host 'Keep their original terminal windows open for recovery.'
  } else {
    Write-Host 'Continuing the existing BRC installation.'
  }
  if ((Read-Host 'Type CUTOVER to confirm') -cne 'CUTOVER') { throw 'Cancelled before changes.' }

  if ($legacy) {
    if ($legacy.Agent) {
      Stop-Legacy $legacy.Agent 'Legacy Agent'
      $oldStopped = $true
    }
    if ($legacy.Relay) {
      Stop-Legacy $legacy.Relay 'Legacy Relay'
      $oldStopped = $true
    }
    Write-Host 'Remaining legacy processes stopped.'
  }

  if (-not $state.HasCli) { Run-Native pnpm @('add', '-g', $packagePath) }
  Run-Native brc @('help')
  if (-not (Test-Path -LiteralPath (Join-Path $dataRoot 'data\relay.sqlite'))) {
    Write-Host 'Create the new administrator (password input remains local).'
  }
  Run-Native brc @('setup')
  Run-Native brc @('config', 'set', 'services.publicUrl', $publicUrl)

  $status = (& brc status) -join [Environment]::NewLine
  $allRunning = $status -match '(?m)^relay:\s+running' -and
    $status -match '(?m)^traefik:\s+running' -and $status -match '(?m)^agent:\s+running'
  if (-not $allRunning) {
    Write-Host 'Starting the remaining BRC services.'
    Run-Native brc @('start')
    $status = (& brc status) -join [Environment]::NewLine
  }
  if (-not (Test-LocalProxy)) { throw 'New Relay/Traefik did not become available.' }

  if ($status -match '(?m)^agent:\s+pairing') {
    $code = $null
    for ($i = 0; $i -lt 15; $i++) {
      if (Test-Path -LiteralPath $agentLog) {
        $logText = (Get-Content -LiteralPath $agentLog -Tail 90 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
        $matches = [regex]::Matches($logText, 'code:\s+([A-Z0-9-]+)')
        if ($matches.Count) { $code = $matches[$matches.Count - 1].Groups[1].Value; break }
      }
      Start-Sleep -Seconds 1
    }
    Write-Host 'Open http://127.0.0.1:13001/device/verify in the local browser.'
    Write-Host 'Log in as the new administrator and approve the Agent.'
    if ($code) { Write-Host "Pairing code: $code" }
    else { Write-Host 'Read the pairing code with: brc logs agent' }
    $null = Read-Host 'After approving the pairing request, press Enter'
    for ($i = 0; $i -lt 30; $i++) {
      $status = (& brc status) -join [Environment]::NewLine
      if ($status -match '(?m)^agent:\s+running') { break }
      Start-Sleep -Seconds 1
    }
  }
  if ($status -notmatch '(?m)^relay:\s+running' -or
      $status -notmatch '(?m)^traefik:\s+running' -or
      $status -notmatch '(?m)^agent:\s+running') {
    throw "New services are not all healthy: $status"
  }

  if ($state.Funnel -ne 'http://127.0.0.1:13001') {
    Run-Native tailscale @('funnel', '--bg', '--yes', '--https=443', '13001')
  }
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
}
