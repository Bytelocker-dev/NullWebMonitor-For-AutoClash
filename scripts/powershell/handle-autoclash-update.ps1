param(
  [int]$TimeoutSeconds = 240,
  [string]$UpdateWindowTitle = "Update Available",
  [string]$ProgressWindowTitle = "Updating AutoClash",
  [string[]]$UpdateButtonNames = @("Update Now", "Update"),
  [string]$CloseButtonName = "Close",
  [string]$ExpectedRoot = ""
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class AutoClashUpdateClicker {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@

function Get-WindowProcessPath {
  param([IntPtr]$WindowHandle)

  if ($WindowHandle -eq [IntPtr]::Zero) {
    return ""
  }

  [uint32]$processId = 0
  [void][AutoClashUpdateClicker]::GetWindowThreadProcessId($WindowHandle, [ref]$processId)
  if ($processId -eq 0) {
    return ""
  }

  try {
    return (Get-Process -Id $processId -ErrorAction Stop).Path
  } catch {
    return ""
  }
}

function Test-WindowMatchesRoot {
  param(
    [IntPtr]$WindowHandle,
    [string]$Root
  )

  if ([string]::IsNullOrWhiteSpace($Root)) {
    return $true
  }

  $processPath = Get-WindowProcessPath -WindowHandle $WindowHandle
  if ([string]::IsNullOrWhiteSpace($processPath)) {
    return $false
  }

  $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $normalizedPath = [System.IO.Path]::GetFullPath($processPath)
  return $normalizedPath.StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)
}

function Find-WindowByTitle {
  param(
    [string]$Title,
    [string]$Root = $ExpectedRoot
  )

  $script:FoundWindow = [IntPtr]::Zero
  $callback = [AutoClashUpdateClicker+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    if (-not [AutoClashUpdateClicker]::IsWindowVisible($hWnd)) {
      return $true
    }

    $text = New-Object System.Text.StringBuilder 512
    [void][AutoClashUpdateClicker]::GetWindowText($hWnd, $text, $text.Capacity)
    if ($text.ToString() -like "*$Title*" -and (Test-WindowMatchesRoot -WindowHandle $hWnd -Root $Root)) {
      $script:FoundWindow = $hWnd
      return $false
    }

    return $true
  }

  [void][AutoClashUpdateClicker]::EnumWindows($callback, [IntPtr]::Zero)
  return $script:FoundWindow
}

function Get-AutomationWindow {
  param(
    [string]$Title,
    [string]$Root = $ExpectedRoot
  )

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )

  foreach ($window in $windows) {
    if ($window.Current.Name -notlike "*$Title*") {
      continue
    }

    if (-not [string]::IsNullOrWhiteSpace($Root)) {
      try {
        $processPath = (Get-Process -Id $window.Current.ProcessId -ErrorAction Stop).Path
        $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
        $normalizedPath = [System.IO.Path]::GetFullPath($processPath)
        if (-not $normalizedPath.StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
          continue
        }
      } catch {
        continue
      }
    }

    if ($window.Current.Name -like "*$Title*") {
      return $window
    }
  }

  return $null
}

function Invoke-AutomationButton {
  param(
    [string]$Title,
    [string[]]$Names,
    [string]$Root = $ExpectedRoot
  )

  try {
    $window = Get-AutomationWindow -Title $Title -Root $Root
    if ($null -eq $window) {
      return $false
    }

    $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    )

    foreach ($name in $Names) {
      $buttons = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $buttonCondition
      )

      foreach ($button in $buttons) {
        if ($button.Current.Name -eq $name -or $button.Current.Name -like "*$name*") {
          $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $pattern.Invoke()
          return $true
        }
      }
    }
  } catch {
    return $false
  }

  return $false
}

function Invoke-WindowRelativeClick {
  param(
    [IntPtr]$WindowHandle,
    [double]$XRatio,
    [double]$YRatio
  )

  if ($WindowHandle -eq [IntPtr]::Zero) {
    return $false
  }

  [void][AutoClashUpdateClicker]::ShowWindow($WindowHandle, 9)
  [void][AutoClashUpdateClicker]::SetForegroundWindow($WindowHandle)
  Start-Sleep -Milliseconds 250

  $rect = New-Object AutoClashUpdateClicker+RECT
  if (-not [AutoClashUpdateClicker]::GetWindowRect($WindowHandle, [ref]$rect)) {
    return $false
  }

  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) {
    return $false
  }

  $x = $rect.Left + [int]($width * $XRatio)
  $y = $rect.Top + [int]($height * $YRatio)
  [void][AutoClashUpdateClicker]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 80
  [AutoClashUpdateClicker]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  [AutoClashUpdateClicker]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return $true
}

function Window-ContainsText {
  param(
    [string]$Title,
    [string]$Text,
    [string]$Root = $ExpectedRoot
  )

  try {
    $window = Get-AutomationWindow -Title $Title -Root $Root
    if ($null -eq $window) {
      return $false
    }

    $items = $window.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )

    foreach ($item in $items) {
      if ($item.Current.Name -like "*$Text*") {
        return $true
      }
    }
  } catch {
    return $false
  }

  return $false
}

$updateWindow = Find-WindowByTitle -Title $UpdateWindowTitle -Root $ExpectedRoot
$progressWindow = Find-WindowByTitle -Title $ProgressWindowTitle -Root $ExpectedRoot
if ($updateWindow -eq [IntPtr]::Zero -and $progressWindow -eq [IntPtr]::Zero) {
  Write-Output "UpdateAvailable=False"
  exit 0
}

Write-Output "UpdateAvailable=True"

if ($updateWindow -ne [IntPtr]::Zero) {
  $ownerExePath = Get-WindowProcessPath -WindowHandle $updateWindow
  if (-not [string]::IsNullOrWhiteSpace($ownerExePath)) {
    Write-Output "OwnerExePath=$ownerExePath"
  }

  $clicked = Invoke-AutomationButton -Title $UpdateWindowTitle -Names $UpdateButtonNames
  if (-not $clicked) {
    $clicked = Invoke-WindowRelativeClick -WindowHandle $updateWindow -XRatio 0.39 -YRatio 0.78
  }

  if (-not $clicked) {
    throw "Update window was found, but Update Now could not be clicked."
  }

  Write-Output "UpdateClicked=True"
} else {
  Write-Output "UpdateInProgress=True"
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  $progressWindow = Find-WindowByTitle -Title $ProgressWindowTitle -Root $ExpectedRoot
  if ($progressWindow -ne [IntPtr]::Zero) {
    break
  }
  Start-Sleep -Milliseconds 500
}

if ($progressWindow -eq [IntPtr]::Zero) {
  Write-Output "ProgressWindow=False"
  exit 0
}

Write-Output "ProgressWindow=True"
$updaterPath = Get-WindowProcessPath -WindowHandle $progressWindow
if (-not [string]::IsNullOrWhiteSpace($updaterPath)) {
  Write-Output "UpdaterPath=$updaterPath"
}

$updateCompletePrinted = $false
while ((Get-Date) -lt $deadline) {
  $progressWindow = Find-WindowByTitle -Title $ProgressWindowTitle -Root $ExpectedRoot
  if ($progressWindow -eq [IntPtr]::Zero) {
    if (-not $updateCompletePrinted) {
      Write-Output "UpdateComplete=True"
    }
    Write-Output "Closed=True"
    exit 0
  }

  if ((-not $updateCompletePrinted) -and (Window-ContainsText -Title $ProgressWindowTitle -Text "Downloaded update")) {
    Write-Output "UpdateComplete=True"
    $updateCompletePrinted = $true
  }

  $closed = Invoke-AutomationButton -Title $ProgressWindowTitle -Names @($CloseButtonName)
  if (-not $closed) {
    $closed = Invoke-WindowRelativeClick -WindowHandle $progressWindow -XRatio 0.87 -YRatio 0.82
  }

  Start-Sleep -Milliseconds 800

  if ((Find-WindowByTitle -Title $ProgressWindowTitle -Root $ExpectedRoot) -eq [IntPtr]::Zero) {
    if (-not $updateCompletePrinted) {
      Write-Output "UpdateComplete=True"
    }
    Write-Output "Closed=True"
    exit 0
  }

  Start-Sleep -Seconds 2
}

throw "Timed out waiting for AutoClash update to finish or close."
