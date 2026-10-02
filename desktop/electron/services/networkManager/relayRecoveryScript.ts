/** Fixed, allowlisted task recovery. No downloaded binaries, task XML or arbitrary arguments. */
export const RELAY_RECOVERY_FUNCTIONS = String.raw`
function Relay-Path([string]$value) {
  if ($value -notmatch '^[a-zA-Z]:[\\/]' -or $value -match '[\x00-\x1f"<>|*?]' -or $value.Substring(2).Contains(':') -or $value -notmatch '(?i)\.exe$') { throw 'RELAY_PATH_INVALID' }
  foreach ($segment in ($value -split '[\\/]')) { if ($segment -in @('.','..') -or $segment -match '[. ]$') { throw 'RELAY_PATH_INVALID' } }
  return [IO.Path]::GetFullPath($value)
}
function Relay-EqualPath([string]$left, [string]$right) {
  try { return [string]::Equals((Relay-Path $left), (Relay-Path $right), [StringComparison]::OrdinalIgnoreCase) } catch { return $false }
}
function Relay-HashText([string]$text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-','') } finally { $sha.Dispose() }
}
function Relay-TaskFingerprint([string]$definition) {
  $document=[xml]$definition
  $namespaces=[Xml.XmlNamespaceManager]::new($document.NameTable)
  $namespaces.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
  # Enable/disable is an authorized mode transition; all other definition fields remain owned.
  $enabled=$document.SelectSingleNode('/t:Task/t:Settings/t:Enabled',$namespaces)
  if($enabled){$enabled.ParentNode.RemoveChild($enabled) | Out-Null}
  return Relay-HashText $document.OuterXml
}
function Confirm-RelayTaskFingerprint([string]$name, [string]$expected) {
  if($expected -notmatch '^[A-Fa-f0-9]{64}$'){throw 'RELAY_TASK_IDENTITY_REQUIRED'}
  $matches=@(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { [string]::Equals($_.TaskName,$name,[StringComparison]::OrdinalIgnoreCase) })
  if($matches.Count -ne 1){throw 'RELAY_TASK_CHANGED_OR_UNAVAILABLE'}
  $definition=[string](Export-ScheduledTask -TaskName $matches[0].TaskName -TaskPath '\' -ErrorAction Stop)
  if((Relay-TaskFingerprint $definition) -ne $expected){throw 'RELAY_TASK_CHANGED_OR_UNAVAILABLE'}
  return $matches[0]
}
function Relay-SecureAcl([string]$file) {
  $trusted = @('S-1-5-18','S-1-5-32-544')
  $writeMask = [long]([Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)
  $paths = @($file, [IO.Path]::GetDirectoryName($file))
  foreach ($entry in $paths) {
    $acl = Get-Acl -LiteralPath $entry -ErrorAction Stop
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { return $false }
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and (([long]$rule.FileSystemRights -band $writeMask) -ne 0)) { return $false }
    }
  }
  # A junction or a writable ancestor allowing child deletion could replace a protected directory.
  $cursor = Get-Item -LiteralPath $file -Force -ErrorAction Stop
  while ($cursor) {
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    if ($cursor.PSIsContainer) {
      $ancestorAcl = Get-Acl -LiteralPath $cursor.FullName -ErrorAction Stop
      foreach ($rule in $ancestorAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and (([long]$rule.FileSystemRights -band [long]([Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)) -ne 0)) { return $false }
      }
    }
    $cursor = if ($cursor.PSIsContainer) { $cursor.Parent } else { $cursor.Directory }
  }
  return $true
}
function Read-RelayBinary {
  $result = [ordered]@{status='unknown';path=[string]$p.relayExecutable;sha256=$null;secureAcl=$null}
  try {
    if (-not $p.relayExecutable) { $result.status='missing'; return [pscustomobject]$result }
    $file = Relay-Path ([string]$p.relayExecutable)
    $result.path=$file
    # Get-Item distinguishes access failures from an absent object; Test-Path alone does not.
    try { $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { $result.status='missing'; return [pscustomobject]$result }
    if ($item.PSIsContainer) { throw 'RELAY_NOT_FILE' }
    $result.status='present'
    $result.sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash
    $result.secureAcl=Relay-SecureAcl $file
  } catch { $result.status='unknown'; $result.error='RELAY_BINARY_UNAVAILABLE' }
  return [pscustomobject]$result
}
function Read-RelayTask {
  $result = [ordered]@{status='unknown';fingerprint=$null;definitionMatches=$null;state=$null;enabled=$null}
  try {
    # Successful enumeration with no exact name is Missing; CIM/query failures remain Unknown.
    $tasks = @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { [string]::Equals($_.TaskName,[string]$p.relayTaskName,[StringComparison]::OrdinalIgnoreCase) })
    if ($tasks.Count -eq 0) { $result.status='missing'; return [pscustomobject]$result }
    if ($tasks.Count -ne 1) { throw 'RELAY_TASK_AMBIGUOUS' }
    $task = $tasks[0]
    $definition = [string](Export-ScheduledTask -TaskName $task.TaskName -TaskPath '\' -ErrorAction Stop)
    $xml = [xml]$definition
    $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
    $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    $actions = @($xml.SelectNodes('/t:Task/t:Actions/*',$ns))
    $principals = @($xml.SelectNodes('/t:Task/t:Principals/*',$ns))
    $triggers = @($xml.SelectNodes('/t:Task/t:Triggers/*',$ns))
    $settings = $xml.SelectSingleNode('/t:Task/t:Settings',$ns)
    $principalMatches = $principals.Count -eq 1 -and [string]$principals[0].UserId -in @('S-1-5-18','SYSTEM','NT AUTHORITY\SYSTEM') -and [string]$principals[0].RunLevel -eq 'HighestAvailable' -and [string]$principals[0].LogonType -in @('','ServiceAccount')
    $workingDirectory=[string]$actions[0].WorkingDirectory
    $expectedDirectory=if($p.relayExecutable){[IO.Path]::GetDirectoryName((Relay-Path ([string]$p.relayExecutable)))}else{''}
    $workingDirectoryMatches=$workingDirectory -eq '' -or [string]::Equals($workingDirectory.TrimEnd('\'),$expectedDirectory.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)
    $actionMatches = $actions.Count -eq 1 -and $actions[0].LocalName -eq 'Exec' -and (Relay-EqualPath ([string]$actions[0].Command) ([string]$p.relayExecutable)) -and [string]$actions[0].Arguments -ceq '-mode client' -and $workingDirectoryMatches
    $triggerMatches = $triggers.Count -eq 1 -and $triggers[0].LocalName -eq 'BootTrigger' -and [string]$triggers[0].Enabled -ne 'false' -and [string]$triggers[0].Delay -in @('','PT0S') -and -not $triggers[0].Repetition -and -not $triggers[0].StartBoundary -and -not $triggers[0].EndBoundary
    $settingsMatches = [string]$settings.Priority -eq '4' -and [string]$settings.ExecutionTimeLimit -eq 'PT0S' -and [string]$settings.RestartOnFailure.Interval -eq 'PT1M' -and [string]$settings.RestartOnFailure.Count -eq '999' -and [string]$settings.MultipleInstancesPolicy -eq 'IgnoreNew' -and [string]$settings.DisallowStartIfOnBatteries -eq 'false' -and [string]$settings.StopIfGoingOnBatteries -eq 'false' -and [string]$settings.StartWhenAvailable -eq 'true' -and [string]$settings.RunOnlyIfNetworkAvailable -ne 'true' -and [string]$settings.RunOnlyIfIdle -ne 'true'
    $result.status='present'; $result.fingerprint=Relay-TaskFingerprint $definition
    $result.definitionMatches=[bool]($principalMatches -and $actionMatches -and $triggerMatches -and $settingsMatches)
    $result.state=[string]$task.State; $result.enabled=[bool]$task.Settings.Enabled
  } catch { $result.error='RELAY_TASK_UNAVAILABLE' }
  return [pscustomobject]$result
}
function Read-RelayRuntime {
  $udp=[ordered]@{status='unknown'}; $tcp=[ordered]@{status='unknown'}
  try {
    $listeners = @(Get-CimInstance -Namespace 'root/StandardCimv2' -ClassName MSFT_NetUDPEndpoint -Filter ('LocalPort=' + [int]$p.relayLocalPort) -OperationTimeoutSec 5 -ErrorAction Stop)
    if ($listeners.Count -eq 0) { $udp.status='missing'; $tcp.status='missing' }
    elseif ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') { $udp.status='conflict'; $tcp.status='missing' }
    else {
      $ownerId=[int]$listeners[0].OwningProcess
      $proc=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ownerId) -OperationTimeoutSec 5 -ErrorAction Stop
      if (-not $proc -or -not $proc.ExecutablePath) { throw 'RELAY_PROCESS_UNAVAILABLE' }
      if (-not (Relay-EqualPath ([string]$proc.ExecutablePath) ([string]$p.relayExecutable))) { $udp.status='conflict'; $udp.pid=$ownerId; $tcp.status='missing' }
      else {
        $priority=[string](Get-Process -Id $ownerId -ErrorAction Stop).PriorityClass
        $udp.status='ready'; $udp.pid=$ownerId; $udp.executablePath=Relay-Path ([string]$proc.ExecutablePath); $udp.processPriority=$priority
        try {
          $connections=@(Get-CimInstance -Namespace 'root/StandardCimv2' -ClassName MSFT_NetTCPConnection -Filter ('OwningProcess=' + $ownerId + ' AND State=5') -OperationTimeoutSec 5 -ErrorAction Stop | Where-Object { $_.RemoteAddress -eq [string]$p.gatewayAddress -and $_.RemotePort -eq [int]$p.relayPort })
          $again=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ownerId) -OperationTimeoutSec 5 -ErrorAction Stop
          if (-not $again -or $again.CreationDate -ne $proc.CreationDate -or -not (Relay-EqualPath ([string]$again.ExecutablePath) ([string]$p.relayExecutable))) { throw 'RELAY_PROCESS_CHANGED' }
          if ($connections.Count -gt 0) { $tcp.status='ready'; $tcp.pid=$ownerId; $tcp.localAddress=[string]$connections[0].LocalAddress; $tcp.remoteAddress=[string]$connections[0].RemoteAddress; $tcp.remotePort=[int]$connections[0].RemotePort } else { $tcp.status='missing' }
        } catch { $tcp.status='unknown'; $tcp.error='RELAY_TCP_UNAVAILABLE' }
      }
    }
  } catch { $udp.status='unknown'; $udp.error='RELAY_UDP_UNAVAILABLE' }
  return [pscustomobject]@{udp=[pscustomobject]$udp;tcp=[pscustomobject]$tcp}
}
function Inspect-Relay {
  $binary=Read-RelayBinary; $task=Read-RelayTask; $runtime=Read-RelayRuntime
  $issues=[Collections.Generic.List[string]]::new()
  if ($binary.status -eq 'unknown') { $issues.Add('RELAY_BINARY_UNAVAILABLE') }
  elseif ($binary.status -eq 'missing') { $issues.Add('RELAY_BINARY_MISSING') }
  elseif (-not $binary.secureAcl) { $issues.Add('RELAY_BINARY_ACL_UNSAFE') }
  if ($task.status -eq 'unknown') { $issues.Add('RELAY_TASK_UNAVAILABLE') }
  elseif ($task.status -eq 'missing') { $issues.Add('RELAY_TASK_MISSING') }
  elseif (-not $task.definitionMatches) { $issues.Add('RELAY_TASK_DEFINITION_MISMATCH') }
  if ($runtime.udp.status -ne 'ready') { $issues.Add('RELAY_NOT_READY') }
  elseif ($runtime.udp.processPriority -ne 'Normal') { $issues.Add('RELAY_PRIORITY_NOT_NORMAL') }
  if ($runtime.tcp.status -ne 'ready') { $issues.Add('RELAY_TCP_NOT_CONNECTED') }
  return [pscustomobject]@{checkedAt=[DateTime]::UtcNow.ToString('o');binary=$binary;task=$task;udp=$runtime.udp;tcp=$runtime.tcp;issues=@($issues.ToArray())}
}
function Create-RelayTask {
  if ([string]$p.expectedBinaryHash -notmatch '^[A-Fa-f0-9]{64}$') { throw 'RELAY_BINARY_IDENTITY_REQUIRED' }
  $binary=Read-RelayBinary
  if ($binary.status -ne 'present' -or -not $binary.secureAcl -or $binary.sha256 -ne [string]$p.expectedBinaryHash) { throw 'RELAY_BINARY_CHANGED_OR_UNSAFE' }
  $current=Read-RelayTask
  if ($current.status -ne 'missing') { throw 'RELAY_TASK_MUST_BE_MISSING' }
  $action=New-ScheduledTaskAction -Execute $binary.path -Argument '-mode client' -WorkingDirectory ([IO.Path]::GetDirectoryName($binary.path))
  $trigger=New-ScheduledTaskTrigger -AtStartup
  $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $settings.Priority=4
  $definition=New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
  # Recheck after construction. Register has no Force, so a concurrent creator cannot be overwritten.
  $again=Read-RelayBinary; $taskAgain=Read-RelayTask
  if ($again.status -ne 'present' -or -not $again.secureAcl -or $again.path -ne $binary.path -or $again.sha256 -ne $binary.sha256 -or $taskAgain.status -ne 'missing') { throw 'RELAY_CREATE_STATE_CHANGED' }
  Register-ScheduledTask -TaskName ([string]$p.relayTaskName) -TaskPath '\' -InputObject $definition -ErrorAction Stop | Out-Null
  $created=Read-RelayTask
  if ($created.status -ne 'present' -or -not $created.definitionMatches) { throw 'RELAY_CREATED_TASK_UNCONFIRMED' }
  return [pscustomobject]@{taskFingerprint=$created.fingerprint}
}
function Remove-RelayTask {
  if ([string]$p.expectedTaskFingerprint -notmatch '^[A-Fa-f0-9]{64}$') { throw 'RELAY_TASK_IDENTITY_REQUIRED' }
  $task=Read-RelayTask
  if ($task.status -ne 'present' -or -not $task.definitionMatches -or $task.fingerprint -ne [string]$p.expectedTaskFingerprint) { throw 'RELAY_TASK_CHANGED_OR_UNAVAILABLE' }
  # Stop only this owned task, then check its definition again before deleting it.
  Stop-ScheduledTask -TaskName ([string]$p.relayTaskName) -TaskPath '\' -ErrorAction Stop
  $again=Read-RelayTask
  if ($again.status -ne 'present' -or -not $again.definitionMatches -or $again.fingerprint -ne $task.fingerprint) { throw 'RELAY_TASK_CHANGED_OR_UNAVAILABLE' }
  Unregister-ScheduledTask -TaskName ([string]$p.relayTaskName) -TaskPath '\' -Confirm:$false -ErrorAction Stop
}
`
