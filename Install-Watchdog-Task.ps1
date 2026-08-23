<#
.SYNOPSIS
  Registers a Windows scheduled task that keeps NullWebMonitor running.

.DESCRIPTION
  The watchdog restarts the monitor, and the launcher restarts the watchdog,
  but nothing inside the window can survive the window itself being closed,
  killed, or a reboot. Only the operating system can, which is what this is for.

  The task starts the launcher when you sign in, and re-checks every few
  minutes. The check does nothing while the launcher is already running, so it
  only has an effect if the window is gone.

  Run this yourself from a normal PowerShell prompt in the project folder.
  Nothing in this project registers it for you: a task that starts a program at
  logon is a change to your machine, not to this app, and that is your call.

.PARAMETER IntervalMinutes
  How often to check that it is still running. Default 5.

.PARAMETER Remove
  Unregister the task instead of creating it.

.EXAMPLE
  .\Install-Watchdog-Task.ps1
  .\Install-Watchdog-Task.ps1 -IntervalMinutes 2
  .\Install-Watchdog-Task.ps1 -Remove
#>

[CmdletBinding()]
param(
  [int]$IntervalMinutes = 5,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$taskName = "NullWebMonitor"

if ($Remove) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed the '$taskName' scheduled task." -ForegroundColor Green
    Write-Host "Anything currently running keeps running until you close it."
  } else {
    Write-Host "No '$taskName' task is registered. Nothing to remove."
  }
  return
}

if ($IntervalMinutes -lt 1 -or $IntervalMinutes -gt 60) {
  throw "IntervalMinutes must be between 1 and 60."
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $root "Start NullWebMonitor.bat"

if (-not (Test-Path $launcher)) {
  throw "Could not find '$launcher'. Run this from the folder the launcher is in."
}

# cmd /c so the console window appears and behaves the same as double-clicking.
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$launcher`"" -WorkingDirectory $root

$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# A repeating trigger is what covers a window that was closed or crashed. It is
# harmless while the launcher is up, because MultipleInstances is IgnoreNew.
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

# Interactive, so the window is visible and can be closed on purpose. Deliberately
# not SYSTEM and not "run whether logged on or not": the monitor drives AutoClash
# windows on your desktop, and a session it cannot see is no use to it.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Replacing the existing '$taskName' task."
}

Register-ScheduledTask -TaskName $taskName `
  -Action $action `
  -Trigger @($atLogon, $repeat) `
  -Settings $settings `
  -Principal $principal `
  -Description "Starts NullWebMonitor at logon and restarts it if the window is closed or crashes." | Out-Null

Write-Host ""
Write-Host "Registered the '$taskName' scheduled task." -ForegroundColor Green
Write-Host "  Starts at:  sign-in"
Write-Host "  Re-checks:  every $IntervalMinutes minute(s), and does nothing if it is already running"
Write-Host "  Runs:       $launcher"
Write-Host ""
Write-Host "To stop the monitor for a while, remove the task first, or it will come back:"
Write-Host "  .\Install-Watchdog-Task.ps1 -Remove"
Write-Host ""
Write-Host "To start it now without waiting:"
Write-Host "  Start-ScheduledTask -TaskName $taskName"
