param(
  [int]$TimeoutSeconds = 20,
  [string]$WindowTitle = "AutoClash Activation",
  [string]$ButtonText = "Activate"
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class AutoClashLaunchClicker {
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
  public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT point);

  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

  public static IntPtr MakeLParam(int x, int y) {
    return (IntPtr)((y << 16) | (x & 0xFFFF));
  }

  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public struct POINT {
    public int X;
    public int Y;
  }
}
"@

function Find-ActivationWindow {
  param([string]$Title)

  $script:FoundActivationWindow = [IntPtr]::Zero
  $callback = [AutoClashLaunchClicker+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    if (-not [AutoClashLaunchClicker]::IsWindowVisible($hWnd)) {
      return $true
    }

    $text = New-Object System.Text.StringBuilder 512
    [void][AutoClashLaunchClicker]::GetWindowText($hWnd, $text, $text.Capacity)
    if ($text.ToString() -like "*$Title*") {
      $script:FoundActivationWindow = $hWnd
      return $false
    }

    return $true
  }

  [void][AutoClashLaunchClicker]::EnumWindows($callback, [IntPtr]::Zero)
  return $script:FoundActivationWindow
}

function Invoke-ButtonWithAutomation {
  param(
    [string]$Title,
    [string]$Name
  )

  try {
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

      $buttonName = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        $Name
      )
      $buttonType = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
      )
      $buttonCondition = New-Object System.Windows.Automation.AndCondition($buttonName, $buttonType)
      $button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)

      if ($null -eq $button) {
        continue
      }

      $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $pattern.Invoke()
      return $true
    }
  } catch {
    return $false
  }

  return $false
}

function Invoke-TargetedFallbackClick {
  param([IntPtr]$WindowHandle)

  if ($WindowHandle -eq [IntPtr]::Zero) {
    return $false
  }

  [void][AutoClashLaunchClicker]::ShowWindow($WindowHandle, 9)
  [void][AutoClashLaunchClicker]::SetForegroundWindow($WindowHandle)
  Start-Sleep -Milliseconds 250

  $rect = New-Object AutoClashLaunchClicker+RECT
  if (-not [AutoClashLaunchClicker]::GetClientRect($WindowHandle, [ref]$rect)) {
    return $false
  }

  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) {
    return $false
  }

  $x = [int]($width / 2)
  $y = [Math]::Min([Math]::Max([int]($height * 0.86), 175), $height - 25)
  $lParam = [AutoClashLaunchClicker]::MakeLParam($x, $y)
  $mkLButton = [IntPtr]1

  [void][AutoClashLaunchClicker]::PostMessage($WindowHandle, 0x0200, [IntPtr]::Zero, $lParam)
  Start-Sleep -Milliseconds 60
  [void][AutoClashLaunchClicker]::PostMessage($WindowHandle, 0x0201, $mkLButton, $lParam)
  Start-Sleep -Milliseconds 90
  [void][AutoClashLaunchClicker]::PostMessage($WindowHandle, 0x0202, [IntPtr]::Zero, $lParam)
  return $true
}

function Invoke-GuardedForegroundClick {
  param([IntPtr]$WindowHandle)

  if ($WindowHandle -eq [IntPtr]::Zero) {
    return $false
  }

  $topMost = [IntPtr](-1)
  $notTopMost = [IntPtr](-2)
  $noMoveNoSize = 0x0001 -bor 0x0002 -bor 0x0040

  [void][AutoClashLaunchClicker]::ShowWindow($WindowHandle, 9)
  [void][AutoClashLaunchClicker]::SetWindowPos($WindowHandle, $topMost, 0, 0, 0, 0, $noMoveNoSize)
  Start-Sleep -Milliseconds 150
  [void][AutoClashLaunchClicker]::SetForegroundWindow($WindowHandle)
  Start-Sleep -Milliseconds 350

  $rect = New-Object AutoClashLaunchClicker+RECT
  if (-not [AutoClashLaunchClicker]::GetWindowRect($WindowHandle, [ref]$rect)) {
    [void][AutoClashLaunchClicker]::SetWindowPos($WindowHandle, $notTopMost, 0, 0, 0, 0, $noMoveNoSize)
    return $false
  }

  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) {
    [void][AutoClashLaunchClicker]::SetWindowPos($WindowHandle, $notTopMost, 0, 0, 0, 0, $noMoveNoSize)
    return $false
  }

  $x = $rect.Left + [int]($width / 2)
  $y = $rect.Top + [Math]::Min([Math]::Max([int]($height * 0.86), 175), $height - 35)
  $point = New-Object AutoClashLaunchClicker+POINT
  $point.X = $x
  $point.Y = $y

  $windowAtPoint = [AutoClashLaunchClicker]::WindowFromPoint($point)
  $rootAtPoint = [AutoClashLaunchClicker]::GetAncestor($windowAtPoint, 2)
  if ($windowAtPoint -eq [IntPtr]::Zero -or $rootAtPoint -ne $WindowHandle) {
    [void][AutoClashLaunchClicker]::SetWindowPos($WindowHandle, $notTopMost, 0, 0, 0, 0, $noMoveNoSize)
    return $false
  }

  [void][AutoClashLaunchClicker]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 80
  [AutoClashLaunchClicker]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  [AutoClashLaunchClicker]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 150
  [void][AutoClashLaunchClicker]::SetWindowPos($WindowHandle, $notTopMost, 0, 0, 0, 0, $noMoveNoSize)
  return $true
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$window = [IntPtr]::Zero

while ((Get-Date) -lt $deadline) {
  $window = Find-ActivationWindow -Title $WindowTitle
  if ($window -ne [IntPtr]::Zero) {
    break
  }
  Start-Sleep -Milliseconds 500
}

if ($window -eq [IntPtr]::Zero) {
  Write-Output "AutoClash opened. Activation window was not shown."
  exit 0
}

if (Invoke-ButtonWithAutomation -Title $WindowTitle -Name $ButtonText) {
  Write-Output "AutoClash opened and Activate was clicked."
  exit 0
}

if ($ButtonText -ne "Activate Launch" -and (Invoke-ButtonWithAutomation -Title $WindowTitle -Name "Activate Launch")) {
  Write-Output "AutoClash opened and Activate Launch was clicked."
  exit 0
}

if (Invoke-TargetedFallbackClick -WindowHandle $window) {
  Write-Output "AutoClash opened and Activate was clicked."
  exit 0
}

if (Invoke-GuardedForegroundClick -WindowHandle $window) {
  Write-Output "AutoClash opened and Activate was clicked."
  exit 0
}

throw "AutoClash Activation window was found, but Activate could not be clicked."
