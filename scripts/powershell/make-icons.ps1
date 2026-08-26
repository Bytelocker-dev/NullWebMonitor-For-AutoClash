param(
  [string]$SourceImage = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "public\logo.png"),
  [string]$OutDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "public")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir | Out-Null
}

function Create-AppIcon {
  param(
    [string]$Source,
    [string]$Destination,
    [int]$Width,
    [int]$Height,
    [bool]$Transparent = $false
  )

  if (Test-Path $Source) {
    $src = [System.Drawing.Image]::FromFile($Source)
    try {
      $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
      try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
          $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
          $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          if ($Transparent) {
            $g.Clear([System.Drawing.Color]::Transparent)
          } else {
            $g.Clear([System.Drawing.ColorTranslator]::FromHtml("#0b0f16"))
          }

          $g.DrawImage($src, 0, 0, $Width, $Height)
        } finally {
          $g.Dispose()
        }
        $bmp.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Output "Saved $Destination ($Width x $Height)"
      } finally {
        $bmp.Dispose()
      }
    } finally {
      $src.Dispose()
    }
  } else {
    Write-Warning "Source image not found: $Source"
  }
}

Create-AppIcon -Source $SourceImage -Destination (Join-Path $OutDir "icon-192.png") -Width 192 -Height 192
Create-AppIcon -Source $SourceImage -Destination (Join-Path $OutDir "icon-512.png") -Width 512 -Height 512
Create-AppIcon -Source $SourceImage -Destination (Join-Path $OutDir "apple-touch-icon.png") -Width 180 -Height 180
Create-AppIcon -Source $SourceImage -Destination (Join-Path $OutDir "favicon.png") -Width 64 -Height 64 -Transparent $true
