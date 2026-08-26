param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxWidth = 720,
  [int]$Quality = 70
)

# Downscales a screenshot to JPEG so live view stays cheap over Tailscale.
# Full-resolution PNG is still served by the non-live screenshot endpoint.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile($In)
try {
  $width = $source.Width
  $height = $source.Height
  if ($width -gt $MaxWidth) {
    $scale = $MaxWidth / $width
    $width = [int]($source.Width * $scale)
    $height = [int]($source.Height * $scale)
  }

  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($source, 0, 0, $width, $height)
    } finally {
      $graphics.Dispose()
    }

    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
    $bitmap.Save($Out, $codec, $params)
  } finally {
    $bitmap.Dispose()
  }
} finally {
  $source.Dispose()
}

Write-Output "OK $width x $height"
