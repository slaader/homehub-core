<#
.SYNOPSIS
  The Home Hub push agent for Windows (docs/agent.md -> Windows: PowerShell only). Windows PowerShell 5.1.

.DESCRIPTION
  Installed and registered as a Scheduled Task by install-agent.ps1, run as NT AUTHORITY\LocalService; it updates only
  when the installer is run again from a newer checkout. Reports to the hub of <Root>\config\agent.json what this computer
  is (os), what Windows Update already knows is pending (updates) and the watched software of the local specs.txt
  (packages), and a heartbeat. The hub's answer is read for its status, Retry-After and acknowledgement, nothing else.

    home-hub-agent.ps1                         run: report until stopped (the Scheduled Task)
    home-hub-agent.ps1 -Once                   collect every part once, check it and print the envelope; no key is
                                               read, nothing is sent
    home-hub-agent.ps1 -Once -Send             the same, sent once; prints the hub's status and which parts it
                                               accepted (exit 0 on a 200 with an accepted part)
    home-hub-agent.ps1 -CheckSpecs -SpecsFile <file>
                                               check a watch list as the agent will at start; prints its lines
    home-hub-agent.ps1 -SelfTest <vectors.json> [-FixtureDir <dir>]
                                               run the shared test vectors (tests/fixtures/agent-windows/) through
                                               this agent's checks: the owner's check on a computer with PowerShell

  Where things are (docs/agent.md section 5): <Root> is C:\ProgramData\Home Hub Agent; the code in <Root>\agent, the
  configuration in <Root>\config (agent.json, specs.txt, hub-ca.pem), the key in <Root>\private\agent.key, status.json
  in <Root>\state and the log in <Root>\logs. A start check that fails exits 78 with status.json -> lastError
  (config-invalid, specs-invalid, ca-invalid, trust-unavailable, key-missing, key-invalid, rules-invalid, version).
  The agent needs full language mode (it calls .NET throughout): in a constrained language mode (AppLocker or WDAC
  over a script outside the allowed paths) it says so on standard error and exits 78 before anything else, without a
  status.json, which it could not write there; the Scheduled Task's last result shows 78 (0x4E).
  The version (agentVersion) is package.json beside this script, as installed; run from a checkout
  (scripts\agent\windows), the checkout's own package.json at its root.
  The key is never printed, logged, put on a command line, into the environment or into a parameter.
#>
[CmdletBinding()]
param(
  [string]$Root = (Join-Path $env:ProgramData 'Home Hub Agent'),
  [string]$ConfigDir,
  [string]$StateDir,
  [switch]$Once,
  [switch]$Send,
  [switch]$CheckSpecs,
  [string]$SpecsFile,
  [string]$SelfTest,
  [string]$FixtureDir
)
Set-StrictMode -Version 2.0
$ExitConfig = 78
# First, before any .NET type: a constrained language mode refuses them all, so nothing below would run.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Warning ('home-hub-agent: language-mode: PowerShell runs this script in ' + $ExecutionContext.SessionState.LanguageMode + ' (AppLocker or WDAC); the agent needs FullLanguage')
  exit $ExitConfig
}
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::InvariantCulture
Import-Module (Join-Path $PSScriptRoot 'HomeHubAgent.psm1') -Force -DisableNameChecking

if (-not $ConfigDir) { $ConfigDir = Join-Path $Root 'config' }
if (-not $StateDir) { $StateDir = Join-Path $Root 'state' }
$LogDir = Join-Path $Root 'logs'
$KeyFile = Join-Path (Join-Path $Root 'private') 'agent.key'
# The version: package.json beside the script (the installed agent), else the checkout's at its root when this script
# is the checkout's scripts\agent\windows\home-hub-agent.ps1 (-Once from the checkout, the installer's -Once).
$VersionFile = Join-Path $PSScriptRoot 'package.json'
if (-not (Test-Path -LiteralPath $VersionFile -PathType Leaf) -and $PSScriptRoot -match '[\\/]scripts[\\/]agent[\\/]windows$') {
  $VersionFile = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\package.json'))
}

# --- the shared vectors (no network, nothing written) ---------------------------------------------------------------
if ($SelfTest) {
  Import-AgentRules (Join-Path $PSScriptRoot 'report-rules.json')
  $v = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($SelfTest, (New-Object Text.UTF8Encoding($false))))
  $failed = 0; $ran = 0
  foreach ($c in @($v.specs | Where-Object { $_.platform -ceq 'windows' })) {
    $ran++
    $r = Test-AgentSpecs ([string]$c.text)
    $reason = $null; $line = $null
    if (-not $r.ok) { $reason = $r.errors[0].reason; $line = $r.errors[0].line }
    $want = [bool]$c.ok
    if ($r.ok -ne $want -or (-not $want -and ($reason -cne $c.reason -or $line -ne $c.line))) { $failed++; [Console]::Out.WriteLine('specs FAIL: ' + $c.case + ' (got ' + $r.ok + ' ' + $reason + ')') }
  }
  foreach ($c in @($v.hubs)) {
    $ran++
    $r = Test-HubOrigin ([string]$c.origin)
    $got = $null -ne $r
    if ($got -ne [bool]$c.ok -or ($got -and $r.origin -cne $c.normalized)) { $failed++; [Console]::Out.WriteLine('hub FAIL: ' + $c.origin) }
  }
  foreach ($c in @($v.lines)) {
    $ran++
    $r = Test-RecordLine ([string]$c.part) ([string]$c.line)
    $ok = $null -eq $r
    $bad = $ok -ne [bool]$c.ok
    if (-not $ok -and -not $bad) {
      $tag = $null; if ($r.ContainsKey('tag')) { $tag = $r.tag }
      $field = $null; if ($r.ContainsKey('field')) { $field = $r.field }
      $wantTag = Get-Prop $c 'tag'; $wantField = Get-Prop $c 'field'
      $bad = ($r.code -cne $c.code) -or ($tag -cne $wantTag) -or ($field -ne $wantField)
    }
    if ($bad) { $failed++; [Console]::Out.WriteLine('line FAIL: ' + $c.case) }
  }
  foreach ($c in @($v.names)) {
    $ran++
    if ((Test-DisplayName ([string]$c.pattern) ([string]$c.name)) -ne [bool]$c.match) { $failed++; [Console]::Out.WriteLine('name FAIL: ' + $c.case) }
  }
  foreach ($c in @($v.configs)) {
    $ran++
    $ok = $true
    try { $null = Read-AgentConfig ([string]$c.text) } catch { $ok = $false }
    if ($ok -ne [bool]$c.ok) { $failed++; [Console]::Out.WriteLine('config FAIL: ' + $c.case) }
  }
  if ($FixtureDir) {
    foreach ($f in @(Get-ChildItem -LiteralPath $FixtureDir -Filter 'report-*.json')) {
      $report = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($f.FullName, (New-Object Text.UTF8Encoding($false))))
      foreach ($p in $report.parts.PSObject.Properties) {
        # Only the heartbeat has no records, and nothing to check: @($null) would be one empty line. Any other part
        # without records is a broken fixture, and counts as a failure.
        $records = Get-Prop $p.Value 'records'
        if ($null -eq $records) {
          if ($p.Name -cne 'heartbeat') { $ran++; $failed++; [Console]::Out.WriteLine('fixture FAIL: ' + $f.Name + ' ' + $p.Name + ' has no records') }
          continue
        }
        foreach ($line in @($records)) {
          $ran++
          if ($null -ne (Test-RecordLine $p.Name ([string]$line))) { $failed++; [Console]::Out.WriteLine('fixture FAIL: ' + $f.Name + ' ' + $p.Name + ' ' + ([string]$line).Split([char]9)[0]) }
        }
      }
    }
  }
  [Console]::Out.WriteLine('self-test: ' + $ran + ' checks, ' + $failed + ' failed')
  if ($failed) { exit 1 }
  exit 0
}

# --- a watch list, as the installer shows it ------------------------------------------------------------------------
if ($CheckSpecs) {
  Import-AgentRules (Join-Path $PSScriptRoot 'report-rules.json')
  $r = Read-AgentSpecs ([IO.File]::ReadAllBytes($SpecsFile))
  if (-not $r.ok) { foreach ($e in $r.errors) { [Console]::Error.WriteLine('line ' + $e.line + ': ' + $e.reason) }; exit $ExitConfig }
  foreach ($l in $r.lines) { [Console]::Out.WriteLine($l) }
  exit 0
}

# --- the agent ------------------------------------------------------------------------------------------------------
$writeStatus = (-not $Once) -or $Send
if ($writeStatus) { Set-AgentFiles -WritableDirs @($StateDir, $LogDir) -LogFile $(if ($Once) { $null } else { Join-Path $LogDir 'agent.log' }) }
$p = Initialize-Agent -AgentDir $PSScriptRoot -VersionFile $VersionFile -ConfigDir $ConfigDir -KeyFile $KeyFile -NoKey:($Once -and -not $Send)
if (-not $p.ok) {
  [Console]::Error.WriteLine($p.error + ': ' + $p.detail)
  if ($writeStatus) { $s = New-AgentStatus; $s.lastError = $p.error; $s.parts = @{}; Save-AgentStatus $s $StateDir; Write-AgentLog ($p.error + ': ' + $p.detail) }
  exit $ExitConfig
}
$setup = $p.setup
if ($Once) {
  $envelope = Invoke-AgentCollectOnce $setup
  if (-not $Send) {
    [Console]::Out.WriteLine((ConvertTo-AgentJson $envelope))
    if ($envelope.parts.Count -gt 1) { exit 0 }
    exit 1
  }
  $sent = @($envelope.parts.Keys | ForEach-Object { [string]$_ })
  $status = New-AgentStatus
  $t = Get-NowMs
  $status.lastAttemptAt = Format-Iso $t
  $r = Send-AgentReport $setup.config ((New-Object Text.UTF8Encoding($false)).GetBytes((ConvertTo-AgentJson $envelope))) $sent
  $out = [ordered]@{ status = $r.status }
  if ($r.error) { $out['error'] = $r.error }
  if ($r.retryAfter) { $out['retryAfter'] = $r.retryAfter }
  if ($r.status -eq 200) {
    $out['accepted'] = @($r.ack.accepted); $out['refused'] = @($r.ack.refused)
    foreach ($n in $sent) {
      $s = $status.parts[$n]; $s.lastSentAt = Format-Iso $t
      if ($r.ack.accepted -ccontains $n) { $s.lastAcceptedAt = Format-Iso (Get-NowMs) } else { $s.lastRefused = [ordered]@{ code = 'unanswered' } }
    }
    if ($r.ack.accepted.Count) { $status.lastAcceptedAt = Format-Iso (Get-NowMs) } else { $status.lastError = 'refused' }
  } elseif ($r.status) { $status.lastError = 'http-' + $r.status } else { $status.lastError = $r.error }
  Save-AgentStatus $status $StateDir
  [Console]::Out.WriteLine((ConvertTo-AgentJson $out))
  if ($r.status -eq 200 -and $r.ack.accepted.Count) { exit 0 }
  exit 1
}
Write-AgentLog ('home-hub-agent ' + $setup.version + ' on windows: reporting to ' + $setup.config.hub.origin + ' (' + $setup.config.trust.mode + ')')
Invoke-AgentLoop $setup $StateDir
