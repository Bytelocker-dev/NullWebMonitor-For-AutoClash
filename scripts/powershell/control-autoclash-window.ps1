param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("start", "pause", "stop", "stats", "show", "hide", "detect")]
  [string]$Action,
  [string]$ProcessName = "AutoClash",
  [string]$WindowTitle = "AutoClash Pro",
  [string]$ExePath = "",
  [int]$StatsX = 78,
  [int]$StatsY = 399,
  [int]$ControlButtonBottomOffset = 24,
  # Fallbacks only. The buttons are located by looking at the window first;
  # these are used when that fails. Measured on AutoClash 2.0.9 at 100% DPI.
  [int]$StartX = 25,
  [int]$PauseX = 62,
  [int]$StopX = 100,
  [switch]$NoButtonDetect,
  [switch]$RestoreMinimized
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class Win32Control {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

  [DllImport("user32.dll")]
  public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT point);

  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }
}
"@

$SW_HIDE = 0
$SW_RESTORE = 9
$SW_MINIMIZE = 6
$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOMOVE = 0x0002
$SWP_NOSIZE = 0x0001
$SWP_SHOWWINDOW = 0x0040
$GA_ROOT = 2

function Get-TargetWindow {
  $hasExePath = ![string]::IsNullOrWhiteSpace($ExePath)
  $matches = Get-Process |
    Where-Object {
      if ($_.MainWindowHandle -eq 0) {
        return $false
      }

      if ($hasExePath) {
        return $_.Path -eq $ExePath
      }

      return $_.ProcessName -like "$ProcessName*" -or $_.MainWindowTitle -like "*$WindowTitle*"
    } |
    Sort-Object -Property @{ Expression = { $_.MainWindowTitle.Length }; Descending = $true }

  if (!$matches) {
    $available = Get-Process |
      Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like "*AutoClash*" -or $_.MainWindowTitle -like "*AutoClash*") } |
      ForEach-Object { "PID=$($_.Id) Title='$($_.MainWindowTitle)' Path='$($_.Path)'" }
    throw "No AutoClash window found. ProcessName=$ProcessName WindowTitle=$WindowTitle ExePath=$ExePath`nAvailable:`n$($available -join "`n")"
  }

  return $matches[0]
}

function Invoke-Click {
  param(
    [IntPtr]$Handle,
    [int]$RelativeX,
    [int]$RelativeY
  )

  $point = New-Object Win32Control+POINT
  $point.X = $RelativeX
  $point.Y = $RelativeY
  [Win32Control]::ClientToScreen($Handle, [ref]$point) | Out-Null

  $windowAtPoint = [Win32Control]::WindowFromPoint($point)
  $rootAtPoint = [Win32Control]::GetAncestor($windowAtPoint, $GA_ROOT)
  if ($rootAtPoint -ne $Handle) {
    throw "Click point is not over the AutoClash window. Point=$($point.X),$($point.Y)"
  }

  $x = $point.X
  $y = $point.Y
  [Win32Control]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  [Win32Control]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [Win32Control]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
}

function Invoke-ReliableClick {
  param(
    [IntPtr]$Handle,
    [hashtable]$Point
  )

  $offsets = @(0, -8, 8, -14, 14)
  $lastError = $null

  foreach ($offset in $offsets) {
    try {
      Invoke-Click -Handle $Handle -RelativeX $Point.X -RelativeY ($Point.Y + $offset)
      return @{
        X = $Point.X
        Y = $Point.Y + $offset
      }
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 120
    }
  }

  throw $lastError
}

# AutoClash moved its control buttons between versions, and hardcoded
# coordinates silently click empty space when it happens. Look at the window
# instead: the three buttons are the only bright things in the bottom-left
# corner of an otherwise dark bar, so cluster the bright pixels and read the
# centres off. Falls back to the -StartX/-PauseX/-StopX values if the shape
# of that corner is not what we expect.
function Find-ControlButtons {
  param([IntPtr]$Handle, [int]$Width, [int]$Height)

  if ($NoButtonDetect) { return $null }

  try {
    Add-Type -AssemblyName System.Drawing

    # PW_CLIENTONLY returns false on this window - AutoClash renders with
    # hardware acceleration, so only PW_RENDERFULLCONTENT over the whole
    # window produces pixels. That means capturing window coordinates and
    # converting back to client ones afterwards.
    $windowRect = New-Object Win32Control+RECT
    [Win32Control]::GetWindowRect($Handle, [ref]$windowRect) | Out-Null
    $shotWidth = $windowRect.Right - $windowRect.Left
    $shotHeight = $windowRect.Bottom - $windowRect.Top
    if ($shotWidth -le 0 -or $shotHeight -le 0) { return $null }

    $origin = New-Object Win32Control+POINT
    $origin.X = 0
    $origin.Y = 0
    [Win32Control]::ClientToScreen($Handle, [ref]$origin) | Out-Null
    $offsetX = $origin.X - $windowRect.Left
    $offsetY = $origin.Y - $windowRect.Top

    $bmp = New-Object System.Drawing.Bitmap($shotWidth, $shotHeight)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [Win32Control]::PrintWindow($Handle, $hdc, 2)
    $g.ReleaseHdc($hdc)

    # PrintWindow returns false on AutoClash whichever flag is used, so read
    # the pixels off the screen instead. Safe here: the caller has already
    # restored the window and pulled it to the front.
    if (-not $ok) {
      $g.CopyFromScreen($windowRect.Left, $windowRect.Top, 0, 0, $bmp.Size)
    }
    $g.Dispose()

    $Width = $shotWidth
    $Height = $shotHeight

    # The bar is about 40px tall. Stay left of the licence text.
    $top = [Math]::Max(0, $Height - 50)
    $columns = @{}
    for ($y = $top; $y -lt $Height; $y++) {
      for ($x = 0; $x -lt 130; $x++) {
        $px = $bmp.GetPixel($x, $y)
        $bright = [Math]::Max($px.R, [Math]::Max($px.G, $px.B))
        if ($bright -gt 120) {
          if (-not $columns.ContainsKey($x)) { $columns[$x] = @{ n = 0; sy = 0 } }
          $columns[$x].n++
          $columns[$x].sy += $y
        }
      }
    }
    $bmp.Dispose()

    # A button glyph lights up a tall run of pixels in its column. The thin
    # separator line above the bar lights every column but only two or three
    # pixels deep, so height is what tells them apart.
    $xs = @($columns.Keys | Where-Object { $columns[$_].n -ge 5 } | Sort-Object)
    if ($xs.Count -eq 0) { return $null }

    # Split the lit columns into blobs wherever there is a gap.
    $clusters = @()
    $current = @()
    $previous = $null
    foreach ($x in $xs) {
      if ($null -ne $previous -and ($x - $previous) -gt 6) {
        $clusters += ,$current
        $current = @()
      }
      $current += $x
      $previous = $x
    }
    if ($current.Count) { $clusters += ,$current }

    # A button glyph is a small blob. Anything wider is text or a border.
    $buttons = @()
    foreach ($cluster in $clusters) {
      $width = ($cluster[-1] - $cluster[0]) + 1
      if ($width -lt 4 -or $width -gt 24) { continue }
      $pixels = 0
      $sumY = 0
      foreach ($x in $cluster) { $pixels += $columns[$x].n; $sumY += $columns[$x].sy }
      if ($pixels -lt 12) { continue }
      $buttons += @{
        X = [int][Math]::Round(($cluster[0] + $cluster[-1]) / 2) - $offsetX
        Y = [int][Math]::Round($sumY / $pixels) - $offsetY
      }
    }

    if ($buttons.Count -ne 3) { return $null }

    # Left to right: start, pause, stop. Reject anything unevenly spaced —
    # that means we found something other than the button row.
    $buttons = $buttons | Sort-Object -Property { $_.X }
    $gapOne = $buttons[1].X - $buttons[0].X
    $gapTwo = $buttons[2].X - $buttons[1].X
    if ($gapOne -lt 15 -or $gapTwo -lt 15) { return $null }
    if ([Math]::Abs($gapOne - $gapTwo) -gt 8) { return $null }

    return @{ start = $buttons[0]; pause = $buttons[1]; stop = $buttons[2] }
  } catch {
    return $null
  }
}

function Get-ControlButtonPoint {
  param(
    [IntPtr]$Handle,
    [string]$Button
  )

  $rect = New-Object Win32Control+RECT
  [Win32Control]::GetClientRect($Handle, [ref]$rect) | Out-Null
  $height = $rect.Bottom - $rect.Top
  if ($height -le 0) {
    throw "AutoClash window has invalid height: $height"
  }

  $width = $rect.Right - $rect.Left
  $found = Find-ControlButtons -Handle $Handle -Width $width -Height $height
  if ($found) { return $found[$Button] }

  $xByButton = @{
    start = $StartX
    pause = $PauseX
    stop = $StopX
  }

  return @{
    X = $xByButton[$Button]
    Y = [Math]::Max(0, $height - $ControlButtonBottomOffset)
  }
}

$target = Get-TargetWindow
$handle = $target.MainWindowHandle
$wasMinimized = [Win32Control]::IsIconic($handle)

if ($Action -eq "hide") {
  [Win32Control]::ShowWindow($handle, $SW_MINIMIZE) | Out-Null
  Write-Output "AutoClash minimized"
  exit 0
}

[Win32Control]::ShowWindow($handle, $SW_RESTORE) | Out-Null
Start-Sleep -Milliseconds 200
[Win32Control]::SetWindowPos($handle, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW) | Out-Null
Start-Sleep -Milliseconds 150
[Win32Control]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 450

if ($Action -eq "show") {
  Write-Output "AutoClash shown"
  exit 0
}

if ($Action -eq "detect") {
  $rect = New-Object Win32Control+RECT
  [Win32Control]::GetClientRect($handle, [ref]$rect) | Out-Null
  $found = Find-ControlButtons -Handle $handle -Width ($rect.Right - $rect.Left) -Height ($rect.Bottom - $rect.Top)
  $source = if ($found) { 'detected' } else { 'fallback' }
  $points = @{}
  foreach ($name in 'start', 'pause', 'stop') {
    $points[$name] = Get-ControlButtonPoint -Handle $handle -Button $name
  }
  [pscustomobject]@{
    source = $source
    client = "$($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top)"
    start  = "$($points.start.X),$($points.start.Y)"
    pause  = "$($points.pause.X),$($points.pause.Y)"
    stop   = "$($points.stop.X),$($points.stop.Y)"
  } | ConvertTo-Json -Compress | Write-Output
  exit 0
}

if ($Action -in @("start", "pause", "stop")) {
  $point = Get-ControlButtonPoint -Handle $handle -Button $Action
} else {
  $point = @{ X = $StatsX; Y = $StatsY }
}

try {
  $clickedPoint = Invoke-ReliableClick -Handle $handle -Point $point
  Start-Sleep -Milliseconds 250
} finally {
  if ($wasMinimized -and $RestoreMinimized) {
    [Win32Control]::ShowWindow($handle, $SW_MINIMIZE) | Out-Null
  } else {
    [Win32Control]::SetWindowPos($handle, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW) | Out-Null
  }
}

Write-Output "AutoClash action executed: $Action at $($clickedPoint.X),$($clickedPoint.Y)"
