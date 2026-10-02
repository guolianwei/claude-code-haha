import { spawn } from 'node:child_process'
import path from 'node:path'
import { SAKURA_DISCOVERY_FUNCTIONS } from './proxyDiscoveryScript'
import { RELAY_RECOVERY_FUNCTIONS } from './relayRecoveryScript'

/** Commands are fixed source. Profile values are JSON on stdin, never PowerShell source. */
export const NETWORK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
function VpnArgs { $v = @{Name=[string]$p.name; ErrorAction='Stop'}; if ($p.scope -eq 'allUsers') {$v.AllUserConnection=$true}; return $v }
${SAKURA_DISCOVERY_FUNCTIONS}
${RELAY_RECOVERY_FUNCTIONS}
switch ($p.action) {
  'relayInspect' { Inspect-Relay | ConvertTo-Json -Depth 8 -Compress }
  'relayTaskCreate' { Create-RelayTask | ConvertTo-Json -Depth 4 -Compress }
  'relayTaskRemove' { Remove-RelayTask }
  'copyAcl' { Get-Acl -LiteralPath $p.source -ErrorAction Stop | Set-Acl -LiteralPath $p.target -ErrorAction Stop }
  'proxyDiscover' { Get-SakuraProcesses | ConvertTo-Json -Depth 6 -Compress }
  'proxyController' {
    $state = Get-SakuraProcesses
    $matches = @($state.cores | Where-Object {
      $_.configPath -and [string]::Equals($_.configPath, [IO.Path]::GetFullPath([string]$p.configPath), [StringComparison]::OrdinalIgnoreCase)
    })
    if ($p.proxyPort) { $matches = @($matches | Where-Object { [int]$p.proxyPort -in $_.listeningPorts }) }
    if ($matches.Count -gt 1) { throw 'Ambiguous controller for config path' }
    # Do not use an unrelated YAML/controller when a known Sakura core is running.
    if ($state.cores.Count -gt 0 -and $matches.Count -eq 0) { throw 'Running config binding not confirmed' }
    $match = if ($matches.Count -eq 1) { $matches[0] } else { $null }
    if ($match -and $match.authOverride) { throw 'Controller authentication override requires manual review' }
    [pscustomobject]@{
      controller=$(if ($match -and $match.controller) { $match.controller } else { $null })
      instanceId=$(if ($match) { [string]$match.pid + ':' + $match.startedAt } else { '' })
      listeningPorts=$(if ($match) { @($match.listeningPorts) } else { @() })
    } | ConvertTo-Json -Depth 4 -Compress
  }
  'snapshot' {
    $issues = [Collections.Generic.List[string]]::new()
    function Read-Part([string]$name, [scriptblock]$body) { try { & $body } catch { $issues.Add($name + ': unavailable or insufficient permission') } }
    $interfaces = @(Read-Part 'interfaces' { Get-NetIPInterface -AddressFamily IPv4 | Select-Object InterfaceAlias,InterfaceIndex,ConnectionState,InterfaceMetric })
    $addresses = @(Read-Part 'addresses' { Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,InterfaceIndex,IPAddress,PrefixLength })
    $adapters = @(Read-Part 'adapters' { Get-NetAdapter -Physical | Select-Object InterfaceIndex,InterfaceGuid,Name,Status })
    $routes = @()
    foreach ($store in @('ActiveStore','PersistentStore')) {
      $routes += @(Read-Part ('routes/' + $store) { Get-NetRoute -AddressFamily IPv4 -PolicyStore $store | ForEach-Object { [pscustomobject]@{prefix=$_.DestinationPrefix; nextHop=$_.NextHop; interfaceIndex=$_.InterfaceIndex; interfaceAlias=$_.InterfaceAlias; metric=$_.RouteMetric; store=$store} } })
    }
    $vpns = @()
    foreach ($all in @($false,$true)) {
      $vpns += @(Read-Part ('vpn/' + $all) {
        $profiles = if ($all) { Get-VpnConnection -AllUserConnection } else { Get-VpnConnection }
        foreach ($vpn in $profiles) { [pscustomobject]@{name=$vpn.Name;serverAddress=[string]$vpn.ServerAddress;scope=$(if($all){'allUsers'}else{'currentUser'});connected=([string]$vpn.ConnectionStatus -eq 'Connected');splitTunneling=[bool]$vpn.SplitTunneling;routes=@($vpn.Routes | ForEach-Object { [pscustomobject]@{prefix=$_.DestinationPrefix;metric=$_.RouteMetric} })} }
      })
    }
    $selected = @(foreach ($target in $p.targets) {
      Read-Part ('selected/' + $target) {
        $found = @(Find-NetRoute -RemoteIPAddress $target)
        $ip = $found | Where-Object { $_.PSObject.Properties.Name -contains 'IPAddress' } | Select-Object -First 1
        $route = $found | Where-Object { $_.PSObject.Properties.Name -contains 'DestinationPrefix' } | Select-Object -First 1
        [pscustomobject]@{target=$target;source=$ip.IPAddress;interfaceIndex=$route.InterfaceIndex;interfaceAlias=$route.InterfaceAlias;prefix=$route.DestinationPrefix;nextHop=$route.NextHop}
      }
    })
    $service=$null; $serviceStatus='unknown'
    try {
      $services=@(Get-CimInstance Win32_Service -OperationTimeoutSec 5 -ErrorAction Stop | Where-Object { $_.Name -eq [string]$p.service })
      $serviceStatus=if($services.Count -eq 0){'missing'}else{'present'}
      if ($services.Count -eq 1) { $service=[pscustomobject]@{Name=$services[0].Name;status=[string]$services[0].State;startType=$(switch([string]$services[0].StartMode){'Auto'{'Automatic'} 'Manual'{'Manual'} 'Disabled'{'Disabled'} default{[string]$services[0].StartMode}})} }
      elseif ($services.Count -gt 1) { throw 'ambiguous service' }
    } catch { $serviceStatus='unknown'; $issues.Add('tunnelService: unavailable or insufficient permission') }
    $task=$null; $taskStatus='unknown'
    try {
      $tasks=@(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -eq [string]$p.task })
      $taskStatus=if($tasks.Count -eq 0){'missing'}else{'present'}
      if ($tasks.Count -eq 1) { $task=$tasks[0] | Select-Object TaskName,@{n='state';e={[string]$_.State}},@{n='enabled';e={[bool]$_.Settings.Enabled}} }
      elseif ($tasks.Count -gt 1) { throw 'ambiguous task' }
    } catch { $taskStatus='unknown'; $issues.Add('relayTask: unavailable or insufficient permission') }
    $handshakes = @(Read-Part 'handshake' {
      $wg = Join-Path $env:ProgramFiles 'WireGuard\wg.exe'
      if (Test-Path -LiteralPath $wg) {
        $lines = @(& $wg show $p.tunnel latest-handshakes 2>$null)
        if ($LASTEXITCODE -ne 0) { throw 'unavailable' }
        foreach ($line in $lines) { $parts = $line -split '\s+'; if ($parts.Length -eq 2) { [long]$parts[1] } }
      }
    })
    $receivedBytes=$null; $sentBytes=$null
    try {
      $wg=Join-Path $env:ProgramFiles 'WireGuard\wg.exe'
      if (-not (Test-Path -LiteralPath $wg)) { throw 'WireGuard unavailable' }
      $transferLines=@(& $wg show $p.tunnel transfer 2>$null)
      if ($LASTEXITCODE -ne 0) { throw 'unavailable' }
      $receivedBytes=0L; $sentBytes=0L
      foreach($line in $transferLines) { $parts=$line -split '\s+'; if($parts.Length -ne 3){throw 'invalid transfer'}; $receivedBytes += [long]$parts[1]; $sentBytes += [long]$parts[2] }
    } catch { $receivedBytes=$null; $sentBytes=$null; $issues.Add('transfer: unavailable or insufficient permission') }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $admin = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    [pscustomobject]@{interfaces=$interfaces;addresses=$addresses;adapters=$adapters;routes=$routes;vpns=$vpns;selected=$selected;service=$service;serviceStatus=$serviceStatus;task=$task;taskStatus=$taskStatus;handshakes=$handshakes;receivedBytes=$receivedBytes;sentBytes=$sentBytes;admin=$admin;issues=@($issues.ToArray())} | ConvertTo-Json -Depth 10 -Compress
  }
  'split' { $args = VpnArgs; Set-VpnConnection @args -SplitTunneling ([bool]$p.enabled) | Out-Null }
  'vpnRouteAdd' { $args = @{ConnectionName=[string]$p.name;DestinationPrefix=[string]$p.prefix;RouteMetric=[int]$p.metric;ErrorAction='Stop'}; if ($p.scope -eq 'allUsers') {$args.AllUserConnection=$true}; Add-VpnConnectionRoute @args | Out-Null }
  'vpnRouteRemove' { $args = @{ConnectionName=[string]$p.name;DestinationPrefix=[string]$p.prefix;Confirm=$false;ErrorAction='Stop'}; if ($p.scope -eq 'allUsers') {$args.AllUserConnection=$true}; Remove-VpnConnectionRoute @args | Out-Null }
  'routeAdd' { New-NetRoute -DestinationPrefix $p.prefix -InterfaceIndex ([int]$p.interfaceIndex) -NextHop $p.nextHop -RouteMetric ([int]$p.metric) -PolicyStore $p.store -ErrorAction Stop | Out-Null }
  'routeRemove' {
    $matches = @(Get-NetRoute -DestinationPrefix $p.prefix -InterfaceIndex ([int]$p.interfaceIndex) -NextHop $p.nextHop -PolicyStore $p.store -ErrorAction Stop | Where-Object RouteMetric -eq ([int]$p.metric))
    if ($matches.Count -ne 1) { throw 'Route removal requires one exact match' }
    $matches[0] | Remove-NetRoute -Confirm:$false -ErrorAction Stop
  }
  'service' { if ($p.running) { Start-Service -Name $p.name -ErrorAction Stop } else { Stop-Service -Name $p.name -ErrorAction Stop } }
  'serviceStartup' { Set-Service -Name $p.name -StartupType $p.startType -ErrorAction Stop }
  'task' {
    if ($p.PSObject.Properties.Name -contains 'expectedTaskFingerprint') {
      $owned=Confirm-RelayTaskFingerprint ([string]$p.name) ([string]$p.expectedTaskFingerprint)
      if ($p.running) { $owned | Start-ScheduledTask -ErrorAction Stop } else { $owned | Stop-ScheduledTask -ErrorAction Stop }
    } else {
      if ($p.running) { Start-ScheduledTask -TaskName $p.name -TaskPath '\' -ErrorAction Stop } else { Stop-ScheduledTask -TaskName $p.name -TaskPath '\' -ErrorAction Stop }
    }
  }
  'taskEnabled' {
    if ($p.PSObject.Properties.Name -contains 'expectedTaskFingerprint') {
      $owned=Confirm-RelayTaskFingerprint ([string]$p.name) ([string]$p.expectedTaskFingerprint)
      if ($p.enabled) { $owned | Enable-ScheduledTask -ErrorAction Stop | Out-Null } else { $owned | Disable-ScheduledTask -ErrorAction Stop | Out-Null }
    } else {
      if ($p.enabled) { Enable-ScheduledTask -TaskName $p.name -TaskPath '\' -ErrorAction Stop | Out-Null } else { Disable-ScheduledTask -TaskName $p.name -TaskPath '\' -ErrorAction Stop | Out-Null }
    }
  }
  default { throw 'Unsupported network operation' }
}
`

export type NetworkCommand = { action: string; [key: string]: unknown }
export type NetworkRunner = (command: NetworkCommand) => Promise<unknown>

// Only this fixed bootstrap is put on the Windows command line (32,767-character limit).
// The first stdin line is always our constant source; all profile values follow as JSON.
export const NETWORK_BOOTSTRAP = String.raw`[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))
& ([ScriptBlock]::Create($source))`

export const runNetworkPowerShell: NetworkRunner = command => new Promise((resolve, reject) => {
  if (process.platform !== 'win32') return reject(new Error('WINDOWS_REQUIRED'))
  const environment = { ...process.env }
  // A parent PowerShell 7 module path can break the Windows PowerShell 5 inbox
  // NetTCPIP/Security modules. Load only trusted Windows inbox modules here.
  for (const key of Object.keys(environment)) if (key.toLowerCase() === 'psmodulepath') delete environment[key]
  const shellDirectory = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')
  environment.PSModulePath = path.join(shellDirectory, 'Modules')
  const child = spawn(path.join(shellDirectory, 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(NETWORK_BOOTSTRAP, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: environment,
  })
  let output = ''
  let settled = false
  const finish = (error?: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (error) reject(error)
    else { try { resolve(output.trim() ? JSON.parse(output.replace(/^\uFEFF/, '')) : null) } catch { reject(new Error('NETWORK_RESPONSE_INVALID')) } }
  }
  const timer = setTimeout(() => { child.kill(); finish(new Error('NETWORK_OPERATION_TIMEOUT')) }, 25_000)
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 2_000_000) { child.kill(); finish(new Error('NETWORK_RESPONSE_LIMIT')) } })
  // Native diagnostics may include config values. Expose a fixed failure code only.
  child.stderr.resume()
  child.on('error', () => finish(new Error('NETWORK_EXECUTOR_UNAVAILABLE')))
  child.on('close', code => finish(code === 0 ? undefined : new Error('NETWORK_OPERATION_FAILED')))
  child.stdin.on('error', () => undefined)
  child.stdin.end(Buffer.from(NETWORK_SCRIPT, 'utf8').toString('base64') + '\n' + JSON.stringify(command))
})
