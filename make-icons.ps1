param(
  [string]$OutDir = (Join-Path $PSScriptRoot "public")
)

# Generates the PWA home-screen icons for NullWebMonitor. Run once:
#   powershell -NoProfile -ExecutionPolicy Bypass -File make-icons.ps1
#
# Same System.Drawing approach as resize-image.ps1, so no extra dependencies.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function New-Icon {
  param([int]$Size, [string]$Path)

  $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

      # Background matches the panel's --bg so the icon blends with the app.
      $bg = [System.Drawing.ColorTranslator]::FromHtml("#0b0f16")
      $g.Clear($bg)

      # Rounded accent tile.
      $accent = [System.Drawing.ColorTranslator]::FromHtml("#4c8dff")
      $inset = [int]($Size * 0.13)
      $box = $Size - (2 * $inset)
      $radius = [int]($Size * 0.22)
      $pathObj = New-Object System.Drawing.Drawing2D.GraphicsPath
      try {
        $d = $radius * 2
        $pathObj.AddArc($inset, $inset, $d, $d, 180, 90)
        $pathObj.AddArc($inset + $box - $d, $inset, $d, $d, 270, 90)
        $pathObj.AddArc($inset + $box - $d, $inset + $box - $d, $d, $d, 0, 90)
        $pathObj.AddArc($inset, $inset + $box - $d, $d, $d, 90, 90)
        $pathObj.CloseFigure()
        $brush = New-Object System.Drawing.SolidBrush($accent)
        try { $g.FillPath($brush, $pathObj) } finally { $brush.Dispose() }
      } finally {
        $pathObj.Dispose()
      }

      # "AC" wordmark, centred.
      $fontSize = [float]($Size * 0.34)
      $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
      try {
        $format = New-Object System.Drawing.StringFormat
        $format.Alignment = [System.Drawing.StringAlignment]::Center
        $format.LineAlignment = [System.Drawing.StringAlignment]::Center
        $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
        try {
          $rect = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
          $g.DrawString("NW", $font, $white, $rect, $format)
        } finally {
          $white.Dispose()
        }
      } finally {
        $font.Dispose()
      }
    } finally {
      $g.Dispose()
    }

    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output "wrote $Path ($Size x $Size)"
  } finally {
    $bitmap.Dispose()
  }
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
New-Icon -Size 192 -Path (Join-Path $OutDir "icon-192.png")
New-Icon -Size 512 -Path (Join-Path $OutDir "icon-512.png")
