# The Home Hub push agent for Windows (docs/agent.md -> Windows: PowerShell only): everything but the start, which is
# home-hub-agent.ps1. Windows PowerShell 5.1, no module of anyone else, nothing installed. The installer
# (install-agent.ps1) imports this module too, so the watch list and the configuration are checked by one piece of code.
#
# What it sends is the Node agent's envelope (scripts/agent/agent.mjs), checked here before it leaves with the rules in
# report-rules.json (generated from the hub's own constants by rules.mjs):
#   heartbeat                 every 60 s
#   os + updates + packages   one run of the probe below, every 6 h:
#     os        HOST OS HW UPTIME DEFENDER BITLOCKER WINFW RDP LISTEN END (CIM, the registry; read only)
#     updates   WINUP / WINUP_NONE / WINUP_ERR: the Windows Update Agent's search of its own cache
#               (Microsoft.Update.Session, Online = false) in a background job with a timeout; never a download,
#               never an install, never a scan against Microsoft's servers
#     packages  SW / RUN for each line of the local specs.txt (kind winreg: the system-wide uninstall keys), SPECS
# No sshkeys part and no PRIV line in this series. The hub's answer is read for its status, Retry-After and the
# acknowledgement, and for nothing else.
#
# Writes: only Write-AgentFile writes, and only into the state and log directories it was given. One exception, not the
# agent's own: Add-Type (a pin or a CA only) runs the C# compiler, which writes and deletes its temporary files in the
# account's %TEMP% (for LocalService, C:\Windows\ServiceProfiles\LocalService\AppData\Local\Temp).
#
# The key: Initialize-Agent reads it into $script:Token, and only Send-AgentReport reads that, into the Authorization
# header. It is never a parameter of a function or a cmdlet: Module Logging (event 4103) records the value of every
# parameter a command of a module is called with, and that log is readable by the device's interactive users.
Set-StrictMode -Version 2.0

$script:Invariant = [Globalization.CultureInfo]::InvariantCulture
$script:Utf8 = New-Object Text.UTF8Encoding($false)
$script:Utf8Strict = New-Object Text.UTF8Encoding($false, $true)
$script:Rules = $null
$script:Re = @{}
$script:Parts = $null
$script:Secrets = @()
$script:WritableDirs = @()
$script:LogFile = $null
$script:Trust = $null
$script:Token = $null
$script:UpdateTimeoutSeconds = 300
$script:CimTimeoutSeconds = 30
$script:UpdateSearchMaxAgeDays = 5

# --- small things --------------------------------------------------------------------------------------------------
function Get-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Format-Iso {
  param([long]$Ms, [switch]$Seconds)
  $d = [DateTimeOffset]::FromUnixTimeMilliseconds($Ms).UtcDateTime
  if ($Seconds) { return $d.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", $script:Invariant) }
  return $d.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $script:Invariant)
}
# A property of an object read from JSON, or $null (StrictMode refuses a property that is not there).
function Get-Prop {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $p = $Object.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}
# The own keys of an object read from JSON, as a case-sensitive dictionary (a tag is looked up only among its own).
function ConvertTo-OrdinalMap {
  param($Object)
  $map = New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
  foreach ($p in $Object.PSObject.Properties) { if ($p.MemberType -eq 'NoteProperty') { $map[$p.Name] = $p.Value } }
  return ,$map
}
function New-Regex {
  param([string]$Pattern, [switch]$IgnoreCase, [switch]$Unicode)
  # .NET's \d matches the digits of every script, the hub's JavaScript only 0-9: a rule's \d is [0-9] here. The secret
  # patterns (-Unicode) hold no \b, \w, \d or \s and no IgnoreCase: rules.mjs spells them out in ASCII, so .NET reads
  # them as JavaScript does. Note that .NET's $ also matches before a final line feed: every value checked with these
  # holds no control character by then.
  if (-not $Unicode) { $Pattern = $Pattern.Replace('\d', '[0-9]') }
  $o = [Text.RegularExpressions.RegexOptions]::CultureInvariant
  if ($IgnoreCase) { $o = $o -bor [Text.RegularExpressions.RegexOptions]::IgnoreCase }
  return New-Object Text.RegularExpressions.Regex($Pattern, $o)
}
# A value for one field of a record: never a tab, a line break or another control character; at most Max characters.
function Format-Field {
  param($Value, [int]$Max = 300)
  if ($null -eq $Value) { return '' }
  $s = ([string]$Value) -replace '[\u0000-\u001f\u007f-\u009f]', ' '
  $s = $s.Trim()
  if ($s.Length -gt $Max) { $s = $s.Substring(0, $Max).TrimEnd() }
  return $s
}
# One record line: the tag, then each field as given (callers clip with Format-Field).
function Join-Record {
  param([string]$Tag, [string[]]$Fields)
  if ($null -eq $Fields -or $Fields.Count -eq 0) { return $Tag }
  return $Tag + "`t" + ($Fields -join "`t")
}

# --- the rules ---------------------------------------------------------------------------------------------------------
function Import-AgentRules {
  param([Parameter(Mandatory = $true)][string]$Path)
  $r = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path, $script:Utf8Strict))
  if ((Get-Prop $r 'schema') -ne 1 -or (Get-Prop $r 'platform') -cne 'windows') { throw 'rules-invalid' }
  $script:Re = @{}
  $script:Re['control'] = New-Regex $r.control -Unicode
  $script:Re['tag'] = New-Regex $r.tag
  foreach ($p in $r.types.PSObject.Properties) { $script:Re['type:' + $p.Name] = New-Regex ([string]$p.Value) }
  $script:Re['specs:id'] = New-Regex $r.specs.id
  $script:Re['specs:label'] = New-Regex $r.specs.label
  $script:Re['specs:displayName'] = New-Regex $r.specs.displayName
  $script:Re['hub:host'] = New-Regex $r.hub.host
  $script:Re['hub:ipv4'] = New-Regex $r.hub.ipv4
  $script:Re['hub:pin'] = New-Regex $r.hub.pin
  $script:Re['semver'] = New-Regex $r.semver
  $script:Secrets = @(foreach ($s in $r.secret) {
      New-Object PSObject -Property @{ re = (New-Regex ([string]$s.pattern) -Unicode -IgnoreCase:([bool]$s.ignoreCase)); shape = [bool]$s.shape }
    })
  $parts = ConvertTo-OrdinalMap $r.parts
  $script:Parts = New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
  foreach ($name in @($parts.Keys)) { $script:Parts[$name] = ConvertTo-OrdinalMap $parts[$name] }
  $script:Rules = $r
}

# What a value looks like a secret by: "all" every pattern, "named" all but the two shape patterns.
function Test-Secret {
  param([string]$Value, [string]$Check)
  if ($Check -cne 'all' -and $Check -cne 'named') { return $false }
  foreach ($s in $script:Secrets) {
    if ($Check -ceq 'named' -and $s.shape) { continue }
    if ($s.re.IsMatch($Value)) { return $true }
  }
  return $false
}
# One field -> $null when it fits, else 'invalid' or 'secret' (server/agent-report.mjs, checkValue).
function Test-FieldValue {
  param($Type, [string]$Value)
  $t = [string]$Type.t
  if ($t -ceq 'text') {
    if ($Value.Length -gt [int]$Type.n) { return 'invalid' }
    if (Test-Secret $Value ([string]$Type.check)) { return 'secret' }
    return $null
  }
  if ($t -ceq 'enum') {
    if (@($Type.v) -ccontains $Value) { return $null }
    return 'invalid'
  }
  if (-not $script:Re.ContainsKey('type:' + $t)) { return 'invalid' }
  if (-not $script:Re['type:' + $t].IsMatch($Value)) { return 'invalid' }
  if ($t -ceq 'iso') {
    $when = [DateTime]::MinValue
    $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
    if (-not [DateTime]::TryParseExact($Value, "yyyy-MM-dd'T'HH:mm:ss'Z'", $script:Invariant, $styles, [ref]$when)) { return 'invalid' }
  }
  return $null
}
# One record line of a part -> $null when it fits the field table, else @{code; tag; field} (checkLine). Never the value.
function Test-RecordLine {
  param([string]$Part, [string]$Line)
  $fields = $Line.Split([char]9)
  $tag = $fields[0]
  $named = @{}
  if ($script:Re['tag'].IsMatch($tag)) { $named = @{ tag = $tag } }
  if ($script:Utf8.GetByteCount($Line) -gt [int]$script:Rules.limits.lineBytes -or $script:Re['control'].IsMatch($Line)) { return (@{ code = 'invalid' } + $named) }
  if (-not $script:Parts.ContainsKey($Part)) { return (@{ code = 'invalid' } + $named) }
  $table = $script:Parts[$Part]
  if (-not $script:Re['tag'].IsMatch($tag) -or -not $table.ContainsKey($tag)) { return (@{ code = 'invalid' } + $named) }
  $spec = $table[$tag]
  $values = @($fields | Select-Object -Skip 1)
  if ($values.Count -lt [int]$spec.min -or $values.Count -gt [int]$spec.max) { return @{ code = 'invalid'; tag = $tag } }
  $types = @($spec.fields)
  for ($i = 0; $i -lt $values.Count; $i++) {
    $why = Test-FieldValue $types[$i] ([string]$values[$i])
    if ($null -ne $why) { return @{ code = $why; tag = $tag; field = ($i + 1) } }
  }
  return $null
}
# The lines of one part -> @{records; withheld}: a line that fails is left out and counted by tag, field and reason.
function Select-PartRecords {
  param([string]$Part, [string[]]$Lines)
  $records = New-Object 'Collections.Generic.List[string]'
  $counts = New-Object 'Collections.Specialized.OrderedDictionary'
  foreach ($line in @($Lines)) {
    if ($null -eq $line -or $line -ceq '') { continue }
    $why = $null
    if ($script:Utf8.GetByteCount($line) -gt [int]$script:Rules.limits.lineBytes) {
      $tag = $line.Split([char]9)[0]
      if (-not $script:Re['tag'].IsMatch($tag)) { $tag = 'UNKNOWN' }
      $why = @{ tag = $tag; field = 0; reason = 'long' }
    } else {
      $bad = Test-RecordLine $Part $line
      if ($null -ne $bad) {
        $tag = 'UNKNOWN'; if ($bad.ContainsKey('tag')) { $tag = $bad.tag }
        $field = 0; if ($bad.ContainsKey('field')) { $field = [int]$bad.field }
        $reason = 'invalid'; if ($bad.code -ceq 'secret') { $reason = 'secret' }
        $why = @{ tag = $tag; field = $field; reason = $reason }
      }
    }
    if ($null -eq $why) { $records.Add($line); continue }
    $key = $why.tag + "`t" + $why.field + "`t" + $why.reason
    if ($counts.Contains($key)) { $counts[$key].count = $counts[$key].count + 1 }
    else { $counts[$key] = @{ tag = $why.tag; field = $why.field; reason = $why.reason; count = 1 } }
  }
  $withheld = @()
  foreach ($w in @($counts.Values | Select-Object -First ([int]$script:Rules.limits.withheld))) {
    $withheld += , ([ordered]@{ tag = $w.tag; field = [int]$w.field; reason = $w.reason; count = [int][Math]::Min($w.count, [int]$script:Rules.limits.lines) })
  }
  return @{ records = $records.ToArray(); withheld = $withheld }
}

# --- the watch list ---------------------------------------------------------------------------------------------------
# specs.txt -> @{ok; lines; errors = @(@{line; reason})}: validateSpecs's format and reasons, Windows kinds
# (scripts/agent/windows/specs.mjs is the hub's copy; tests/fixtures/agent-windows/vectors.json holds both to it).
function Test-AgentSpecs {
  param([string]$Text)
  $errors = @(); $lines = @()
  if ($null -eq $Text) { return @{ ok = $false; lines = @(); errors = @(@{ line = 0; reason = 'not text' }) } }
  if ($Text -ceq '') { return @{ ok = $true; lines = @(); errors = @() } }
  if (-not $Text.EndsWith("`n")) { return @{ ok = $false; lines = @(); errors = @(@{ line = 0; reason = 'the file must end with a newline' }) } }
  $all = $Text.Substring(0, $Text.Length - 1).Split([char]10)
  $kinds = @($script:Rules.specs.kinds)
  for ($i = 0; $i -lt $all.Count; $i++) {
    $line = $all[$i]; $n = $i + 1
    $f = $line.Split([char]'|')
    if ($f.Count -ne 5) { $errors += , @{ line = $n; reason = 'a line is id|kind|a|b|label' }; continue }
    # .NET's $ also matches before a final line feed; a line has none (split above), and \r fails every class.
    if (-not $script:Re['specs:id'].IsMatch($f[0])) { $errors += , @{ line = $n; reason = 'id' }; continue }
    if (-not ($kinds -ccontains $f[1])) { $errors += , @{ line = $n; reason = 'kind' }; continue }
    if ($f[4] -cne '' -and -not $script:Re['specs:label'].IsMatch($f[4])) { $errors += , @{ line = $n; reason = 'label' }; continue }
    if (-not ($script:Re['specs:displayName'].IsMatch($f[2]) -and $f[3] -ceq '')) { $errors += , @{ line = $n; reason = 'arguments' }; continue }
    $lines += , $line
  }
  if ($errors.Count) { return @{ ok = $false; lines = @(); errors = $errors } }
  return @{ ok = $true; lines = $lines; errors = @() }
}
# The bytes of specs.txt -> @{ok; text; lines; errors}. Not UTF-8 is "not text".
function Read-AgentSpecs {
  param([byte[]]$Bytes)
  try { $text = $script:Utf8Strict.GetString($Bytes) } catch { return @{ ok = $false; text = $null; lines = @(); errors = @(@{ line = 0; reason = 'not text' }) } }
  $r = Test-AgentSpecs $text
  return @{ ok = $r.ok; text = $text; lines = $r.lines; errors = $r.errors }
}
function Get-Sha256Hex {
  param([byte[]]$Bytes)
  $h = [Security.Cryptography.SHA256]::Create()
  try { $d = $h.ComputeHash($Bytes) } finally { $h.Dispose() }
  return (($d | ForEach-Object { $_.ToString('x2') }) -join '')
}

# --- configuration ------------------------------------------------------------------------------------------------------
# The hub's origin -> @{host; port; secure; origin}, or $null (scripts/agent/config.mjs, parseHub): https://<name or IPv4>
# with an optional port, or http://127.0.0.1 on the hub's own host; written as its origin (lower case, no default
# port, no path, query, fragment or user).
function Test-HubOrigin {
  param([string]$Value)
  if ($null -eq $Value -or $Value.Length -gt 300 -or $script:Re['control'].IsMatch($Value)) { return $null }
  $m = [regex]::Match($Value, '^(https?)://([^/:?#@\s\\\[\]]*)(?::([0-9]+))?/?$')
  if (-not $m.Success -or $Value.EndsWith("`n")) { return $null }
  $scheme = $m.Groups[1].Value; $hostName = $m.Groups[2].Value
  if ($hostName -cne $hostName.ToLowerInvariant()) { return $null }
  $isIp = $script:Re['hub:ipv4'].IsMatch($hostName)
  if (-not $isIp -and -not $script:Re['hub:host'].IsMatch($hostName)) { return $null }
  # A last label that is a number makes the whole name an IPv4 address to a URL parser: only the plain form passes.
  $last = $hostName.Split([char]'.')[-1]
  if (-not $isIp -and [regex]::IsMatch($last, '^(0x[0-9a-f]*|[0-9]+)$')) { return $null }
  $secure = $scheme -ceq 'https'
  $port = 443; if (-not $secure) { $port = 80 }
  if ($m.Groups[3].Success) {
    $p = $m.Groups[3].Value
    if (-not [regex]::IsMatch($p, '^[1-9][0-9]{0,4}$') -or [int]$p -gt 65535 -or [int]$p -eq $port) { return $null }
    $port = [int]$p
  }
  if (-not $secure -and $hostName -cne '127.0.0.1') { return $null }
  $origin = $scheme + '://' + $hostName
  if ($m.Groups[3].Success) { $origin += ':' + $port }
  return @{ host = $hostName; port = $port; secure = $secure; origin = $origin }
}
# agent.json -> @{hub; trust = @{mode; pins; caFile}; intervals}. Throws 'config-invalid: <why>'.
#   {"schema": 1, "hub": "https://hub.example.lan", "trust": {"pins": [a, b]} | {"ca": "C:\\...\\hub-ca.pem"}, "intervals": {...}}
function Read-AgentConfig {
  param([string]$Text)
  $no = { param($why) throw ('config-invalid: ' + $why) }
  try { $raw = ConvertFrom-Json -InputObject $Text } catch { & $no 'agent.json is not JSON' }
  if ($null -eq $raw -or -not ($raw -is [Management.Automation.PSCustomObject])) { & $no 'agent.json must be an object' }
  $keys = @($raw.PSObject.Properties | Where-Object { $_.MemberType -eq 'NoteProperty' } | ForEach-Object { $_.Name })
  foreach ($k in $keys) { if (@('schema', 'hub', 'trust', 'intervals', '$comment') -cnotcontains $k) { & $no 'agent.json has an unknown field' } }
  $schema = Get-Prop $raw 'schema'
  if (-not ($schema -is [int] -or $schema -is [long]) -or $schema -ne 1) { & $no 'agent.json -> schema must be 1' }
  $hub = Test-HubOrigin ([string](Get-Prop $raw 'hub'))
  if (-not ((Get-Prop $raw 'hub') -is [string]) -or $null -eq $hub) { & $no 'agent.json -> hub must be an origin: https://<name or IPv4>[:port], or http://127.0.0.1[:port]' }
  $trust = @{ mode = 'system'; pins = @(); caFile = $null }
  $t = Get-Prop $raw 'trust'
  if ($null -ne $t) {
    if (-not ($t -is [Management.Automation.PSCustomObject])) { & $no 'agent.json -> trust is {"pins": [...]} or {"ca": "C:\\...\\hub-ca.pem"}' }
    $tk = @($t.PSObject.Properties | Where-Object { $_.MemberType -eq 'NoteProperty' } | ForEach-Object { $_.Name })
    if ($tk.Count -ne 1) { & $no 'agent.json -> trust is {"pins": [...]} or {"ca": "C:\\...\\hub-ca.pem"}' }
    if ($tk[0] -ceq 'pins') {
      $pins = @(Get-Prop $t 'pins')
      if ($pins.Count -lt 1 -or $pins.Count -gt 2) { & $no 'agent.json -> trust.pins is one or two SHA-256 fingerprints' }
      foreach ($p in $pins) { if (-not ($p -is [string]) -or -not $script:Re['hub:pin'].IsMatch($p) -or $p.EndsWith("`n")) { & $no 'agent.json -> trust.pins is one or two SHA-256 fingerprints (64 lowercase hex)' } }
      if ($pins.Count -eq 2 -and $pins[0] -ceq $pins[1]) { & $no 'agent.json -> trust.pins lists one fingerprint twice' }
      $trust = @{ mode = 'pin'; pins = [string[]]$pins; caFile = $null }
    } elseif ($tk[0] -ceq 'ca') {
      $ca = Get-Prop $t 'ca'
      if (-not ($ca -is [string]) -or $ca.Length -gt 300 -or -not [regex]::IsMatch($ca, '^[A-Za-z]:\\[^\u0000-\u001f"*?<>|]+$')) { & $no 'agent.json -> trust.ca must be an absolute path' }
      $trust = @{ mode = 'ca'; pins = @(); caFile = $ca }
    } else { & $no 'agent.json -> trust is {"pins": [...]} or {"ca": "C:\\...\\hub-ca.pem"}' }
    if (-not $hub.secure) { & $no 'agent.json -> trust is for https:// only' }
  }
  $intervals = [ordered]@{}
  foreach ($p in $script:Rules.intervals.PSObject.Properties) { $intervals[$p.Name] = [int]$p.Value.default }
  $given = Get-Prop $raw 'intervals'
  if ($null -ne $given) {
    if (-not ($given -is [Management.Automation.PSCustomObject])) { & $no 'agent.json -> intervals must be an object of seconds' }
    foreach ($p in $given.PSObject.Properties) {
      if ($p.MemberType -ne 'NoteProperty') { continue }
      $range = Get-Prop $script:Rules.intervals $p.Name
      if ($null -eq $range -or @('heartbeat', 'os', 'updates', 'packages') -cnotcontains $p.Name) { & $no 'agent.json -> intervals names a part the Windows agent does not send' }
      $v = $p.Value
      if (-not ($v -is [int] -or $v -is [long]) -or $v -lt $range.min -or $v -gt $range.max) { & $no ('agent.json -> intervals.' + $p.Name + ' must be ' + $range.min + '-' + $range.max + ' seconds') }
      $intervals[$p.Name] = [int]$v
    }
    foreach ($n in @('updates', 'packages')) {
      $v = Get-Prop $given $n
      if ($null -ne $v -and [int]$v -ne $intervals['os']) { & $no 'agent.json -> intervals: os, updates and packages are one run of the probe; give os only' }
    }
  }
  $intervals['updates'] = $intervals['os']; $intervals['packages'] = $intervals['os']
  return @{ hub = $hub; trust = $trust; intervals = $intervals }
}
# The agent key file: the token alone, a line break allowed -> the token, or $null.
function Read-AgentToken {
  param([string]$Path)
  $raw = [IO.File]::ReadAllText($Path, $script:Utf8Strict).Trim()
  if ([regex]::IsMatch($raw, '^hha_[0-9a-f]{64}$') -and -not $raw.EndsWith("`n")) { return $raw }
  return $null
}
# package.json beside the agent -> its version (semver), or $null.
function Read-AgentVersion {
  param([string]$Path)
  try { $v = Get-Prop (ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path, $script:Utf8Strict))) 'version' } catch { return $null }
  if (-not ($v -is [string]) -or $v.Length -gt 64 -or -not $script:Re['semver'].IsMatch($v) -or $v.EndsWith("`n")) { return $null }
  return $v
}

# --- trust --------------------------------------------------------------------------------------------------------------
# A pin or a private CA is checked by this class, compiled once from this constant text (Add-Type; full language mode
# only). The system store needs nothing: .NET's own validation, chain and name, and nothing turns it off.
#   pins  either SHA-256 of the leaf certificate (DER) matches; the name is not checked (docs/agent.md section 4)
#   ca    the chain ends in exactly this certificate, nothing else is wrong with it (time, signature, usage: the
#         leaf must be valid for server authentication), and the name matches; a certificate that chains to a system
#         root but not to this CA is refused. The intermediates the hub sent in the handshake are used to build the
#         chain (as Node's ca does), so a hub behind an intermediate of the private CA (Caddy's tls internal,
#         step-ca) is accepted.
$script:TrustSource = @'
using System;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
namespace HomeHubAgent {
  public sealed class HubTrust {
    private readonly string[] pins;
    private readonly X509Certificate2 ca;
    public HubTrust(string[] pins, byte[] caDer) {
      this.pins = pins == null ? new string[0] : pins;
      this.ca = caDer == null ? null : new X509Certificate2(caDer);
    }
    public RemoteCertificateValidationCallback Callback { get { return new RemoteCertificateValidationCallback(this.Check); } }
    public static string Sha256Hex(byte[] der) {
      SHA256 h = SHA256.Create();
      byte[] d = h.ComputeHash(der);
      h.Dispose();
      System.Text.StringBuilder s = new System.Text.StringBuilder(64);
      foreach (byte b in d) s.Append(b.ToString("x2"));
      return s.ToString();
    }
    private static bool Same(byte[] a, byte[] b) {
      if (a == null || b == null || a.Length != b.Length) return false;
      int diff = 0;
      for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
      return diff == 0;
    }
    private bool Check(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors errors) {
      bool accepted = false;
      if (certificate == null) return accepted;
      byte[] der = certificate.GetRawCertData();
      if (this.pins.Length > 0) {
        string seen = Sha256Hex(der);
        foreach (string p in this.pins) if (string.Equals(p, seen, StringComparison.Ordinal)) accepted = true;
        return accepted;
      }
      if (this.ca == null) return accepted;
      if ((errors & (SslPolicyErrors.RemoteCertificateNameMismatch | SslPolicyErrors.RemoteCertificateNotAvailable)) != SslPolicyErrors.None) return accepted;
      try {
        X509Chain own = new X509Chain();
        own.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        own.ChainPolicy.VerificationFlags = X509VerificationFlags.AllowUnknownCertificateAuthority;
        own.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.1"));
        own.ChainPolicy.ExtraStore.Add(this.ca);
        if (chain != null) {
          foreach (X509ChainElement e in chain.ChainElements) own.ChainPolicy.ExtraStore.Add(e.Certificate);
          foreach (X509Certificate2 x in chain.ChainPolicy.ExtraStore) own.ChainPolicy.ExtraStore.Add(x);
        }
        own.Build(new X509Certificate2(der));
        if (own.ChainElements.Count < 1) return accepted;
        foreach (X509ChainElement e in own.ChainElements)
          foreach (X509ChainStatus st in e.ChainElementStatus)
            if (st.Status != X509ChainStatusFlags.UntrustedRoot && st.Status != X509ChainStatusFlags.NoError) return accepted;
        accepted = Same(own.ChainElements[own.ChainElements.Count - 1].Certificate.RawData, this.ca.RawData);
      } catch (Exception) { accepted = false; }
      return accepted;
    }
  }
}
'@
# The certificate of a PEM file -> its DER bytes, or $null. The first one: hub-ca.pem holds the CA's root certificate,
# never a bundle (an intermediate comes from the hub during the handshake).
function Read-PemCertificate {
  param([string]$Text)
  $m = [regex]::Match([string]$Text, '-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----')
  if (-not $m.Success) { return $null }
  try { return , [Convert]::FromBase64String(($m.Groups[1].Value -replace '\s', '')) } catch { return $null }
}
# The trust of a configuration -> $null (the system store, or http://127.0.0.1) or a HubTrust. Throws 'ca-invalid'
# or 'trust-unavailable' (Add-Type refused: a constrained language mode).
function New-HubTrust {
  param($Config)
  if (-not $Config.hub.secure -or $Config.trust.mode -ceq 'system') { return $null }
  $caDer = $null
  if ($Config.trust.mode -ceq 'ca') {
    try { $caDer = Read-PemCertificate ([IO.File]::ReadAllText($Config.trust.caFile, $script:Utf8Strict)) } catch { $caDer = $null }
    if ($null -eq $caDer) { throw 'ca-invalid' }
  }
  if (-not ('HomeHubAgent.HubTrust' -as [type])) {
    try { Add-Type -TypeDefinition $script:TrustSource -Language CSharp -ErrorAction Stop } catch { throw 'trust-unavailable' }
  }
  try { return New-Object HomeHubAgent.HubTrust(([string[]]@($Config.trust.pins)), $caDer) } catch { throw 'ca-invalid' }
}

# --- JSON ---------------------------------------------------------------------------------------------------------------
# Written by hand: ConvertTo-Json of Windows PowerShell 5.1 unrolls one-element arrays, stops at depth 2 and writes
# dates as \/Date()\/. This writes strings, whole numbers, booleans, null, ordered dictionaries and arrays, and nothing else.
function ConvertTo-AgentJson {
  param($Value)
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [string]) {
    $e = [regex]::Replace($Value, '[\\"\u0000-\u001f\u007f-\u009f\u2028\u2029]', { param($m) $c = [int][char]$m.Value; if ($c -eq 34) { '\"' } elseif ($c -eq 92) { '\\' } else { '\u' + $c.ToString('x4') } })
    return '"' + $e + '"'
  }
  if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
  if ($Value -is [int] -or $Value -is [long]) { return $Value.ToString($script:Invariant) }
  if ($Value -is [Collections.IDictionary]) {
    $items = New-Object 'Collections.Generic.List[string]'
    foreach ($k in $Value.Keys) { $items.Add((ConvertTo-AgentJson ([string]$k)) + ':' + (ConvertTo-AgentJson $Value[$k])) }
    return '{' + ($items -join ',') + '}'
  }
  if ($Value -is [Collections.IEnumerable]) {
    $items = New-Object 'Collections.Generic.List[string]'
    foreach ($x in $Value) { $items.Add((ConvertTo-AgentJson $x)) }
    return '[' + ($items -join ',') + ']'
  }
  throw 'json: unsupported value'
}

# --- the probe: os ------------------------------------------------------------------------------------------------------
function Get-Cim {
  param([string]$Class, [string]$Namespace = 'root/cimv2', [string]$Filter = $null)
  $a = @{ ClassName = $Class; Namespace = $Namespace; OperationTimeoutSec = $script:CimTimeoutSeconds; ErrorAction = 'Stop' }
  if ($Filter) { $a.Filter = $Filter }
  try { return @(Get-CimInstance @a) } catch { return @() }
}
function Get-RegistryValue {
  param([string]$Path, [string]$Name)
  $base = $null; $key = $null
  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    $key = $base.OpenSubKey($Path, $false)
    if ($null -eq $key) { return $null }
    return $key.GetValue($Name)
  } catch { return $null } finally { if ($key) { $key.Close() }; if ($base) { $base.Close() } }
}
function ConvertTo-State {
  param($Value)
  if ($Value -is [bool]) { if ($Value) { return 'on' } else { return 'off' } }
  $s = [string]$Value
  if ($s -ceq '1' -or $s -ceq 'True') { return 'on' }
  if ($s -ceq '0' -or $s -ceq 'False') { return 'off' }
  return 'unknown'
}
# The os part's lines: HOST first, END ok last. Each read that is not allowed or not there leaves its state unknown.
function Get-OsRecords {
  param([long]$NowMs)
  $out = New-Object 'Collections.Generic.List[string]'
  $who = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $user = ($who -split '\\')[-1]
  $out.Add((Join-Record 'HOST' @((Format-Field $env:COMPUTERNAME 64), $script:Rules.host, (Format-Field $user 64), '0', (Format-Iso $NowMs -Seconds))))
  $os = @(Get-Cim 'Win32_OperatingSystem') | Select-Object -First 1
  $cv = 'SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $display = Get-RegistryValue $cv 'DisplayVersion'; if (-not $display) { $display = Get-RegistryValue $cv 'ReleaseId' }
  $build = [string](Get-RegistryValue $cv 'CurrentBuild'); $ubr = Get-RegistryValue $cv 'UBR'
  if ($build -and $null -ne $ubr) { $build = $build + '.' + [string]$ubr }
  $arch = $env:PROCESSOR_ARCHITEW6432; if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  $arch = @{ AMD64 = 'x64'; ARM64 = 'arm64'; x86 = 'x86' }[[string]$arch]
  if ($os) {
    $caption = ([string]$os.Caption) -replace '^Microsoft\s+', ''
    $out.Add((Join-Record 'OS' @((Format-Field $caption 40), (Format-Field $display 20), (Format-Field $build 80), (Format-Field $os.Version 60), (Format-Field $arch 20))))
  }
  $cs = @(Get-Cim 'Win32_ComputerSystem') | Select-Object -First 1
  $cpu = @(Get-Cim 'Win32_Processor') | Select-Object -First 1
  if ($cs) {
    $model = (([string]$cs.Manufacturer) + ' ' + ([string]$cs.Model)).Trim()
    $cpuName = ''; if ($cpu) { $cpuName = $cpu.Name }
    $out.Add((Join-Record 'HW' @((Format-Field $model 60), (Format-Field $cpuName 80), (Format-Field $cs.TotalPhysicalMemory 20), (Format-Field $cs.NumberOfLogicalProcessors 20))))
  }
  if ($os -and $os.LastBootUpTime -is [DateTime]) {
    $up = [long]([DateTime]::UtcNow - $os.LastBootUpTime.ToUniversalTime()).TotalSeconds
    if ($up -ge 0) { $out.Add((Join-Record 'UPTIME' @([string]$up))) }
  }
  # Defender: real-time protection and the age of the signatures in days (65535 or more: never updated, not a number).
  $mp = @(Get-Cim 'MSFT_MpComputerStatus' 'root/Microsoft/Windows/Defender') | Select-Object -First 1
  if ($mp) {
    $age = ''; if ($null -ne $mp.AntivirusSignatureAge -and [long]$mp.AntivirusSignatureAge -lt 65535) { $age = [string][long]$mp.AntivirusSignatureAge }
    $out.Add((Join-Record 'DEFENDER' @((ConvertTo-State $mp.RealTimeProtectionEnabled), $age)))
  } else { $out.Add((Join-Record 'DEFENDER' @('unknown', ''))) }
  # BitLocker: each volume with a drive letter. Without the right to read the class (or without BitLocker), unknown.
  $bl = @(Get-Cim 'Win32_EncryptableVolume' 'root/CIMV2/Security/MicrosoftVolumeEncryption')
  if ($bl.Count) {
    foreach ($v in @($bl | Where-Object { $_.DriveLetter } | Sort-Object DriveLetter | Select-Object -First 26)) {
      $st = 'unknown'; if ($v.ProtectionStatus -eq 1) { $st = 'on' } elseif ($v.ProtectionStatus -eq 0) { $st = 'off' }
      $out.Add((Join-Record 'BITLOCKER' @((Format-Field $v.DriveLetter 8), $st)))
    }
  } else {
    foreach ($d in @(Get-Cim 'Win32_LogicalDisk' -Filter 'DriveType = 3' | Sort-Object DeviceID | Select-Object -First 26)) {
      $out.Add((Join-Record 'BITLOCKER' @((Format-Field $d.DeviceID 8), 'unknown')))
    }
  }
  # Windows Firewall: each profile's Enabled in the active store (what is in force: the local setting with Group Policy
  # over it; the CIM class alone reads the local store, which Group Policy may contradict). True/1 on, False/0 off,
  # NotConfigured/2 unknown. The read is bounded like every CIM read here: it goes over a local DCOM CimSession whose
  # operations time out after $script:CimTimeoutSeconds, so a hung provider cannot stall the loop and its heartbeat.
  # Not readable in time (or at all): each profile unknown.
  $profiles = $null; $fwSession = $null
  try {
    $fwSession = New-CimSession -SessionOption (New-CimSessionOption -Protocol Dcom) -OperationTimeoutSec $script:CimTimeoutSeconds -ErrorAction Stop
    $profiles = @(Get-NetFirewallProfile -CimSession $fwSession -PolicyStore ActiveStore -ErrorAction Stop)
  } catch { $profiles = $null } finally { if ($fwSession) { Remove-CimSession -CimSession $fwSession -ErrorAction SilentlyContinue } }
  if ($null -eq $profiles) {
    foreach ($name in @('domain', 'private', 'public')) { $out.Add((Join-Record 'WINFW' @($name, 'unknown'))) }
  } else {
    foreach ($fw in $profiles) {
      $name = ([string]$fw.Name).ToLowerInvariant()
      if (@('domain', 'private', 'public') -ccontains $name) { $out.Add((Join-Record 'WINFW' @($name, (ConvertTo-State $fw.Enabled)))) }
    }
  }
  # Remote Desktop: fDenyTSConnections, a policy over the setting. 0 allows connections.
  $deny = Get-RegistryValue 'SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' 'fDenyTSConnections'
  if ($null -eq $deny) { $deny = Get-RegistryValue 'SYSTEM\CurrentControlSet\Control\Terminal Server' 'fDenyTSConnections' }
  $rdp = 'unknown'; if ($null -ne $deny) { if ([int]$deny -eq 0) { $rdp = 'on' } else { $rdp = 'off' } }
  $out.Add((Join-Record 'RDP' @($rdp)))
  # Listening TCP ports with the owning process's name (the account that owns it is not readable without admin rights).
  $names = @{}
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) { $names[[int]$p.Id] = $p.ProcessName }
  $seen = @{}
  foreach ($c in @(Get-Cim 'MSFT_NetTCPConnection' 'root/StandardCimv2' -Filter 'State = 2' | Sort-Object LocalPort, LocalAddress | Select-Object -First 300)) {
    $addr = [string]$c.LocalAddress
    if ($addr.Contains(':')) { $addr = '[' + $addr + ']' }
    $addr = $addr + ':' + [string]$c.LocalPort
    $proc = '?'; if ($names.ContainsKey([int]$c.OwningProcess)) { $proc = $names[[int]$c.OwningProcess] }
    $key = $proc + '|' + $addr
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $out.Add((Join-Record 'LISTEN' @((Format-Field $proc 60), '', (Format-Field $addr 64))))
  }
  $out.Add('END' + "`t" + 'ok')
  return , $out.ToArray()
}

# --- the probe: updates -------------------------------------------------------------------------------------------------
# The Windows Update Agent's search of what it already knows (Online = false: its own cache, as the last scan Windows
# made left it), in a job of its own so that a search that hangs can be stopped. Its lines come back as text.
# An update offered only for browsing (an optional or preview update, a driver) is not pending and is left out. An empty
# answer is an all-clear only when Windows' own last successful search is recent (UpdateSearchMaxAgeDays): a device
# that never searched, or not for days (switched off, a broken or WSUS-blocked scan), has an empty cache, and that is
# sent as WINUP_ERR, never as WINUP_NONE.
$script:UpdateSearch = {
  param([int]$MaxAgeDays)
  $ErrorActionPreference = 'Stop'
  try {
    $session = New-Object -ComObject 'Microsoft.Update.Session'
    $session.ClientApplicationID = 'home-hub-agent'
    $searcher = $session.CreateUpdateSearcher()
    $searcher.Online = $false
    $result = $searcher.Search('IsInstalled=0 and IsHidden=0')
    $lines = New-Object 'Collections.Generic.List[string]'
    foreach ($u in $result.Updates) {
      if ($u.BrowseOnly) { continue }
      $kb = ''
      if ($u.KBArticleIDs.Count -gt 0) { $kb = 'KB' + [string]$u.KBArticleIDs.Item(0) }
      $severity = [string]$u.MsrcSeverity
      if (@('Critical', 'Important', 'Moderate', 'Low') -cnotcontains $severity) { $severity = 'Unspecified' }
      $restart = '0'
      if ($u.InstallationBehavior.RebootBehavior -ne 0) { $restart = '1' }
      $title = (([string]$u.Title) -replace '[\u0000-\u001f\u007f-\u009f]', ' ').Trim()
      if ($title.Length -gt 200) { $title = $title.Substring(0, 200).TrimEnd() }
      $lines.Add('WINUP' + "`t" + $kb + "`t" + $title + "`t" + $severity + "`t" + $restart)
    }
    if ($lines.Count -eq 0) {
      $last = $null
      try { $last = (New-Object -ComObject 'Microsoft.Update.AutoUpdate').Results.LastSearchSuccessDate } catch { $last = $null }
      if (-not ($last -is [DateTime]) -or $last.Year -lt 2000) { $lines.Add('WINUP_ERR' + "`t" + 'no successful search by Windows Update known') }
      elseif (([DateTime]::UtcNow - $last).TotalDays -gt $MaxAgeDays) { $lines.Add('WINUP_ERR' + "`t" + ('last successful search by Windows Update ' + $last.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture))) }
      else { $lines.Add('WINUP_NONE') }
    }
    $lines.ToArray()
  } catch {
    $hr = 0
    try { $hr = $_.Exception.HResult } catch { $hr = 0 }
    'WINUP_ERR' + "`t" + ('search failed (0x{0:x8})' -f $hr)
  }
}
function Start-UpdateSearch {
  try { return Start-Job -ScriptBlock $script:UpdateSearch -ArgumentList $script:UpdateSearchMaxAgeDays } catch { return $null }
}
# The job -> its lines once it is done; $null while it runs and its time is not up. A job past its time is stopped.
function Receive-UpdateSearch {
  param($Job, [long]$StartedMs, [long]$NowMs, [switch]$Wait)
  if ($null -eq $Job) { return , @('WINUP_ERR' + "`t" + 'search unavailable (no background job)') }
  if ($Wait) { $null = Wait-Job -Job $Job -Timeout ([int]$script:UpdateTimeoutSeconds) }
  $done = @('Completed', 'Failed', 'Stopped') -contains [string]$Job.State
  if (-not $done -and $NowMs - $StartedMs -lt $script:UpdateTimeoutSeconds * 1000 -and -not $Wait) { return $null }
  if (-not $done) {
    Stop-Job -Job $Job -ErrorAction SilentlyContinue
    Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue
    return , @('WINUP_ERR' + "`t" + 'search timed out')
  }
  $lines = @()
  try { $lines = @(Receive-Job -Job $Job -ErrorAction Stop | ForEach-Object { [string]$_ }) } catch { $lines = @() }
  Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue
  $lines = @($lines | Where-Object { $_ -cmatch '^WINUP(_NONE|_ERR)?(\t|$)' })
  if (-not $lines.Count) { return , @('WINUP_ERR' + "`t" + 'search returned nothing') }
  return , $lines
}

# --- the probe: packages ------------------------------------------------------------------------------------------------
# The system-wide uninstall entries (HKLM, the 64- and 32-bit views), read once per run.
function Get-UninstallEntries {
  $list = New-Object 'Collections.Generic.List[object]'
  $views = @(@{ view = [Microsoft.Win32.RegistryView]::Registry64; name = 'x64' }, @{ view = [Microsoft.Win32.RegistryView]::Registry32; name = 'x86' })
  if (-not [Environment]::Is64BitOperatingSystem) { $views = @(@{ view = [Microsoft.Win32.RegistryView]::Registry32; name = 'x86' }) }
  foreach ($v in $views) {
    $base = $null; $key = $null
    try {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $v.view)
      $key = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', $false)
      if ($null -eq $key) { continue }
      foreach ($name in $key.GetSubKeyNames()) {
        $sub = $null
        try {
          $sub = $key.OpenSubKey($name, $false)
          if ($null -eq $sub) { continue }
          $dn = [string]$sub.GetValue('DisplayName')
          if ($dn) { $list.Add(@{ name = $dn; version = [string]$sub.GetValue('DisplayVersion'); view = $v.name }) }
        } catch { } finally { if ($sub) { $sub.Close() } }
      }
    } catch { } finally { if ($key) { $key.Close() }; if ($base) { $base.Close() } }
  }
  return , $list.ToArray()
}
# Does a display name of the watch list match a DisplayName? The whole name, ignoring case (ordinal); * any run of
# characters. The pieces between the * are found leftmost first with a plain search, which is exact for a pattern whose
# only wildcard is * and never backtracks: no regular expression, so no rule can stall the agent's loop.
# scripts/agent/windows/specs.mjs (matchDisplayName) is the same in JavaScript; vectors.json -> names holds both.
function Test-DisplayName {
  param([string]$Pattern, [string]$Name)
  $cmp = [StringComparison]::OrdinalIgnoreCase
  $pieces = $Pattern.Split([char]'*')
  if ($pieces.Count -eq 1) { return [string]::Equals($Name, $Pattern, $cmp) }
  $first = $pieces[0]; $last = $pieces[$pieces.Count - 1]
  if ($Name.Length -lt $first.Length + $last.Length -or -not $Name.StartsWith($first, $cmp) -or -not $Name.EndsWith($last, $cmp)) { return $false }
  $pos = $first.Length; $end = $Name.Length - $last.Length
  for ($i = 1; $i -lt $pieces.Count - 1; $i++) {
    $piece = $pieces[$i]
    if ($piece.Length -eq 0) { continue }
    $at = $Name.IndexOf($piece, $pos, $cmp)
    if ($at -lt 0 -or $at + $piece.Length -gt $end) { return $false }
    $pos = $at + $piece.Length
  }
  return $true
}
# How many SW lines one winreg rule may print: 10, fewer when the list is long, so that every rule's first SW, every
# RUN and SPECS always fit under the packages cap (a run over the cap would send no part at all).
function Get-HitsPerRule {
  param([int]$Rules, [int]$Labels, [int]$Cap)
  if ($Rules -le 0) { return 10 }
  return [int][Math]::Max(1.0, [Math]::Min(10.0, [Math]::Floor(($Cap - 1 - $Labels - $Rules) / $Rules) + 1))
}
# The packages part's lines for the checked watch list: SW (and RUN for a line with a service), then SPECS.
function Get-PackageRecords {
  param([string[]]$SpecsLines, [string]$SpecsSha256)
  $out = New-Object 'Collections.Generic.List[string]'
  $entries = @()
  # Assigned, never wrapped in @(): Get-UninstallEntries returns its array as one object (return , ...), and @() of
  # that is an array of one element, the whole list (found on Windows PowerShell 5.1: no rule could match an entry).
  if (@($SpecsLines).Count) { $entries = Get-UninstallEntries }
  $labels = @(@($SpecsLines) | Where-Object { $_.Split([char]'|')[4] -cne '' }).Count
  $perRule = Get-HitsPerRule @($SpecsLines).Count $labels ([int](Get-Prop $script:Rules.caps 'packages'))
  $services = $null
  foreach ($line in @($SpecsLines)) {
    $f = $line.Split([char]'|')
    $id = $f[0]; $kind = $f[1]; $label = $f[4]
    if ($kind -ceq 'winreg') {
      $pattern = $f[2]
      $hits = @($entries | Where-Object { Test-DisplayName $pattern $_.name } | Sort-Object { $_.name }, { $_.version }, { $_.view } | Select-Object -First $perRule)
      if ($hits.Count) { foreach ($h in $hits) { $out.Add((Join-Record 'SW' @($id, 'app', (Format-Field $h.version 300), (Format-Field $h.name 300), $h.view))) } }
      else { $out.Add((Join-Record 'SW' @($id, 'missing', '', (Format-Field $f[2] 300)))) }
    } else { $out.Add((Join-Record 'SW' @($id, 'unsupported', '', (Format-Field $kind 300)))) }
    if ($label -cne '') {
      if ($null -eq $services) {
        $services = @{}
        foreach ($s in @(Get-Cim 'Win32_Service')) { $services[[string]$s.Name] = $s }
      }
      # Service names are case-insensitive on Windows, and so is this table.
      $svc = $services[$label]
      if ($null -eq $svc) { $state = 'absent' }
      elseif ([string]$svc.State -ceq 'Running' -and [long]$svc.ProcessId -gt 0) { $state = [string][long]$svc.ProcessId }
      else { $state = 'loaded' }
      $out.Add((Join-Record 'RUN' @($id, $state, (Format-Field $label 120))))
    }
  }
  $out.Add('SPECS' + "`t" + $SpecsSha256)
  return , $out.ToArray()
}

# --- the systems parts --------------------------------------------------------------------------------------------------
# os, updates and packages from one run, each checked line by line -> @{ok; parts} or @{ok = $false; error}.
function New-SystemsParts {
  param([long]$CollectedMs, [int]$Interval, [string[]]$Os, [string[]]$Updates, [string[]]$Packages)
  $parts = [ordered]@{}
  $lines = @{ os = $Os; updates = $Updates; packages = $Packages }
  foreach ($name in @('os', 'updates', 'packages')) {
    $c = Select-PartRecords $name $lines[$name]
    if ($c.records.Count -gt [int](Get-Prop $script:Rules.caps $name)) { return @{ ok = $false; error = 'too-large' } }
    $p = [ordered]@{ schema = 1; collectedAt = (Format-Iso $CollectedMs); interval = $Interval; records = $c.records }
    if ($c.withheld.Count) { $p['withheld'] = $c.withheld }
    $parts[$name] = $p
  }
  $os = $parts['os'].records
  $hosts = @($os | Where-Object { $_.StartsWith("HOST`t") })
  $ends = @($os | Where-Object { $_.Split([char]9)[0] -ceq 'END' })
  if ($hosts.Count -ne 1 -or $hosts[0].Split([char]9)[2] -cne $script:Rules.host -or $ends.Count -ne 1 -or $os[$os.Count - 1] -cne "END`tok") { return @{ ok = $false; error = 'probe-incomplete' } }
  return @{ ok = $true; parts = $parts }
}

# --- transport ----------------------------------------------------------------------------------------------------------
# Retry-After as whole seconds (1-3600), or $null.
function Get-RetryAfter {
  param([string]$Value)
  if ($null -eq $Value -or -not [regex]::IsMatch($Value.Trim(), '^[0-9]{1,6}$')) { return $null }
  return [int][Math]::Min([Math]::Max(1, [int]$Value.Trim()), 3600)
}
# The acknowledgement of a 200, reduced to the parts that were sent -> @{receivedAt; accepted; refused}. Never throws.
function Read-Ack {
  param([string]$Body, [string[]]$Sent)
  $out = @{ receivedAt = $null; accepted = @(); refused = @() }
  $raw = $null
  try { $raw = ConvertFrom-Json -InputObject $Body } catch { return $out }
  if (-not ($raw -is [Management.Automation.PSCustomObject])) { return $out }
  $at = Get-Prop $raw 'receivedAt'
  if ($at -is [string] -and [regex]::IsMatch($at, '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$')) { $out.receivedAt = $at }
  foreach ($p in @(Get-Prop $raw 'accepted')) { if ($p -is [string] -and $Sent -ccontains $p -and $out.accepted -cnotcontains $p) { $out.accepted += , $p } }
  foreach ($r in @(Get-Prop $raw 'refused' | Select-Object -First 32)) {
    if (-not ($r -is [Management.Automation.PSCustomObject])) { continue }
    $part = Get-Prop $r 'part'; $code = Get-Prop $r 'code'
    if (-not ($part -is [string]) -or $Sent -cnotcontains $part -or @($script:Rules.partCodes) -cnotcontains $code -or $out.accepted -ccontains $part) { continue }
    if (@($out.refused | Where-Object { $_.part -ceq $part }).Count) { continue }
    $ref = [ordered]@{ part = $part; code = [string]$code }
    $tag = Get-Prop $r 'tag'; if ($tag -is [string] -and $script:Re['tag'].IsMatch($tag)) { $ref['tag'] = $tag }
    $field = Get-Prop $r 'field'; if (($field -is [int] -or $field -is [long]) -and $field -ge 0 -and $field -le 64) { $ref['field'] = [int]$field }
    $out.refused += , $ref
  }
  return $out
}
function Get-NetErrorCode {
  param($Exception)
  $e = $Exception
  while ($null -ne $e -and -not ($e -is [Net.WebException])) { $e = $e.InnerException }
  if ($null -eq $e) { return 'error' }
  switch ([string]$e.Status) {
    'TrustFailure' { return 'tls-untrusted' }
    'SecureChannelFailure' { return 'tls' }
    'NameResolutionFailure' { return 'unresolved' }
    'ConnectFailure' { return 'refused' }
    'Timeout' { return 'timeout' }
    default { return 'network' }
  }
}
# TLS 1.2 at least, once at start. SystemDefault (0, .NET 4.7 and later) leaves the choice to Windows, which offers TLS
# 1.2 and, where it has it, 1.3: kept. An older .NET's fixed list (SSL 3 and TLS 1.0) gains TLS 1.2 and loses SSL 3.
# Never set to Tls12 alone: that would turn TLS 1.3 off where Windows has it.
function Set-AgentTls {
  $now = [int][Net.ServicePointManager]::SecurityProtocol
  if ($now -eq 0) { return }
  $want = ($now -bor [int][Net.SecurityProtocolType]::Tls12) -band (-bnot [int][Net.SecurityProtocolType]::Ssl3)
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]$want
}
# One POST of an envelope -> @{status; retryAfter; ack; error}. The key ($script:Token, never a parameter) goes into the
# Authorization header and nowhere else. Trust is checked during the TLS handshake, before a byte of the request is
# written; no redirect is followed, nothing compressed is read, the answer is capped at 64 KiB, and there is a deadline.
function Send-AgentReport {
  param($Config, [byte[]]$Body, [string[]]$Sent)
  if ($null -eq $script:Token) { return @{ status = 0; retryAfter = $null; ack = $null; error = 'key-missing' } }
  $req = [Net.HttpWebRequest][Net.WebRequest]::Create($Config.hub.origin + '/api/agent/report')
  $req.Method = 'POST'
  $req.ContentType = 'application/json'
  $req.Accept = 'application/json'
  $req.UserAgent = 'home-hub-agent'
  $req.AllowAutoRedirect = $false
  $req.AutomaticDecompression = [Net.DecompressionMethods]::None
  $req.Timeout = 30000
  $req.ReadWriteTimeout = 30000
  $req.KeepAlive = $false
  $req.Proxy = $null
  $req.ServicePoint.Expect100Continue = $false
  if ($null -ne $script:Trust) { $req.ServerCertificateValidationCallback = $script:Trust.Callback }
  $req.Headers.Add('Authorization', 'Bearer ' + $script:Token)
  $req.ContentLength = $Body.Length
  $resp = $null
  try {
    $stream = $req.GetRequestStream()
    try { $stream.Write($Body, 0, $Body.Length) } finally { $stream.Close() }
    $resp = [Net.HttpWebResponse]$req.GetResponse()
  } catch {
    $e = $_.Exception
    while ($null -ne $e -and -not ($e -is [Net.WebException])) { $e = $e.InnerException }
    if ($null -ne $e -and $null -ne $e.Response) { $resp = [Net.HttpWebResponse]$e.Response }
    else { return @{ status = 0; retryAfter = $null; ack = $null; error = (Get-NetErrorCode $_.Exception) } }
  }
  try {
    $status = [int]$resp.StatusCode
    $retry = Get-RetryAfter $resp.Headers['Retry-After']
    if ($status -ne 200) { return @{ status = $status; retryAfter = $retry; ack = $null; error = $null } }
    $in = $resp.GetResponseStream()
    $buf = New-Object byte[] 65537
    $total = 0
    try {
      while ($total -lt $buf.Length) {
        $n = $in.Read($buf, $total, $buf.Length - $total)
        if ($n -le 0) { break }
        $total += $n
      }
    } finally { $in.Close() }
    if ($total -gt 65536) { return @{ status = 0; retryAfter = $null; ack = $null; error = 'too-large' } }
    $text = $script:Utf8.GetString($buf, 0, $total)
    return @{ status = 200; retryAfter = $null; ack = (Read-Ack $text $Sent); error = $null }
  } catch {
    return @{ status = 0; retryAfter = $null; ack = $null; error = (Get-NetErrorCode $_.Exception) }
  } finally { $resp.Close() }
}

# --- files ----------------------------------------------------------------------------------------------------------------
# The one writer: status.json and the log, inside the directories the agent was started with, nothing else.
function Write-AgentFile {
  param([string]$Path, [string]$Text, [switch]$Append)
  $full = [IO.Path]::GetFullPath($Path)
  $inside = $false
  foreach ($d in $script:WritableDirs) {
    $dir = [IO.Path]::GetFullPath($d).TrimEnd([char]'\', [char]'/') + [IO.Path]::DirectorySeparatorChar
    if ($full.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) -and $full.IndexOf([IO.Path]::DirectorySeparatorChar, $dir.Length) -lt 0) { $inside = $true }
  }
  if (-not $inside) { throw 'write-outside-state' }
  if ($Append) {
    $info = New-Object IO.FileInfo($full)
    if ($info.Exists -and $info.Length -gt 1048576) {
      if ([IO.File]::Exists($full + '.1')) { [IO.File]::Delete($full + '.1') }
      [IO.File]::Move($full, $full + '.1')
    }
    [IO.File]::AppendAllText($full, $Text, $script:Utf8)
    return
  }
  $tmp = $full + '.' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.tmp'
  try {
    [IO.File]::WriteAllText($tmp, $Text, $script:Utf8)
    # No backup: [NullString]::Value, because PowerShell passes $null to a .NET string parameter as "" ("The path is
    # not of a legal form", seen on Windows PowerShell 5.1: no status.json after the first).
    if ([IO.File]::Exists($full)) { [IO.File]::Replace($tmp, $full, [NullString]::Value) } else { [IO.File]::Move($tmp, $full) }
  } finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
}
function Write-AgentLog {
  param([string]$Message)
  $line = (Format-Iso (Get-NowMs)) + ' ' + (Format-Field $Message 400)
  if ($script:LogFile) { try { Write-AgentFile -Path $script:LogFile -Text ($line + "`r`n") -Append; return } catch { } }
  [Console]::Error.WriteLine($line)
}
# status.json, the Node agent's shape: {lastAttemptAt, lastAcceptedAt, lastError, parts: {<part>: {lastSentAt, lastAcceptedAt, lastRefused}}}.
function ConvertTo-StatusText {
  param($Status)
  $parts = [ordered]@{}
  foreach ($name in @($Status.parts.Keys | Sort-Object)) {
    $p = $Status.parts[$name]
    $parts[$name] = [ordered]@{ lastSentAt = $p.lastSentAt; lastAcceptedAt = $p.lastAcceptedAt; lastRefused = $p.lastRefused }
  }
  return (ConvertTo-AgentJson ([ordered]@{ lastAttemptAt = $Status.lastAttemptAt; lastAcceptedAt = $Status.lastAcceptedAt; lastError = $Status.lastError; parts = $parts })) + "`n"
}

# --- the agent ----------------------------------------------------------------------------------------------------------
# Everything checked at start -> @{ok; setup} or @{ok = $false; error; detail}. Nothing runs before this passes.
# AgentDir holds report-rules.json; VersionFile is the package.json whose version is agentVersion (the installed copy's
# beside it, a checkout's at its root: home-hub-agent.ps1 says which). The key, unless -NoKey, goes into $script:Token
# and not into the setup.
function Initialize-Agent {
  param([string]$AgentDir, [string]$VersionFile, [string]$ConfigDir, [string]$KeyFile, [switch]$NoKey)
  $no = { param($e, $d) return @{ ok = $false; error = $e; detail = $d } }
  $script:Token = $null
  try { Import-AgentRules (Join-Path $AgentDir 'report-rules.json') } catch { return (& $no 'rules-invalid' 'report-rules.json is missing or not schema 1') }
  $version = Read-AgentVersion $VersionFile
  if ($null -eq $version) { return (& $no 'version' ('cannot read the version (' + $VersionFile + ')')) }
  Set-AgentTls
  try { $text = [IO.File]::ReadAllText((Join-Path $ConfigDir 'agent.json'), $script:Utf8Strict) } catch { return (& $no 'config-invalid' 'cannot read agent.json') }
  # Read-AgentConfig throws 'config-invalid: <why>': the detail is the why (the log line names the error once).
  try { $config = Read-AgentConfig $text } catch { return (& $no 'config-invalid' (([string]$_.Exception.Message) -replace '^config-invalid: ', '')) }
  try { $bytes = [IO.File]::ReadAllBytes((Join-Path $ConfigDir 'specs.txt')) } catch { return (& $no 'specs-invalid' 'cannot read specs.txt') }
  $specs = Read-AgentSpecs $bytes
  if (-not $specs.ok) { return (& $no 'specs-invalid' ((@($specs.errors | Select-Object -First 20) | ForEach-Object { 'line ' + $_.line + ': ' + $_.reason }) -join '; ')) }
  try { $script:Trust = New-HubTrust $config } catch { return (& $no ([string]$_.Exception.Message) 'cannot use the trust of agent.json') }
  if (-not $NoKey) {
    if (-not [IO.File]::Exists($KeyFile)) { return (& $no 'key-missing' 'no key file') }
    try { $script:Token = Read-AgentToken $KeyFile } catch { $script:Token = $null }
    if ($null -eq $script:Token) { return (& $no 'key-invalid' 'the key file does not hold an agent key') }
  }
  return @{ ok = $true; setup = @{ config = $config; specsLines = $specs.lines; specsSha256 = (Get-Sha256Hex $bytes); version = $version } }
}
function New-AgentStatus {
  $parts = @{}
  foreach ($p in @('heartbeat', 'os', 'updates', 'packages')) { $parts[$p] = @{ lastSentAt = $null; lastAcceptedAt = $null; lastRefused = $null } }
  return @{ lastAttemptAt = $null; lastAcceptedAt = $null; lastError = $null; parts = $parts }
}
function Save-AgentStatus {
  param($Status, [string]$StateDir)
  if (-not $StateDir) { return }
  try { Write-AgentFile -Path (Join-Path $StateDir 'status.json') -Text (ConvertTo-StatusText $Status) } catch { Write-AgentLog ('status.json not written: ' + $_.Exception.Message) }
}
# An interval in ms with +-10 % jitter, never below the part's minimum.
function Get-Jittered {
  param([string]$Part, [int]$Seconds)
  $min = [int](Get-Prop $script:Rules.intervals $Part).min
  $j = $Seconds * (0.9 + 0.2 * (Get-Random -Minimum 0.0 -Maximum 1.0))
  return [long]([Math]::Max($min, $j) * 1000)
}
function New-Envelope {
  param($Setup, [long]$SentMs, $Parts)
  return [ordered]@{ v = 1; agentVersion = $Setup.version; platform = 'windows'; sentAt = (Format-Iso $SentMs); parts = $Parts }
}
# Collects every part once, waiting for the update search -> the envelope (an ordered dictionary), or @{error}.
function Invoke-AgentCollectOnce {
  param($Setup)
  $t = Get-NowMs
  $job = Start-UpdateSearch
  $updates = Receive-UpdateSearch $job $t (Get-NowMs) -Wait
  $os = Get-OsRecords $t
  $packages = Get-PackageRecords $Setup.specsLines $Setup.specsSha256
  $parts = [ordered]@{ heartbeat = [ordered]@{ schema = 1; interval = [int]$Setup.config.intervals['heartbeat'] } }
  $sys = New-SystemsParts $t ([int]$Setup.config.intervals['os']) $os $updates $packages
  if ($sys.ok) { foreach ($k in $sys.parts.Keys) { $parts[$k] = $sys.parts[$k] } }
  else { [Console]::Error.WriteLine('systems: ' + $sys.error) }
  return (New-Envelope $Setup (Get-NowMs) $parts)
}
# The loop (scripts/agent/agent.mjs, createAgent): each part by its interval with jitter; what falls due within 20 s of
# another goes in one report; at most one report per 20 s. A network error or 5xx doubles the wait from 30 s to 15 min,
# 429 waits Retry-After, 401 tries again in an hour, 400/403/409/413 wait for the next interval. Runs until stopped.
# Every wait is measured on a monotonic clock (a Stopwatch: $t and every *Due, *SentMs, blockedUntil), so a wall clock
# that jumps back (time sync after boot, a fast hardware clock) never stops the reports; the wall clock (Get-NowMs) is
# read only for what is written down: sentAt (just before the envelope is built), collectedAt, HOST's time, status.json.
function Invoke-AgentLoop {
  param($Setup, [string]$StateDir)
  $config = $Setup.config
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $floorMs = [long]$script:Rules.limits.floorSeconds * 1000
  $status = New-AgentStatus
  $start = [long]$clock.ElapsedMilliseconds
  $hb = @{ id = 'heartbeat'; parts = @('heartbeat'); interval = [int]$config.intervals['heartbeat']; nextDue = $start; lastSentMs = [long]-1000000000000000; ready = $null }
  $sys = @{ id = 'systems'; parts = @('os', 'updates', 'packages'); interval = [int]$config.intervals['os']; nextDue = $start; lastSentMs = [long]-1000000000000000; ready = $null; readyAt = 0; job = $null; jobStarted = 0; jobStartedWall = 0; running = $false }
  $minMs = @{ heartbeat = [long](Get-Prop $script:Rules.intervals 'heartbeat').min * 1000; systems = [long](Get-Prop $script:Rules.intervals 'os').min * 1000 }
  $blockedUntil = 0; $backoff = 0; $lastSendMs = [long]-1000000000000000
  while ($true) {
    $t = [long]$clock.ElapsedMilliseconds
    # A collected run waits for a send at most one interval; after that it is collected again.
    if ($null -ne $sys.ready -and $t - $sys.readyAt -gt $sys.interval * 1000) { $sys.ready = $null; $sys.nextDue = $t }
    if (-not $sys.running -and $null -eq $sys.ready -and $sys.nextDue -le $t + $floorMs) {
      $sys.job = Start-UpdateSearch; $sys.jobStarted = $t; $sys.jobStartedWall = Get-NowMs; $sys.running = $true
    }
    if ($sys.running) {
      $updates = Receive-UpdateSearch $sys.job $sys.jobStarted $t
      if ($null -ne $updates) {
        $sys.running = $false; $sys.job = $null
        $began = $sys.jobStarted; $beganWall = $sys.jobStartedWall
        try {
          $os = Get-OsRecords $beganWall
          $packages = Get-PackageRecords $Setup.specsLines $Setup.specsSha256
          $r = New-SystemsParts $beganWall $sys.interval $os $updates $packages
        } catch { $r = @{ ok = $false; error = 'collect-failed' } }
        if ($r.ok) { $sys.ready = $r.parts; $sys.readyAt = $began }
        else {
          $sys.nextDue = [long]$clock.ElapsedMilliseconds + [Math]::Min($sys.interval, 900) * 1000
          $status.lastError = $r.error; Write-AgentLog ('systems: ' + $r.error); Save-AgentStatus $status $StateDir
        }
      }
    }
    # The collection above may have taken a while (CIM reads time out after 30 s each): the clock is read again.
    $t = [long]$clock.ElapsedMilliseconds
    if ($t -ge $blockedUntil -and $t -ge $lastSendMs + $floorMs) {
      $chosen = @()
      $hbOk = ($t - $hb.lastSentMs -ge $minMs.heartbeat); $sysOk = ($t - $sys.lastSentMs -ge $minMs.systems)
      $sysReady = ($null -ne $sys.ready -and $sysOk)
      $hbDue = ($hb.nextDue -le $t + $floorMs -and $hbOk)
      if ($sysReady -or ($hbDue -and $hb.nextDue -le $t)) {
        if ($hbDue) { $chosen += , $hb }
        if ($sysReady) { $chosen += , $sys }
      }
      if ($chosen.Count) {
        $parts = [ordered]@{}
        foreach ($g in $chosen) {
          if ($g.id -ceq 'heartbeat') { $parts['heartbeat'] = [ordered]@{ schema = 1; interval = $g.interval } }
          else { foreach ($k in $g.ready.Keys) { $parts[$k] = $g.ready[$k] } }
        }
        $sent = @($parts.Keys | ForEach-Object { [string]$_ })
        $sentWall = Get-NowMs
        $body = $script:Utf8.GetBytes((ConvertTo-AgentJson (New-Envelope $Setup $sentWall $parts)))
        if ($body.Length -gt [int]$script:Rules.limits.body) {
          foreach ($g in $chosen) { $g.ready = $null; $g.nextDue = $t + (Get-Jittered $g.parts[0] $g.interval) }
          $status.lastError = 'report-too-large'; Write-AgentLog 'report-too-large'; Save-AgentStatus $status $StateDir
        } else {
          $status.lastAttemptAt = Format-Iso $sentWall; $lastSendMs = $t
          $r = Send-AgentReport $config $body $sent
          $after = [long]$clock.ElapsedMilliseconds; $afterWall = Get-NowMs
          if ($r.status -eq 200) {
            $backoff = 0
            foreach ($g in $chosen) {
              foreach ($p in $g.parts) {
                $s = $status.parts[$p]; $s.lastSentAt = Format-Iso $sentWall
                if ($r.ack.accepted -ccontains $p) { $s.lastAcceptedAt = Format-Iso $afterWall; $s.lastRefused = $null }
                else {
                  $ref = @($r.ack.refused | Where-Object { $_.part -ceq $p }) | Select-Object -First 1
                  if ($ref) { $x = [ordered]@{ code = $ref.code }; if ($ref.Contains('tag')) { $x['tag'] = $ref.tag }; if ($ref.Contains('field')) { $x['field'] = $ref.field }; $s.lastRefused = $x }
                  else { $s.lastRefused = [ordered]@{ code = 'unanswered' } }
                }
              }
              $g.lastSentMs = $t
              if ($g.id -ceq 'heartbeat') { $g.nextDue = $t + (Get-Jittered 'heartbeat' $g.interval) } else { $g.nextDue = $g.readyAt + (Get-Jittered 'os' $g.interval) }
              $g.ready = $null
            }
            if ($r.ack.accepted.Count) { $status.lastAcceptedAt = Format-Iso $afterWall; $status.lastError = $null } else { $status.lastError = 'refused' }
            $refusedText = (@($r.ack.refused) | ForEach-Object { $_.part + ' ' + $_.code }) -join ', '
            Write-AgentLog ('sent ' + ($sent -join ',') + ': 200, accepted ' + (@($r.ack.accepted) -join ',') + $(if ($refusedText) { ', refused ' + $refusedText } else { '' }))
          } elseif ($r.status -eq 429) {
            $wait = 20; if ($null -ne $r.retryAfter) { $wait = $r.retryAfter }
            $blockedUntil = $after + $wait * 1000; $status.lastError = 'too-soon'
            Write-AgentLog ('429: again in ' + $wait + ' s')
          } elseif ($r.status -eq 401) {
            foreach ($g in $chosen) { $g.ready = $null; $g.nextDue = $after + 3600000 }
            $blockedUntil = $after + 3600000; $status.lastError = 'unauthorized'
            Write-AgentLog '401: the key is not accepted (revoked?); trying again in an hour'
          } elseif ($r.status -ge 400 -and $r.status -lt 500) {
            foreach ($g in $chosen) { $g.ready = $null; $g.lastSentMs = $t; $g.nextDue = $after + (Get-Jittered $g.parts[0] $g.interval) }
            $status.lastError = 'http-' + $r.status; Write-AgentLog ([string]$r.status + ': waiting for the next interval')
          } else {
            if ($backoff -eq 0) { $backoff = 30 } else { $backoff = [Math]::Min($backoff * 2, 900) }
            $blockedUntil = $after + $backoff * 1000
            if ($r.status) { $status.lastError = 'http-' + $r.status } elseif ($r.error) { $status.lastError = $r.error } else { $status.lastError = 'error' }
            Write-AgentLog ($status.lastError + ': again in ' + $backoff + ' s')
          }
          Save-AgentStatus $status $StateDir
        }
      }
    }
    # Sleep until the next thing to do: at most 60 s, at most 5 s while the update search runs, at least 250 ms.
    $t2 = [long]$clock.ElapsedMilliseconds
    $events = @($blockedUntil, ($lastSendMs + $floorMs), $hb.nextDue)
    if (-not $sys.running -and $null -eq $sys.ready) { $events += , ($sys.nextDue - $floorMs) }
    if ($null -ne $sys.ready) { $events += , ($sys.lastSentMs + $minMs.systems) }
    $next = $t2 + 60000
    foreach ($e in $events) { if ($e -gt $t2 -and $e -lt $next) { $next = $e } }
    if ($sys.running) { $next = [Math]::Min($next, $t2 + 5000) }
    Start-Sleep -Milliseconds ([int][Math]::Max(250, $next - $t2))
  }
}

# Where the agent may write (Write-AgentFile) and where it logs; called once by the start.
function Set-AgentFiles {
  param([string[]]$WritableDirs, [string]$LogFile)
  $script:WritableDirs = @($WritableDirs | Where-Object { $_ })
  $script:LogFile = $LogFile
}

# Read-AgentToken is not exported: the key stays inside the module ($script:Token).
Export-ModuleMember -Function Get-NowMs, Format-Iso, Get-Prop, Import-AgentRules, Test-RecordLine, Select-PartRecords, Test-AgentSpecs, Read-AgentSpecs,
Get-Sha256Hex, Test-HubOrigin, Read-AgentConfig, Read-AgentVersion, Read-PemCertificate, New-HubTrust, ConvertTo-AgentJson, Test-DisplayName,
Get-OsRecords, Get-PackageRecords, New-SystemsParts, Read-Ack, Send-AgentReport, Write-AgentFile, Write-AgentLog, ConvertTo-StatusText,
Initialize-Agent, New-AgentStatus, Save-AgentStatus, Invoke-AgentCollectOnce, Invoke-AgentLoop, Set-AgentFiles
