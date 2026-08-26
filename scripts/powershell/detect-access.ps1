param(
  [int]$Port = 8477
)

# Reports how this machine can be reached, for the setup wizard's Access step:
# Tailscale address, whether a matching inbound firewall rule already exists,
# and which network profile the Tailscale adapter is on.
#
# Read-only. Never creates or changes a firewall rule — that is the user's call,
# made from an elevated prompt with the command the wizard shows them.

$ErrorActionPreference = "SilentlyContinue"

function Find-Tailscale {
  $candidates = @(
    "$env:ProgramFiles\Tailscale\tailscale.exe",
    "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe",
    "$env:ProgramW6432\Tailscale\tailscale.exe",
    "$env:LocalAppData\Tailscale\tailscale.exe",
    "$env:LocalAppData\Programs\Tailscale\tailscale.exe",
    "$env:SystemDrive\Program Files\Tailscale\tailscale.exe"
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ""
}

$tsExe = Find-Tailscale
$tsIp = ""
$tsName = ""
$tsInstalled = [bool]$tsExe

if ($tsExe) {
  $ipOut = & $tsExe ip -4 2>$null
  if ($ipOut) { $tsIp = ($ipOut | Select-Object -First 1).Trim() }

  $statusOut = & $tsExe status --self --peers=false 2>$null
  if ($statusOut) {
    $parts = ($statusOut | Select-Object -First 1) -split '\s+'
    if ($parts.Count -ge 2) { $tsName = $parts[1] }
  }
}

# If CLI did not return an IP, query the network adapter directly
if (-not $tsIp) {
  $tsAdapter = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.InterfaceAlias -like "*Tailscale*" -or
      ($_.IPAddress -like "100.*" -and [int]($_.IPAddress.Split('.')[1]) -ge 64 -and [int]($_.IPAddress.Split('.')[1]) -le 127)
    } | Select-Object -First 1

  if ($tsAdapter) {
    $tsIp = $tsAdapter.IPAddress
    $tsInstalled = $true
  }
}

if (-not $tsName -and $tsIp) {
  $tsName = $env:COMPUTERNAME.ToLower()
}

# Network profile of the Tailscale adapter decides which firewall profile the
# inbound rule needs. This trips people up: Tailscale is usually "Private"
# while Node's default allow rules are "Public" only.
$tsProfile = ""
$p = Get-NetConnectionProfile | Where-Object { $_.InterfaceAlias -like "*Tailscale*" } | Select-Object -First 1
if ($p) { $tsProfile = $p.NetworkCategory.ToString() }

# Does an inbound allow rule already cover this port?
#
# Query the port filters in one bulk call and map back to rules. Looping over
# every rule and calling Get-NetFirewallPortFilter per rule takes ~110 seconds
# on a normal Windows install — far too slow for a setup screen.
$ruleFound = $false
$ruleName = ""
$matchingFilters = Get-NetFirewallPortFilter -ErrorAction SilentlyContinue |
  Where-Object { $_.Protocol -eq "TCP" -and $_.LocalPort -contains "$Port" }

foreach ($filter in $matchingFilters) {
  $rule = $filter | Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.Direction -eq "Inbound" -and $_.Enabled -eq "True" -and $_.Action -eq "Allow" } |
    Select-Object -First 1
  if ($rule) {
    $ruleFound = $true
    $ruleName = $rule.DisplayName
    break
  }
}

$lan = @()
foreach ($a in (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
  # Skip loopback, the Tailscale CGNAT range, and 169.254.* link-local
  # addresses, which are never reachable and just clutter the wizard.
  if ($a.IPAddress -notlike "127.*" -and
      $a.IPAddress -notlike "100.*" -and
      $a.IPAddress -notlike "169.254.*" -and
      $a.IPAddress -ne "0.0.0.0") {
    $lan += $a.IPAddress
  }
}

[pscustomobject]@{
  port                = $Port
  tailscaleInstalled  = $tsInstalled
  tailscaleIp         = $tsIp
  tailscaleName       = $tsName
  tailscaleProfile    = $tsProfile
  firewallRuleExists  = $ruleFound
  firewallRuleName    = $ruleName
  lanAddresses        = @($lan)
} | ConvertTo-Json -Depth 4 -Compress
