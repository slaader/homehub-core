<#
.SYNOPSIS
  Installs, updates or removes the Home Hub push agent on this Windows computer (docs/agent.md -> Windows: PowerShell
  only). Run it here, as an administrator, from a checkout of Home Hub core. Windows PowerShell 5.1.

.DESCRIPTION
    install-agent.ps1 -Hub https://hub.example.lan -KeyFile C:\path\agent-key.json [-Specs C:\path\specs.txt]
                      [-Pin <sha256> [-Pin <next>] | -Ca C:\path\hub-ca.pem] [-Yes] [-Wait 90] [-DryRun | -WhatIf] [-Once]
    install-agent.ps1 -Uninstall [-DryRun | -WhatIf]

  -KeyFile is the file `node scripts/manage-access.mjs create-agent-key --output` (or the admin page) gave for this
  device; its token goes to <Root>\private\agent.key, readable by LocalService and Administrators only, and is never
  printed (only its first 12 characters), logged, put on a command line or passed to a command as a parameter.
  -Specs is what `node scripts/agent-specs.mjs <device> --platform windows` printed on the hub: every line is shown
  and must be confirmed (or -Yes). Trust: no -Pin/-Ca is the system store with the name checked (a hub behind a proxy
  with a public certificate); -Ca a private CA's root certificate (name checked; the hub sends any intermediate);
  -Pin one or two SHA-256 fingerprints of the hub's certificate.

  What it does: checks everything first (the key file, the watch list, the configuration, the CA), then copies the agent
  (HomeHubAgent.psm1, home-hub-agent.ps1, report-rules.json, package.json) into <Root>\agent and its configuration into
  <Root>\config, each from the bytes it checked and read back, in directories whose ACL it sets first (no inheritance:
  Administrators and SYSTEM, LocalService reading; state and logs writable by LocalService, and made anew on an update,
  so that nothing LocalService left in them gets an administrator's ACL), registers the Scheduled Task
  \Home Hub\home-hub-agent to run as NT AUTHORITY\LocalService (never SYSTEM) at start-up and every hour if it is not
  running, starts it and waits for its first accepted report (status.json -> lastAcceptedAt; -Wait seconds). If none
  comes, the previous agent and configuration are put back from the backup (<ProgramData>\Home Hub Agent Backups\<stamp>,
  never the key) and waited for in the same way. status.json is written by the agent as LocalService, so another
  service running as LocalService could fake that health check: it shows that the agent works, it does not prove it.
  Run again from a newer checkout to update. -DryRun (or -WhatIf) prints the plan and writes nothing, -Once included.
  -Once runs the agent once from this checkout with the new configuration, as you and not as LocalService, prints the
  envelope and sends nothing; it writes that configuration to a temporary directory, removed afterwards.
  -Uninstall removes the task and <Root>, and only a <Root> this installer made (it holds .agent-install.json); a link
  inside it is removed as a link, never followed. Revoke the key on the hub as well.
  -Root is an absolute path, not a drive and without a trailing backslash; an existing one must be empty or hold
  .agent-install.json.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Hub,
  [string[]]$Pin = @(),
  [string]$Ca,
  [string]$KeyFile,
  [string]$Specs,
  [int]$Wait = 90,
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$Once,
  [switch]$Uninstall,
  [string]$Root = (Join-Path $env:ProgramData 'Home Hub Agent')
)
Set-StrictMode -Version 2.0
# First, before any .NET type: the agent and this installer need full language mode (AppLocker or WDAC would run them
# in a constrained one, where the agent cannot start either).
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Warning ('install-agent: PowerShell runs this script in ' + $ExecutionContext.SessionState.LanguageMode + ' (AppLocker or WDAC); the agent needs FullLanguage, so it is not installed')
  exit 1
}
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSScriptRoot 'HomeHubAgent.psm1') -Force -DisableNameChecking
Import-AgentRules (Join-Path $PSScriptRoot 'report-rules.json')

$Dry = $DryRun -or $WhatIfPreference
$Utf8 = New-Object Text.UTF8Encoding($false)
$SidAdmins = 'S-1-5-32-544'; $SidSystem = 'S-1-5-18'; $SidLocalService = 'S-1-5-19'
$SidTrustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$TaskPath = '\Home Hub\'; $TaskName = 'home-hub-agent'
$AgentFiles = @('HomeHubAgent.psm1', 'home-hub-agent.ps1', 'report-rules.json')
$Marker = '.agent-install.json'
$Checkout = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$Dirs = @{ agent = (Join-Path $Root 'agent'); config = (Join-Path $Root 'config'); private = (Join-Path $Root 'private'); state = (Join-Path $Root 'state'); logs = (Join-Path $Root 'logs') }
$Read = @(@{ sid = $SidAdmins; rights = 'FullControl' }, @{ sid = $SidSystem; rights = 'FullControl' }, @{ sid = $SidLocalService; rights = 'ReadAndExecute' })
$Writable = @(@{ sid = $SidAdmins; rights = 'FullControl' }, @{ sid = $SidSystem; rights = 'FullControl' }, @{ sid = $SidLocalService; rights = 'Modify' })
# docs/agent.md section 5: the key is ACL'd to the task's account and Administrators.
$KeyGrants = @(@{ sid = $SidAdmins; rights = 'FullControl' }, @{ sid = $SidLocalService; rights = 'Read' })
$AdminOnly = @(@{ sid = $SidAdmins; rights = 'FullControl' }, @{ sid = $SidSystem; rights = 'FullControl' })

function Stop-Install { param([string]$Why) [Console]::Error.WriteLine('install-agent: ' + $Why); exit 1 }
function Say { param([string]$Text) [Console]::Out.WriteLine($Text) }
function Test-Admin {
  return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Test-Link { param($Info) return [bool]($Info.Attributes -band [IO.FileAttributes]::ReparsePoint) }
# A path the person gave: absolute, no quote and no control character (it goes into the task's command line).
function Test-PlainPath { param([string]$Path) return ($Path -and $Path.Length -le 260 -and [regex]::IsMatch($Path, '^[A-Za-z]:\\[^\u0000-\u001f"*?<>|]*$')) }
# -Root: a plain path, not a drive (C:\), no trailing backslash (the task's -Root "D:\Agent\" would read \" as a quote),
# written in full (no . or .., no doubled backslash, no trailing dot or space). $null when it is fine, else why not.
function Test-RootPath {
  param([string]$Path)
  if (-not (Test-PlainPath $Path)) { return '-Root must be an absolute path without quotes' }
  if ($Path.EndsWith('\')) { return '-Root must not be a drive or end with \' }
  if ([IO.Path]::GetFullPath($Path) -cne $Path) { return '-Root must be written in full (no . or .., no doubled \, no trailing dot or space)' }
  return $null
}
# An existing -Root is the agent's: a plain directory that holds .agent-install.json (a plain file the installer wrote,
# schema 1), or, for an install only, an empty directory. A path that does not exist passes (nothing is there).
function Test-AgentRoot {
  param([string]$Path, [switch]$Installed)
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer -or (Test-Link $item)) { return $false }
  $m = New-Object IO.FileInfo((Join-Path $Path $Marker))
  if ($m.Exists -and -not (Test-Link $m)) {
    try { $record = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($m.FullName, $Utf8)) } catch { $record = $null }
    return ((Get-Prop $record 'schema') -eq 1 -and (Get-Prop $record 'account') -ceq $SidLocalService)
  }
  if ($Installed) { return $false }
  return (@(Get-ChildItem -LiteralPath $Path -Force).Count -eq 0)
}
# Removes a directory tree without ever following a link. state and logs hold what LocalService made, and LocalService
# may make a junction or a symbolic link there (to C:\Windows, say); Windows PowerShell 5.1's Remove-Item -Recurse
# follows one inside the tree and deletes the target's contents, as an administrator. Here each entry is looked at
# from the directory listing: a link (any reparse point) is removed as the link itself, a plain directory is walked,
# a file is deleted. No attribute is changed up front: LocalService may also plant a hard link to another file, and a
# hard link's attributes are its target's. Only when the delete is refused (access denied) for a read-only file whose
# links PowerShell reads as none (LinkType empty: one name only) is the read-only attribute cleared and the delete tried
# again. A read-only file with more than one link, or whose links cannot be read, is left in place and named in
# $script:KeptFiles; the directories that hold it stay too.
# -Last names an entry of Path itself that goes last, and only when nothing was left in place: -Uninstall keeps
# .agent-install.json until the end, so that after a file was left in place and removed by hand, -Uninstall (or an
# install) still knows the directory as the agent's. It goes the way the walk removes any entry (a link as the link
# itself, a file deleted); a directory that is still not empty then (an entry added since the listing, or a -Last that
# is a plain directory) is named in $script:KeptFiles, not thrown in the middle of -Uninstall.
$script:KeptFiles = New-Object 'Collections.Generic.List[string]'
function Remove-Tree {
  param([string]$Path, [string]$Last)
  $dir = New-Object IO.DirectoryInfo($Path)
  if (-not $dir.Exists) { return }
  if (Test-Link $dir) { [IO.Directory]::Delete($Path, $false); return }
  $kept = $script:KeptFiles.Count
  foreach ($e in @($dir.GetFileSystemInfos())) {
    if ($Last -and $e.Name -eq $Last) { continue }
    $isDir = [bool]($e.Attributes -band [IO.FileAttributes]::Directory)
    if (Test-Link $e) {
      if ($isDir) { [IO.Directory]::Delete($e.FullName, $false) } else { [IO.File]::Delete($e.FullName) }
    } elseif ($isDir) {
      Remove-Tree $e.FullName
    } else {
      try { [IO.File]::Delete($e.FullName) } catch {
        $x = $_.Exception; if ($x.InnerException) { $x = $x.InnerException }
        if (-not ($x -is [UnauthorizedAccessException])) { throw }
        $e.Refresh()
        if (-not ($e.Attributes -band [IO.FileAttributes]::ReadOnly)) { throw }
        $linkType = 'unknown'
        try { $linkType = [string]$e.LinkType } catch { $linkType = 'unknown' }
        if ($linkType) {
          $script:KeptFiles.Add($e.FullName)
        } else {
          $e.Attributes = [IO.FileAttributes]([int]$e.Attributes -band (-bnot [int][IO.FileAttributes]::ReadOnly))
          [IO.File]::Delete($e.FullName)
        }
      }
    }
  }
  if ($script:KeptFiles.Count -eq $kept) {
    if ($Last) {
      foreach ($e in @($dir.GetFileSystemInfos() | Where-Object { $_.Name -eq $Last })) {
        $isDir = [bool]($e.Attributes -band [IO.FileAttributes]::Directory)
        if (Test-Link $e) {
          if ($isDir) { [IO.Directory]::Delete($e.FullName, $false) } else { [IO.File]::Delete($e.FullName) }
        } elseif (-not $isDir) { [IO.File]::Delete($e.FullName) }
      }
    }
    try { [IO.Directory]::Delete($Path, $false) } catch {
      $x = $_.Exception; if ($x.InnerException) { $x = $x.InnerException }
      if (-not ($x -is [IO.IOException])) { throw }
      $script:KeptFiles.Add($Path)
    }
  }
}
# What Remove-Tree left in place, on the error stream; $true when nothing was left.
function Show-KeptFiles {
  if ($script:KeptFiles.Count -eq 0) { return $true }
  foreach ($f in $script:KeptFiles) {
    if ([IO.Directory]::Exists($f)) {
      [Console]::Error.WriteLine('install-agent: left in place: ' + $f + ' (not empty when it was removed last: see what is in it and remove it by hand)')
    } else {
      [Console]::Error.WriteLine('install-agent: left in place: ' + $f + ' (read-only, with more than one hard link or links that could not be read; an administrator does not change its attribute: see what it links to and remove it by hand)')
    }
  }
  $script:KeptFiles.Clear()
  return $false
}
# An ACL of exactly these grants: owner Administrators, no inheritance from above, read back and compared.
function Set-PrivateAcl {
  param([string]$Path, [switch]$Directory, [object[]]$Grants)
  if ($Directory) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($SidAdmins)))
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($g in $Grants) {
    $sid = New-Object Security.Principal.SecurityIdentifier($g.sid)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]$g.rights, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
  Test-PrivateAcl $Path $Grants
}
# Throws unless the ACL of Path is protected and grants only these accounts.
function Test-PrivateAcl {
  param([string]$Path, [object[]]$Grants)
  $acl = Get-Acl -LiteralPath $Path
  $allowed = @($Grants | ForEach-Object { $_.sid })
  if (-not $acl.AreAccessRulesProtected) { throw ('the ACL of ' + $Path + ' inherits from above') }
  foreach ($r in $acl.Access) {
    $sid = $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ([string]$r.AccessControlType -ne 'Allow' -or $allowed -notcontains $sid) { throw ('the ACL of ' + $Path + ' is not what was set') }
  }
}
# A directory of the agent: refused when it is a link or owned by someone who is not an administrator (a directory under
# ProgramData that another account made first), then given its ACL. -KeepAcl (an update's <Root>, which holds state and
# logs): an existing directory's ACL is checked, not set again, so that nothing is propagated into what LocalService made.
function New-PrivateDirectory {
  param([string]$Path, [object[]]$Grants, [switch]$KeepAcl)
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or (Test-Link $item)) { throw ($Path + ' is not a plain directory') }
    $owner = (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (@($SidAdmins, $SidSystem, $SidTrustedInstaller) -notcontains $owner) { throw ($Path + ' exists and is owned by another account; remove it first') }
    if ($KeepAcl) { Test-PrivateAcl $Path $Grants; return }
  } else { $null = [IO.Directory]::CreateDirectory($Path) }
  Set-PrivateAcl -Path $Path -Directory -Grants $Grants
}
# state or logs, which LocalService writes: never given an ACL over what is in them. An existing one is moved aside, a
# new one made (it inherits <Root>'s ACL, which LocalService may only read, so it stays empty) and given its ACL while
# empty, the old one's files named in -Keep carried over, and the old one removed with Remove-Tree. A file is carried
# over only when it is not a link and its owner, read through a handle, is LocalService: what LocalService owns it
# could read anyway, so a link to another file gives it nothing. It is moved by name, never copied, and checked again
# where it lands (below).
function New-WritableDirectory {
  param([string]$Path, [object[]]$Grants, [string[]]$Keep = @())
  $old = $null
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or (Test-Link $item)) { throw ($Path + ' is not a plain directory') }
    $old = $Path + '.old-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    [IO.Directory]::Move($Path, $old)
  }
  $null = [IO.Directory]::CreateDirectory($Path)
  Set-PrivateAcl -Path $Path -Directory -Grants $Grants
  if ($null -eq $old) { return }
  # Moved, not copied: a copy would be the administrator's (seen on a real computer: the next update found agent.log
  # owned by Administrators and dropped it), a moved file stays LocalService's. What arrives is checked again, and a
  # name that is a link or not LocalService's (swapped between the check and the move) is removed, as a name only.
  foreach ($name in $Keep) {
    $from = Join-Path $old $name; $to = Join-Path $Path $name
    try {
      $f = New-Object IO.FileInfo($from)
      if (-not $f.Exists -or (Test-Link $f) -or (Get-FileOwnerSid $from) -cne $SidLocalService) { continue }
      [IO.File]::Move($from, $to)
      $t = New-Object IO.FileInfo($to)
      if ((Test-Link $t) -or (Get-FileOwnerSid $to) -cne $SidLocalService) { [IO.File]::Delete($to) }
    } catch { }
  }
  Remove-Tree $old
  $null = Show-KeptFiles
}
# The owner of a file, read through a handle -> its SID, or $null.
function Get-FileOwnerSid {
  param([string]$Path)
  $fs = $null
  try {
    $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    return $fs.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value
  } catch { return $null } finally { if ($fs) { $fs.Dispose() } }
}
# A file from the bytes that were checked: written beside its place, given its ACL, moved in, read back and compared.
# Never the key (its bytes would be a parameter): that is written inline below.
function Write-CheckedFile {
  param([string]$Path, [byte[]]$Bytes, [object[]]$Grants)
  $tmp = $Path + '.new'
  [IO.File]::WriteAllBytes($tmp, $Bytes)
  Set-PrivateAcl -Path $tmp -Grants $Grants
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
  Move-Item -LiteralPath $tmp -Destination $Path
  if ((Get-Sha256Hex ([IO.File]::ReadAllBytes($Path))) -cne (Get-Sha256Hex $Bytes)) { throw ($Path + ' differs from what was checked') }
}
function Get-Task { return (Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue) }
function Register-AgentTask {
  $account = (New-Object Security.Principal.SecurityIdentifier($SidLocalService)).Translate([Security.Principal.NTAccount]).Value
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $script = Join-Path $Dirs.agent 'home-hub-agent.ps1'
  $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + $script + '" -Root "' + $Root + '"'
  $action = New-ScheduledTaskAction -Execute $ps -Argument $arguments -WorkingDirectory $Dirs.agent
  $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType ServiceAccount -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)))
  $null = Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Trigger $triggers -Description 'Home Hub push agent (docs/agent.md). Reports this computer to the hub; installed by install-agent.ps1.' -Force
}
function Stop-AgentTask {
  $t = Get-Task
  if ($t) { Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue }
}
function Read-Status {
  $f = Join-Path $Dirs.state 'status.json'
  if (-not (Test-Path -LiteralPath $f)) { return $null }
  try { return ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($f, $Utf8)) } catch { return $null }
}
# Health: the first report the agent got accepted, after it was started. status.json is LocalService's (see above).
function Wait-FirstReport {
  param([DateTime]$Since, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $s = Read-Status
    $at = Get-Prop $s 'lastAcceptedAt'
    if ($at) {
      $when = [DateTime]::Parse($at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal)
      if ($when -ge $Since.ToUniversalTime()) { return $true }
    }
  }
  return $false
}
# Starts the task with no status.json from before and waits for its first accepted report.
function Start-AgentAndWait {
  $f = Join-Path $Dirs.state 'status.json'
  if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force }
  Register-AgentTask
  $started = Get-Date
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
  return (Wait-FirstReport $started $Wait)
}

$rootWhy = Test-RootPath $Root
if ($rootWhy) { Stop-Install $rootWhy }

# --- uninstall ------------------------------------------------------------------------------------------------------
if ($Uninstall) {
  Say ('Remove the Scheduled Task ' + $TaskPath + $TaskName + ' and ' + $Root + ' (code, configuration, key, state, logs).')
  if ($Dry) { Say 'Dry run: nothing changed.'; exit 0 }
  if (-not (Test-Admin)) { Stop-Install 'run this as an administrator' }
  if (-not (Test-AgentRoot $Root -Installed)) { Stop-Install ($Root + ' is not a directory this installer made (no ' + $Marker + ' in it, or it is a link); nothing removed') }
  if (Get-Task) { Stop-AgentTask; Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false }
  Remove-Tree $Root -Last $Marker
  if (-not (Show-KeptFiles)) { Stop-Install ('the task is removed, ' + $Root + ' is not: the files named above are left in it; remove them by hand, then run -Uninstall again') }
  Say ('Removed. Backups, if any, stay in ' + (Join-Path $env:ProgramData 'Home Hub Agent Backups') + '. Revoke the key on the hub: node scripts/manage-access.mjs revoke-agent-key --id <id>, or the admin page.')
  exit 0
}

# --- check everything first ------------------------------------------------------------------------------------------
if (-not $Hub) { Stop-Install 'say which hub: -Hub https://hub.example.lan' }
if (-not $KeyFile -and -not $Once) { Stop-Install 'say which key: -KeyFile C:\path\agent-key.json (create-agent-key --output wrote it)' }
if ($Pin.Count -and $Ca) { Stop-Install '-Pin and -Ca exclude each other' }
if ($Pin.Count -gt 2) { Stop-Install 'at most two -Pin (the certificate and its successor)' }
if ($Wait -lt 10 -or $Wait -gt 900) { Stop-Install '-Wait is 10-900 seconds' }
if (-not $Once -and -not (Test-AgentRoot $Root)) { Stop-Install ($Root + ' exists and is not the agent''s: it is not empty and holds no ' + $Marker + ' (or it is a link)') }
$hubInfo = Test-HubOrigin $Hub
if ($null -eq $hubInfo) { Stop-Install '-Hub must be an origin: https://<name or IPv4>[:port], or http://127.0.0.1[:port] on the hub itself' }

# The key file. Its text holds the token, so it never reaches a command as a parameter (Module Logging records those):
# the token is cut out with .NET's regex first, and ConvertFrom-Json reads the file with a placeholder in its place.
$token = $null; $agentId = $null; $device = $null
if ($KeyFile) {
  try { $keyText = [IO.File]::ReadAllText($KeyFile, $Utf8) } catch { Stop-Install '-KeyFile cannot be read' }
  $found = [regex]::Matches($keyText, 'hha_[0-9a-f]{64}')
  $placeholder = 'hha_' + ('x' * 64)
  if ($found.Count -ne 1) { $keyText = $null; Stop-Install '-KeyFile is not an agent key file (schema 1, one hha_ token)' }
  $token = $found[0].Value
  $masked = $keyText.Replace($token, $placeholder); $keyText = $null; $found = $null
  try { $k = ConvertFrom-Json -InputObject $masked } catch { $k = $null }
  $agentInfo = Get-Prop $k 'agent'
  if ((Get-Prop $k 'schema') -ne 1 -or (Get-Prop $k 'token') -cne $placeholder -or -not ((Get-Prop $agentInfo 'device') -is [string])) { $token = $null; Stop-Install '-KeyFile is not an agent key file (schema 1, an hha_ token)' }
  $device = [string](Get-Prop $agentInfo 'device'); $agentId = [string](Get-Prop $agentInfo 'id')
}
$specsBytes = New-Object byte[] 0
if ($Specs) { try { $specsBytes = [IO.File]::ReadAllBytes($Specs) } catch { Stop-Install 'cannot read -Specs' } }
$specsCheck = Read-AgentSpecs $specsBytes
if (-not $specsCheck.ok) { Stop-Install ('the watch list does not pass the agent''s check: ' + ((@($specsCheck.errors) | ForEach-Object { 'line ' + $_.line + ': ' + $_.reason }) -join '; ')) }
$caBytes = $null
if ($Ca) {
  try { $caText = [IO.File]::ReadAllText($Ca, $Utf8) } catch { Stop-Install 'cannot read -Ca' }
  if ($null -eq (Read-PemCertificate $caText)) { Stop-Install '-Ca holds no PEM certificate' }
  $caBytes = $Utf8.GetBytes($caText)
}
$pins = @($Pin | ForEach-Object { ([string]$_ -replace '[:\s]', '').ToLowerInvariant() })
$trust = $null
if ($pins.Count) { $trust = [ordered]@{ pins = [string[]]$pins } }
elseif ($Ca) { $trust = [ordered]@{ ca = (Join-Path $Dirs.config 'hub-ca.pem') } }
$config = [ordered]@{ schema = 1; hub = $hubInfo.origin }
if ($trust) { $config['trust'] = $trust }
$configText = (ConvertTo-AgentJson $config) + "`n"
try { $parsed = Read-AgentConfig $configText } catch { Stop-Install ([string]$_.Exception.Message) }
$version = Read-AgentVersion (Join-Path $Checkout 'package.json')
if ($null -eq $version) { Stop-Install 'cannot read the version from package.json of this checkout' }
$files = [ordered]@{}
foreach ($f in $AgentFiles) { $files[$f] = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $f)) }
$files['package.json'] = [IO.File]::ReadAllBytes((Join-Path $Checkout 'package.json'))

# --- the plan ------------------------------------------------------------------------------------------------------
Say ('Home Hub agent ' + $version + ' for Windows')
Say ('  hub        ' + $hubInfo.origin + ' (trust: ' + $parsed.trust.mode + ')')
if ($token) { Say ('  key        ' + $token.Substring(0, 12) + '... for device ' + $device + ' -> ' + (Join-Path $Dirs.private 'agent.key')) }
Say ('  runs as    NT AUTHORITY\LocalService, Scheduled Task ' + $TaskPath + $TaskName)
Say ('  files      ' + $Root + ' (agent, config, private, state, logs)')
Say ('  watch list ' + @($specsCheck.lines).Count + ' line(s):')
foreach ($l in $specsCheck.lines) { Say ('    ' + $l) }
if ($Dry) { Say 'Dry run: nothing changed.'; exit 0 }

# --- once, from this checkout ----------------------------------------------------------------------------------------
if ($Once) {
  $token = $null
  $code = 1
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('home-hub-agent-once-' + [Guid]::NewGuid().ToString('N'))
  $null = [IO.Directory]::CreateDirectory($tmp)
  try {
    $onceConfig = $config
    if ($Ca) { $onceConfig = [ordered]@{ schema = 1; hub = $hubInfo.origin; trust = [ordered]@{ ca = (Join-Path $tmp 'hub-ca.pem') } }; [IO.File]::WriteAllBytes((Join-Path $tmp 'hub-ca.pem'), $caBytes) }
    [IO.File]::WriteAllText((Join-Path $tmp 'agent.json'), (ConvertTo-AgentJson $onceConfig) + "`n", $Utf8)
    [IO.File]::WriteAllBytes((Join-Path $tmp 'specs.txt'), $specsBytes)
    Say 'Once: the agent from this checkout, as you (not as LocalService); nothing is sent.'
    & (Join-Path $PSScriptRoot 'home-hub-agent.ps1') -Once -ConfigDir $tmp
    $code = $LASTEXITCODE
  } finally { Remove-Tree $tmp; $null = Show-KeptFiles }
  exit $code
}
if (-not (Test-Admin)) { Stop-Install 'run this as an administrator' }
if (@($specsCheck.lines).Count -and -not $Yes) {
  if (-not [Environment]::UserInteractive) { Stop-Install 'confirm the watch list with -Yes where there is no terminal' }
  if ((Read-Host 'Install with this watch list? Type yes') -cne 'yes') { Stop-Install 'not confirmed' }
}

# --- install --------------------------------------------------------------------------------------------------------
$previous = Test-Path -LiteralPath (Join-Path $Root $Marker)
$backup = $null
New-PrivateDirectory $Root $Read -KeepAcl:$previous
Stop-AgentTask
if ($previous) {
  $backupRoot = Join-Path $env:ProgramData 'Home Hub Agent Backups'
  New-PrivateDirectory $backupRoot $AdminOnly
  $backup = Join-Path $backupRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
  New-PrivateDirectory $backup $AdminOnly
  foreach ($d in @('agent', 'config')) { if (Test-Path -LiteralPath $Dirs[$d]) { Copy-Item -LiteralPath $Dirs[$d] -Destination (Join-Path $backup $d) -Recurse } }
  Copy-Item -LiteralPath (Join-Path $Root $Marker) -Destination (Join-Path $backup $Marker)
  Say ('Backup of the previous agent: ' + $backup)
}
New-PrivateDirectory $Dirs.agent $Read
New-PrivateDirectory $Dirs.config $Read
New-PrivateDirectory $Dirs.private $KeyGrants
New-WritableDirectory $Dirs.state $Writable
New-WritableDirectory $Dirs.logs $Writable -Keep @('agent.log', 'agent.log.1')
$hashes = [ordered]@{}
foreach ($name in $files.Keys) { Write-CheckedFile (Join-Path $Dirs.agent $name) $files[$name] $Read; $hashes['agent/' + $name] = Get-Sha256Hex $files[$name] }
Write-CheckedFile (Join-Path $Dirs.config 'agent.json') ($Utf8.GetBytes($configText)) $Read
Write-CheckedFile (Join-Path $Dirs.config 'specs.txt') $specsBytes $Read
if ($Ca) { Write-CheckedFile (Join-Path $Dirs.config 'hub-ca.pem') $caBytes $Read }
elseif (Test-Path -LiteralPath (Join-Path $Dirs.config 'hub-ca.pem')) { Remove-Item -LiteralPath (Join-Path $Dirs.config 'hub-ca.pem') -Force }
# The key, inline: .NET calls only, so its bytes are never a parameter of a command.
$keyPath = Join-Path $Dirs.private 'agent.key'
$keyBytes = $Utf8.GetBytes($token + "`n")
$token = $null
[IO.File]::WriteAllBytes($keyPath + '.new', $keyBytes)
Set-PrivateAcl -Path ($keyPath + '.new') -Grants $KeyGrants
if ([IO.File]::Exists($keyPath)) { [IO.File]::Delete($keyPath) }
[IO.File]::Move($keyPath + '.new', $keyPath)
$keySame = [Convert]::ToBase64String([IO.File]::ReadAllBytes($keyPath)) -ceq [Convert]::ToBase64String($keyBytes)
[Array]::Clear($keyBytes, 0, $keyBytes.Length)
if (-not $keySame) { Stop-Install ($keyPath + ' differs from what was checked') }
$record = [ordered]@{ schema = 1; installedAt = (Format-Iso (Get-NowMs)); version = $version; hub = $hubInfo.origin; trust = $parsed.trust.mode; agentId = $agentId; device = $device
  account = $SidLocalService; task = $TaskPath + $TaskName; specsSha256 = (Get-Sha256Hex $specsBytes); files = $hashes; backup = $backup }
Write-CheckedFile (Join-Path $Root $Marker) ($Utf8.GetBytes((ConvertTo-AgentJson $record) + "`n")) $Read
Say ('Starting; waiting up to ' + $Wait + ' s for the first accepted report...')
if (Start-AgentAndWait) { Say ('OK: the hub accepted the agent''s first report. Status: ' + (Join-Path $Dirs.state 'status.json') + ', log: ' + (Join-Path $Dirs.logs 'agent.log')); exit 0 }

$s = Read-Status
$why = 'no report accepted'; if ($s -and (Get-Prop $s 'lastError')) { $why = [string](Get-Prop $s 'lastError') }
[Console]::Error.WriteLine('The new agent did not report within ' + $Wait + ' s (' + $why + ').')
Stop-AgentTask
if ($backup) {
  # The previous agent and configuration exactly: a file the new version added (config\hub-ca.pem, say) goes too.
  foreach ($d in @('agent', 'config')) {
    $from = Join-Path $backup $d
    $keep = @()
    if (Test-Path -LiteralPath $from) { $keep = @(Get-ChildItem -LiteralPath $from -File -Force | ForEach-Object { $_.Name }) }
    foreach ($f in @(Get-ChildItem -LiteralPath $Dirs[$d] -File -Force)) { if ($keep -notcontains $f.Name) { Remove-Item -LiteralPath $f.FullName -Force } }
    foreach ($name in $keep) { Write-CheckedFile (Join-Path $Dirs[$d] $name) ([IO.File]::ReadAllBytes((Join-Path $from $name))) $Read }
  }
  Write-CheckedFile (Join-Path $Root $Marker) ([IO.File]::ReadAllBytes((Join-Path $backup $Marker))) $Read
  [Console]::Error.WriteLine('Put back the previous agent and configuration from ' + $backup + ' (the key stays the new one); waiting up to ' + $Wait + ' s for it...')
  if (Start-AgentAndWait) { [Console]::Error.WriteLine('The previous agent reports again.') }
  else { [Console]::Error.WriteLine('The previous agent did not report either: see ' + (Join-Path $Dirs.logs 'agent.log') + ' and ' + (Join-Path $Dirs.state 'status.json') + '.') }
} else {
  Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false
  [Console]::Error.WriteLine('First install: the task is removed, the files stay in ' + $Root + ' for a look (logs\agent.log); -Uninstall removes them.')
}
exit 1
