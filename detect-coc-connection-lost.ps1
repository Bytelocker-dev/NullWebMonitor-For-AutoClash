param(
  [Parameter(Mandatory = $true)]
  [string]$AdbPath,
  [Parameter(Mandatory = $true)]
  [string]$Device,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

Add-Type -AssemblyName System.Drawing

function Test-GreyDialogPixel {
  param([System.Drawing.Color]$Color)
  $max = [Math]::Max($Color.R, [Math]::Max($Color.G, $Color.B))
  $min = [Math]::Min($Color.R, [Math]::Min($Color.G, $Color.B))
  return $Color.R -ge 55 -and $Color.R -le 100 -and
    $Color.G -ge 55 -and $Color.G -le 100 -and
    $Color.B -ge 55 -and $Color.B -le 100 -and
    ($max - $min) -le 16
}

function Test-ReloadTextPixel {
  param([System.Drawing.Color]$Color)
  return $Color.G -ge 130 -and $Color.B -ge 120 -and $Color.R -ge 70 -and
    $Color.G -gt ($Color.R + 25) -and
    $Color.B -gt ($Color.R + 10)
}

$directory = Split-Path -Parent $OutputPath
if ($directory) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

& $AdbPath connect $Device | Out-Null

$quotedAdb = '"' + $AdbPath + '"'
$quotedOutput = '"' + $OutputPath + '"'
$screencapCommand = "$quotedAdb -s $Device exec-out screencap -p > $quotedOutput"
cmd.exe /c $screencapCommand

if (!(Test-Path $OutputPath) -or (Get-Item $OutputPath).Length -le 0) {
  throw "ADB screencap returned no data for $Device"
}

$bitmap = [System.Drawing.Bitmap]::FromFile($OutputPath)

try {
  $width = $bitmap.Width
  $height = $bitmap.Height
  $step = [Math]::Max(3, [Math]::Floor($width / 360))

  $x1 = [Math]::Floor($width * 0.24)
  $x2 = [Math]::Floor($width * 0.76)
  $y1 = [Math]::Floor($height * 0.33)
  $y2 = [Math]::Floor($height * 0.67)

  $dialogSamples = 0
  $dialogGrey = 0
  for ($y = $y1; $y -le $y2; $y += $step) {
    for ($x = $x1; $x -le $x2; $x += $step) {
      $dialogSamples++
      if (Test-GreyDialogPixel $bitmap.GetPixel($x, $y)) {
        $dialogGrey++
      }
    }
  }

  $rx1 = [Math]::Floor($width * 0.26)
  $rx2 = [Math]::Floor($width * 0.36)
  $ry1 = [Math]::Floor($height * 0.57)
  $ry2 = [Math]::Floor($height * 0.66)
  $reloadSamples = 0
  $reloadTeal = 0
  for ($y = $ry1; $y -le $ry2; $y += $step) {
    for ($x = $rx1; $x -le $rx2; $x += $step) {
      $reloadSamples++
      if (Test-ReloadTextPixel $bitmap.GetPixel($x, $y)) {
        $reloadTeal++
      }
    }
  }

  $greyRatio = if ($dialogSamples -gt 0) { $dialogGrey / $dialogSamples } else { 0 }
  $tealRatio = if ($reloadSamples -gt 0) { $reloadTeal / $reloadSamples } else { 0 }
  $detected = $greyRatio -ge 0.68 -and $tealRatio -ge 0.01

  Write-Output "detected=$detected greyRatio=$([Math]::Round($greyRatio, 3)) tealRatio=$([Math]::Round($tealRatio, 3)) file=$OutputPath"
} finally {
  $bitmap.Dispose()
}
