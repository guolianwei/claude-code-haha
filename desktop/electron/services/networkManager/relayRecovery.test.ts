import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { createRelayRecovery, type RelayRecoveryProfile } from './relayRecovery'
import { NETWORK_BOOTSTRAP, NETWORK_SCRIPT } from './powershell'
import { RELAY_RECOVERY_FUNCTIONS } from './relayRecoveryScript'

const profile: RelayRecoveryProfile = {
  relayExecutable: 'C:\\ProgramData\\WireGuard\\fixture\\wg-relay.exe', relayLocalPort: 51824,
  gatewayAddress: '191.168.7.62', relayPort: 51826, relayTaskName: 'Fixture Relay', tunnelName: 'fixture',
}
const sha = 'A'.repeat(64)
const taskSha = 'B'.repeat(64)
const inspection = {
  checkedAt: '2026-10-02T01:00:00Z', binary: { status: 'present', path: profile.relayExecutable, sha256: sha, secureAcl: true },
  task: { status: 'missing', fingerprint: null, definitionMatches: null, state: null, enabled: null },
  udp: { status: 'missing' }, tcp: { status: 'missing' }, issues: ['RELAY_TASK_MISSING', 'RELAY_NOT_READY'],
}

describe('relay recovery adapter', () => {
  it('passes only the fixed command and validated flat profile fields', async () => {
    const runner = vi.fn().mockResolvedValue(inspection)
    expect(await createRelayRecovery(runner).inspect({ ...profile, arbitraryScript: 'ignored' } as RelayRecoveryProfile)).toEqual(inspection)
    expect(runner).toHaveBeenCalledWith({ action: 'relayInspect', ...profile })
  })

  it.each(['..\\relay.exe', 'C:\\safe\\..\\wg-relay.exe', '\\\\server\\share\\wg-relay.exe', 'C:\\relay.exe:stream.exe', 'C:\\relay.exe -mode server', 'C:\\bad.\\relay.exe'])('rejects non-canonical executable %s before native execution', async relayExecutable => {
    const runner = vi.fn()
    await expect(createRelayRecovery(runner).inspect({ ...profile, relayExecutable })).rejects.toThrow('RELAY_PROFILE_INVALID')
    expect(runner).not.toHaveBeenCalled()
  })

  it('requires previewed binary and exact rollback task identities', async () => {
    const runner = vi.fn().mockResolvedValue({ taskFingerprint: taskSha })
    const recovery = createRelayRecovery(runner)
    await expect(recovery.create(profile, 'unknown')).rejects.toThrow('RELAY_BINARY_IDENTITY_REQUIRED')
    await expect(recovery.remove(profile, '')).rejects.toThrow('RELAY_TASK_IDENTITY_REQUIRED')
    expect(runner).not.toHaveBeenCalled()
    expect(await recovery.create(profile, sha.toLowerCase())).toEqual({ taskFingerprint: taskSha })
    expect(runner).toHaveBeenLastCalledWith({ action: 'relayTaskCreate', ...profile, expectedBinaryHash: sha })
    await recovery.remove(profile, taskSha.toLowerCase())
    expect(runner).toHaveBeenLastCalledWith({ action: 'relayTaskRemove', ...profile, expectedTaskFingerprint: taskSha })
  })

  it('keeps failed collection unknown and rejects malformed native output', async () => {
    const unknown = { ...inspection, task: { ...inspection.task, status: 'unknown', error: 'RELAY_TASK_UNAVAILABLE' } }
    const runner = vi.fn().mockResolvedValueOnce(unknown).mockResolvedValueOnce({ task: null })
    expect((await createRelayRecovery(runner).inspect(profile)).task.status).toBe('unknown')
    await expect(createRelayRecovery(runner).inspect(profile)).rejects.toThrow('RELAY_INSPECTION_INVALID')
  })
})

// Each case starts several separately bounded PowerShell processes; cold inbox modules
// under the full Electron lane need more than Vitest's default five-second case budget.
const windowsIt = (name: string, body: () => void) => (process.platform === 'win32' ? it : it.skip)(name, async () => {
  // Flush worker IPC between process-heavy fixtures instead of starving report updates.
  await new Promise(resolve => setTimeout(resolve, 0))
  body()
  await new Promise(resolve => setTimeout(resolve, 0))
}, 30_000)
function nativeFixture(body: string, fixture: Record<string, unknown> = {}, production = false) {
  const source = production ? NETWORK_SCRIPT.replace('switch ($p.action) {', `${body}\nswitch ($p.action) {`) : `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=[Console]::In.ReadToEnd() | ConvertFrom-Json
${RELAY_RECOVERY_FUNCTIONS}
${body}`
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(NETWORK_BOOTSTRAP, 'utf16le').toString('base64')], {
    input: Buffer.from(source).toString('base64') + '\n' + JSON.stringify({ ...profile, expectedBinaryHash: sha, expectedTaskFingerprint: taskSha, ...fixture }),
    encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false,
  })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())
}

const taskXml = `<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Principals><Principal><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals><Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers><Actions><Exec><Command>${profile.relayExecutable}</Command><Arguments>-mode client</Arguments></Exec></Actions><Settings><Enabled>true</Enabled><Priority>4</Priority><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable></Settings></Task>`
const taskStubs = `function Get-ScheduledTask { if($p.failQuery){throw 'fixture denied'}; if($p.exists){[pscustomobject]@{TaskName=$p.relayTaskName;State='Running';Settings=[pscustomobject]@{Enabled=$true}}} }
function Export-ScheduledTask { return [string]$p.xml }
Read-RelayTask | ConvertTo-Json -Depth 6 -Compress`

describe('fixed native relay operations with offline fixtures', () => {
  windowsIt('transports the complete fixed production source and JSON without command-line truncation or interpolation', () => {
    const literal = "Fixture $(throw 'must not run')"
    expect(nativeFixture('function Inspect-Relay { [pscustomobject]@{name=$p.relayTaskName;port=$p.relayLocalPort} }', { action: 'relayInspect', relayTaskName: literal }, true)).toEqual({ name: literal, port: profile.relayLocalPort })
  })

  windowsIt('distinguishes absent tasks from enumeration failures', () => {
    expect(nativeFixture(taskStubs, { exists: false }).status).toBe('missing')
    expect(nativeFixture(taskStubs, { failQuery: true })).toMatchObject({ status: 'unknown', error: 'RELAY_TASK_UNAVAILABLE' })
  })

  windowsIt('keeps task and service collection failures unknown and projects VPN server identity', () => {
    const stubs = `function Get-NetIPInterface {}
function Get-NetIPAddress {}
function Get-NetAdapter {}
function Get-NetRoute {}
function Get-VpnConnection {[pscustomobject]@{Name='Renamed VPN';ServerAddress='124.114.142.77';ConnectionStatus='Connected';SplitTunneling=$false;Routes=@()}}
function Get-CimInstance {if($p.failQuery){throw 'service denied'}}
function Get-ScheduledTask {if($p.failQuery){throw 'task denied'}}
function Test-Path {return $false}`
    const absent = nativeFixture(stubs, { action: 'snapshot', targets: [], service: 'Fixture Service', task: 'Fixture Task', tunnel: 'fixture' }, true)
    expect(absent).toMatchObject({ service: null, serviceStatus: 'missing', task: null, taskStatus: 'missing' })
    expect(absent.vpns[0]).toMatchObject({ name: 'Renamed VPN', serverAddress: '124.114.142.77', splitTunneling: false })
    const unknown = nativeFixture(stubs, { action: 'snapshot', targets: [], failQuery: true }, true)
    expect(unknown).toMatchObject({ serviceStatus: 'unknown', taskStatus: 'unknown' })
    expect(unknown.issues).toContain('tunnelService: unavailable or insufficient permission')
    expect(unknown.issues).toContain('relayTask: unavailable or insufficient permission')
  })

  windowsIt('permits only SYSTEM/Admin binary-directory writers and rejects reparse paths', () => {
    const stubs = `function Get-Acl {
$acl=[Security.AccessControl.DirectorySecurity]::new()
$owner=[Security.Principal.SecurityIdentifier]::new($(if($p.foreignOwner){'S-1-5-32-545'}else{'S-1-5-18'}))
$acl.SetOwner($owner)
$sid=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
if($p.foreignWrite){$users=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545');$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,[Security.AccessControl.FileSystemRights]::Write,[Security.AccessControl.AccessControlType]::Allow))}
return $acl }
function Get-Item { [pscustomobject]@{PSIsContainer=$false;Attributes=$(if($p.reparse){[IO.FileAttributes]::ReparsePoint}else{[IO.FileAttributes]::Normal});Directory=[pscustomobject]@{PSIsContainer=$true;Attributes=[IO.FileAttributes]::Directory;FullName='C:\\fixture';Parent=$null}} }
[pscustomobject]@{secure=(Relay-SecureAcl $p.relayExecutable)} | ConvertTo-Json -Compress`
    expect(nativeFixture(stubs)).toEqual({ secure: true })
    for (const fixture of [{ foreignOwner: true }, { foreignWrite: true }, { reparse: true }]) {
      expect(nativeFixture(stubs, fixture)).toEqual({ secure: false })
    }
  })

  windowsIt('checks exact task semantics and fingerprints the full definition independently of runtime state', () => {
    const original = nativeFixture(taskStubs, { exists: true, xml: taskXml })
    expect(original).toMatchObject({ status: 'present', definitionMatches: true, state: 'Running', enabled: true })
    expect(original.fingerprint).toMatch(/^[A-F0-9]{64}$/)
    const changed = nativeFixture(taskStubs, { exists: true, xml: taskXml.replace('<Priority>4', '<Priority>7') })
    expect(changed.definitionMatches).toBe(false)
    expect(changed.fingerprint).not.toBe(original.fingerprint)
  })

  windowsIt('preserves ownership through task Enabled transitions but retains trigger and settings identity', () => {
    const body = `[pscustomobject]@{fingerprint=(Relay-TaskFingerprint $p.xml)} | ConvertTo-Json -Compress`
    const original = nativeFixture(body, { xml: taskXml }).fingerprint
    expect(nativeFixture(body, { xml: taskXml.replace('<Settings><Enabled>true', '<Settings><Enabled>false') }).fingerprint).toBe(original)
    expect(nativeFixture(body, { xml: taskXml.replace('<BootTrigger><Enabled>true', '<BootTrigger><Enabled>false') }).fingerprint).not.toBe(original)
  })

  windowsIt('guards native start/stop/enable/disable against task replacement', () => {
    const body = `function Get-ScheduledTask {[pscustomobject]@{TaskName=$p.name}}
function Export-ScheduledTask {return $p.xml}
function Start-ScheduledTask {'{"operation":"start"}'}
function Stop-ScheduledTask {'{"operation":"stop"}'}
function Enable-ScheduledTask {throw 'fixture mutation invoked'}
function Disable-ScheduledTask {throw 'fixture mutation invoked'}
$actual=Relay-TaskFingerprint $p.xml
$p.expectedTaskFingerprint=if($p.changed){'C'*64}else{$actual}
try { $owned=Confirm-RelayTaskFingerprint $p.name $p.expectedTaskFingerprint; [pscustomobject]@{allowed=$true} | ConvertTo-Json -Compress } catch { [pscustomobject]@{allowed=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress }`
    expect(nativeFixture(body, { name: profile.relayTaskName, xml: taskXml })).toEqual({ allowed: true })
    expect(nativeFixture(body, { name: profile.relayTaskName, xml: taskXml, changed: true })).toMatchObject({ allowed: false, error: 'RELAY_TASK_CHANGED_OR_UNAVAILABLE' })
    const production = `function Get-ScheduledTask {[pscustomobject]@{TaskName=$p.name}}
function Export-ScheduledTask {return $p.xml}
function Start-ScheduledTask {throw 'mutation must be blocked'}
function Stop-ScheduledTask {throw 'mutation must be blocked'}
function Enable-ScheduledTask {throw 'mutation must be blocked'}
function Disable-ScheduledTask {throw 'mutation must be blocked'}`
    // Exercise actual production branches; the guarded helper throws before the mocked mutation.
    for (const action of ['task', 'taskEnabled']) {
      const source = NETWORK_SCRIPT.replace('switch ($p.action) {', `${production}\ntry {\nswitch ($p.action) {`) + '\n} catch { [pscustomobject]@{blocked=$_.Exception.Message} | ConvertTo-Json -Compress }'
      const bootstrap = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(NETWORK_BOOTSTRAP, 'utf16le').toString('base64')], {
        input: Buffer.from(source).toString('base64') + '\n' + JSON.stringify({ action, name: profile.relayTaskName, expectedTaskFingerprint: taskSha, xml: taskXml, running: true, enabled: true }), encoding: 'utf8', timeout: 10000, windowsHide: true,
      })
      expect(bootstrap.status).toBe(0)
      expect(JSON.parse(bootstrap.stdout.trim())).toEqual({ blocked: 'RELAY_TASK_CHANGED_OR_UNAVAILABLE' })
    }
  })

  windowsIt('rejects extra actions, changed arguments and principal instead of taking over a foreign task', () => {
    for (const xml of [taskXml.replace('-mode client', '-mode server'), taskXml.replace('S-1-5-18', 'S-1-5-19'), taskXml.replace('</Actions>', '<Exec><Command>cmd.exe</Command></Exec></Actions>')]) {
      expect(nativeFixture(taskStubs, { exists: true, xml }).definitionMatches).toBe(false)
    }
  })

  windowsIt('accepts only the binary directory or legacy empty working directory', () => {
    const withDirectory = taskXml.replace('</Arguments>', '</Arguments><WorkingDirectory>C:\\ProgramData\\WireGuard\\fixture</WorkingDirectory>')
    expect(nativeFixture(taskStubs, { exists: true, xml: withDirectory }).definitionMatches).toBe(true)
    expect(nativeFixture(taskStubs, { exists: true, xml: withDirectory.replace('<WorkingDirectory>C:\\ProgramData\\WireGuard\\fixture', '<WorkingDirectory>C:\\other') }).definitionMatches).toBe(false)
  })

  const createStubs = `
$script:taskReads=0; $script:binaryReads=0; $script:registered=0
function Read-RelayBinary { $script:binaryReads++; [pscustomobject]@{status='present';path=$p.relayExecutable;secureAcl=(-not $p.unsafe);sha256=$(if($p.changed -and $script:binaryReads -gt 1){'C'*64}else{$p.expectedBinaryHash})} }
function Read-RelayTask { $script:taskReads++; [pscustomobject]@{status=$(if($p.taskStatus){$p.taskStatus}elseif($script:taskReads -le 2){'missing'}else{'present'});definitionMatches=$true;fingerprint=('B'*64)} }
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory); if($Argument -cne '-mode client' -or $WorkingDirectory -ne [IO.Path]::GetDirectoryName($p.relayExecutable)){throw 'arguments'}; [pscustomobject]@{} }
function New-ScheduledTaskTrigger { param([switch]$AtStartup); if(-not $AtStartup){throw 'trigger'}; [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel); if($UserId -ne 'SYSTEM' -or $LogonType -ne 'ServiceAccount' -or $RunLevel -ne 'Highest'){throw 'principal'}; [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable,$RestartCount,$RestartInterval,$ExecutionTimeLimit,$MultipleInstances,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries); if(-not $StartWhenAvailable -or $RestartCount -ne 999 -or $RestartInterval.TotalSeconds -ne 60 -or $ExecutionTimeLimit.TotalSeconds -ne 0 -or $MultipleInstances -ne 'IgnoreNew' -or -not $AllowStartIfOnBatteries -or -not $DontStopIfGoingOnBatteries){throw 'settings'}; [pscustomobject]@{Priority=7} }
function New-ScheduledTask { param($Action,$Trigger,$Principal,$Settings); if($Settings.Priority -ne 4){throw 'priority'}; [pscustomobject]@{} }
function Register-ScheduledTask { param($TaskName,$TaskPath,$InputObject,$ErrorAction,[switch]$Force); if($Force){throw 'forced registration'}; $script:registered++ }
$errorCode=$null; $result=$null
try {$result=Create-RelayTask} catch {$errorCode=$_.Exception.Message}
[pscustomobject]@{error=$errorCode;registered=$script:registered;result=$result} | ConvertTo-Json -Depth 5 -Compress`

  windowsIt('creates only a missing task using the fixed SYSTEM/boot/normal/restart definition', () => {
    expect(nativeFixture(createStubs)).toEqual({ error: null, registered: 1, result: { taskFingerprint: taskSha } })
  })

  windowsIt('blocks unknown/existing tasks, unsafe ACLs and binaries replaced after preview', () => {
    for (const fixture of [{ taskStatus: 'unknown' }, { taskStatus: 'present' }, { unsafe: true }, { changed: true }]) {
      const result = nativeFixture(createStubs, fixture)
      expect(result.registered).toBe(0)
      expect(result.error).toMatch(/^RELAY_/)
    }
  })

  windowsIt('never deletes an edited task and rechecks ownership after stopping an owned task', () => {
    const body = `$script:reads=0; $script:stopped=0; $script:removed=0
function Read-RelayTask {$script:reads++; [pscustomobject]@{status='present';definitionMatches=$true;fingerprint=$(if($p.changed -or ($p.afterStop -and $script:reads -gt 1)){'C'*64}else{$p.expectedTaskFingerprint})}}
function Stop-ScheduledTask {$script:stopped++}
function Unregister-ScheduledTask {$script:removed++}
$errorCode=$null;try {Remove-RelayTask} catch {$errorCode=$_.Exception.Message}
[pscustomobject]@{stopped=$script:stopped;removed=$script:removed;error=$errorCode} | ConvertTo-Json -Compress`
    expect(nativeFixture(body, { changed: true })).toMatchObject({ stopped: 0, removed: 0 })
    expect(nativeFixture(body, { afterStop: true })).toMatchObject({ stopped: 1, removed: 0 })
    expect(nativeFixture(body)).toEqual({ stopped: 1, removed: 1, error: null })
  })

  const runtimeStubs = `function Get-CimInstance { param([Parameter(Position=0)]$ClassName,$Namespace,$Filter,$OperationTimeoutSec)
if($ClassName -eq 'MSFT_NetUDPEndpoint') {if($p.listener){[pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=42}}}
elseif($ClassName -eq 'Win32_Process'){[pscustomobject]@{ExecutablePath=$(if($p.foreign){'C:\\other\\relay.exe'}else{$p.relayExecutable});CreationDate='2026-10-02T01:00:00Z'}}
elseif($ClassName -eq 'MSFT_NetTCPConnection' -and $p.connected){[pscustomobject]@{RemoteAddress=$p.gatewayAddress;RemotePort=$p.relayPort;LocalAddress='162.168.1.2'}} }
function Get-Process {[pscustomobject]@{PriorityClass=$(if($p.lowPriority){'BelowNormal'}else{'Normal'})}}
Read-RelayRuntime | ConvertTo-Json -Depth 5 -Compress`

  windowsIt('requires the expected loopback listener owner and an established outer TCP connection', () => {
    expect(nativeFixture(runtimeStubs)).toMatchObject({ udp: { status: 'missing' }, tcp: { status: 'missing' } })
    expect(nativeFixture(runtimeStubs, { listener: true, foreign: true })).toMatchObject({ udp: { status: 'conflict' }, tcp: { status: 'missing' } })
    expect(nativeFixture(runtimeStubs, { listener: true, connected: true, lowPriority: true })).toMatchObject({ udp: { status: 'ready', processPriority: 'BelowNormal' }, tcp: { status: 'ready', localAddress: '162.168.1.2', remotePort: 51826 } })
  })
})
