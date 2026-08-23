param(
  [string]$OutputPath,
  [string]$ProcessName = "AutoClash",
  [string]$WindowTitle = "AutoClash Pro",
  [string]$ExePath = "",
  [string]$Crop = "",
  [int]$StatsX = 78,
  [int]$StatsY = 399,
  [switch]$EnsureStatsTab
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class Win32Capture {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@

$SW_RESTORE = 9
$SW_MINIMIZE = 6
$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004

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

function Invoke-RelativeClick {
  param(
    [IntPtr]$Handle,
    [int]$RelativeX,
    [int]$RelativeY
  )

  $clickRect = New-Object Win32Capture+RECT
  [Win32Capture]::GetWindowRect($Handle, [ref]$clickRect) | Out-Null
  $x = $clickRect.Left + $RelativeX
  $y = $clickRect.Top + $RelativeY
  [Win32Capture]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  [Win32Capture]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [Win32Capture]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
}

function Parse-Crop {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  $parts = $Value.Split(",") | ForEach-Object { [int]$_.Trim() }
  if ($parts.Count -ne 4) {
    throw "Crop must be x,y,width,height"
  }

  return @{
    X = $parts[0]
    Y = $parts[1]
    W = $parts[2]
    H = $parts[3]
  }
}

function Get-BoundedCrop {
  param(
    [hashtable]$CropInfo,
    [int]$BitmapWidth,
    [int]$BitmapHeight
  )

  if ($CropInfo.X -lt 0 -or $CropInfo.Y -lt 0 -or $CropInfo.X -ge $BitmapWidth -or $CropInfo.Y -ge $BitmapHeight) {
    throw "Crop start is outside the AutoClash window. Crop=$($CropInfo.X),$($CropInfo.Y),$($CropInfo.W),$($CropInfo.H) Window=${BitmapWidth}x${BitmapHeight}"
  }

  $boundedWidth = [Math]::Min($CropInfo.W, $BitmapWidth - $CropInfo.X)
  $boundedHeight = [Math]::Min($CropInfo.H, $BitmapHeight - $CropInfo.Y)
  if ($boundedWidth -le 0 -or $boundedHeight -le 0) {
    throw "Crop has invalid bounded size. Crop=$($CropInfo.X),$($CropInfo.Y),$($CropInfo.W),$($CropInfo.H) Window=${BitmapWidth}x${BitmapHeight}"
  }

  return New-Object System.Drawing.Rectangle $CropInfo.X, $CropInfo.Y, $boundedWidth, $boundedHeight
}

$process = Get-TargetWindow
$wasMinimized = [Win32Capture]::IsIconic($process.MainWindowHandle)

if ($EnsureStatsTab) {
  [Win32Capture]::ShowWindow($process.MainWindowHandle, $SW_RESTORE) | Out-Null
  Start-Sleep -Milliseconds 200
  [Win32Capture]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 200
  Invoke-RelativeClick -Handle $process.MainWindowHandle -RelativeX $StatsX -RelativeY $StatsY
  Start-Sleep -Milliseconds 450
}

$rect = New-Object Win32Capture+RECT
[Win32Capture]::GetWindowRect($process.MainWindowHandle, [ref]$rect) | Out-Null

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  throw "AutoClash window has invalid size: ${width}x${height}"
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
$printed = [Win32Capture]::PrintWindow($process.MainWindowHandle, $hdc, 2)
$graphics.ReleaseHdc($hdc)

if (!$printed) {
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
}
$graphics.Dispose()

$cropInfo = Parse-Crop $Crop
if ($cropInfo) {
  $cropRect = Get-BoundedCrop -CropInfo $cropInfo -BitmapWidth $bitmap.Width -BitmapHeight $bitmap.Height
  $cropped = $bitmap.Clone($cropRect, $bitmap.PixelFormat)
  $bitmap.Dispose()
  $bitmap = $cropped
}

$dir = Split-Path -Parent $OutputPath
if ($dir -and !(Test-Path $dir)) {
  New-Item -ItemType Directory -Path $dir | Out-Null
}

$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

if ($EnsureStatsTab -and $wasMinimized) {
  [Win32Capture]::ShowWindow($process.MainWindowHandle, $SW_MINIMIZE) | Out-Null
}

Write-Output $OutputPath
