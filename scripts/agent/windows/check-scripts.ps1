<#
.SYNOPSIS
  The owner's check of the Windows agent's scripts, where PowerShell exists (Windows PowerShell 5.1, or pwsh on any
  system). Not part of npm test: core's tests must pass on a computer without PowerShell, and they check these files
  statically instead (tests/agent-windows-fixtures.test.mjs).

.DESCRIPTION
    powershell -NoProfile -ExecutionPolicy RemoteSigned -File scripts\agent\windows\check-scripts.ps1
    pwsh -NoProfile -File scripts/agent/windows/check-scripts.ps1

  1. Parses every .ps1 and .psm1 of this directory with PowerShell's own parser
     ([System.Management.Automation.Language.Parser]::ParseFile) and lists every parse error.
  2. Runs home-hub-agent.ps1 -SelfTest over tests/fixtures/agent-windows/vectors.json (the watch-list, hub-origin,
     record-line and configuration vectors the Node test runs against the hub's own code) and checks every record of
     the envelope fixtures beside it with the agent's line check.
  Reads files only; sends nothing, writes nothing. Exit 0 when both pass.
#>
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$fixtures = [IO.Path]::GetFullPath((Join-Path $here '..\..\..\tests\fixtures\agent-windows'))
$failed = 0
foreach ($f in @(Get-ChildItem -LiteralPath $here -File | Where-Object { $_.Extension -eq '.ps1' -or $_.Extension -eq '.psm1' } | Sort-Object Name)) {
  $tokens = $null; $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
  if ($errors -and $errors.Count) {
    $failed++
    foreach ($e in $errors) { [Console]::Out.WriteLine($f.Name + ':' + $e.Extent.StartLineNumber + ': ' + $e.Message) }
  } else { [Console]::Out.WriteLine('parsed: ' + $f.Name) }
}
[Console]::Out.WriteLine('PowerShell ' + $PSVersionTable.PSVersion + ' (' + $PSVersionTable.PSEdition + ')')
& (Join-Path $here 'home-hub-agent.ps1') -SelfTest (Join-Path $fixtures 'vectors.json') -FixtureDir $fixtures
if ($LASTEXITCODE -ne 0) { $failed++ }
if ($failed) { [Console]::Out.WriteLine('check-scripts: FAILED'); exit 1 }
[Console]::Out.WriteLine('check-scripts: ok')
exit 0
