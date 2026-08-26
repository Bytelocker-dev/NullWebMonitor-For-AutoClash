param(
  [Parameter(Mandatory = $true)]
  [string]$Label
)

$messages = New-Object System.Collections.Generic.List[string]
$windowProcesses = Get-Process |
  Where-Object {
    $_.MainWindowHandle -ne 0 -and
    ($_.ProcessName -in @("dnplayer", "LDPlayer", "LDPlayer_0900020001")) -and
    ($_.MainWindowTitle -eq $Label -or $_.MainWindowTitle -like "*$Label*")
  }

if ($windowProcesses) {
  foreach ($process in $windowProcesses) {
    Stop-Process -Id $process.Id -Force
    $messages.Add("Force closed PID=$($process.Id) Title='$($process.MainWindowTitle)'")
  }
}

if ($messages.Count -eq 0) {
  Write-Output "No LDPlayer window found for '$Label'."
} else {
  Write-Output ($messages -join "`n")
}
