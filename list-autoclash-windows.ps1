# Lists every running AutoClash window as JSON.
#
# The window title carries live state the log files do not:
#   AutoClash Pro v2.0.9 | Android Device-1 (16416) | myaccount
# giving the version, the emulator's ADB port, and which account is active
# right now. Parsing is best-effort: an unexpected title still yields a row,
# just with empty fields.

$ErrorActionPreference = "Stop"

$rows = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'AutoClash%'" | ForEach-Object {
  $proc = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  $title = if ($proc) { $proc.MainWindowTitle } else { "" }

  # GetFullPath also expands 8.3 short paths, so this matches the long form
  # the monitor configures.
  $full = ""
  if ($_.ExecutablePath) {
    try { $full = [System.IO.Path]::GetFullPath($_.ExecutablePath) } catch { $full = $_.ExecutablePath }
  }

  $version = ""
  $port = ""
  $account = ""
  if ($title) {
    if ($title -match 'v(\d+(?:\.\d+)+)') { $version = $Matches[1] }
    if ($title -match '\((\d{2,6})\)') { $port = $Matches[1] }
    $parts = $title -split '\|'
    if ($parts.Count -ge 3) { $account = $parts[$parts.Count - 1].Trim() }
  }

  $startTime = 0
  if ($proc) {
    try {
      $startTime = [DateTimeOffset]::new($proc.StartTime).ToUnixTimeMilliseconds()
    } catch {}
  }

  [pscustomobject]@{
    pid          = $_.ProcessId
    path         = $full
    title        = $title
    hasWindow    = [bool]($proc -and $proc.MainWindowHandle -ne 0)
    version      = $version
    adbPort      = $port
    account      = $account
    startTime    = $startTime
  }
})

# -Depth keeps nested values intact; ConvertTo-Json collapses a single item to
# an object, so the array is forced.
ConvertTo-Json -InputObject @($rows) -Depth 4 -Compress
