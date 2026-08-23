param(
  [Parameter(Mandatory = $true)][string]$In
)

# Average hash (aHash): shrink to 8x8 greyscale, then each pixel becomes one bit
# depending on whether it is brighter than the frame's mean. Two frames of the
# same still screen give the same hash; a Hamming distance of a few bits absorbs
# minor animation like a ticking timer.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile($In)
try {
  $size = 8
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($source, 0, 0, $size, $size)
    } finally {
      $graphics.Dispose()
    }

    $grey = New-Object 'double[]' ($size * $size)
    $total = 0.0
    for ($y = 0; $y -lt $size; $y++) {
      for ($x = 0; $x -lt $size; $x++) {
        $pixel = $bitmap.GetPixel($x, $y)
        $value = (0.299 * $pixel.R) + (0.587 * $pixel.G) + (0.114 * $pixel.B)
        $grey[($y * $size) + $x] = $value
        $total += $value
      }
    }

    $mean = $total / ($size * $size)
    $bits = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $grey.Length; $i++) {
      [void]$bits.Append($(if ($grey[$i] -ge $mean) { "1" } else { "0" }))
    }

    # Pack the 64 bits into 16 hex characters.
    $hex = New-Object System.Text.StringBuilder
    $bitString = $bits.ToString()
    for ($i = 0; $i -lt 64; $i += 4) {
      $nibble = [Convert]::ToInt32($bitString.Substring($i, 4), 2)
      [void]$hex.Append($nibble.ToString("x"))
    }

    Write-Output ("HASH=" + $hex.ToString())
  } finally {
    $bitmap.Dispose()
  }
} finally {
  $source.Dispose()
}
