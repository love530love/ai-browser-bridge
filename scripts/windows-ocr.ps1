param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [string]$Language = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  if (-not $asTaskGeneric) { throw 'windows_runtime_as_task_missing' }
} catch {
  [pscustomobject]@{
    error = 'ocr_runtime_unavailable'
    message = [string]$_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 2
}

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$available = @()
try {
  $available = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { [string]$_.LanguageTag })
} catch {
  $available = @()
}

try {
  $selected = ''
  if ($Language) {
    $selected = @($available | Where-Object { $_ -ieq $Language })[0]
    if (-not $selected) {
      $prefixMatches = @($available | Where-Object { $_ -like "$Language-*" })
      if ($prefixMatches.Count -eq 1) { $selected = $prefixMatches[0] }
    }
    if (-not $selected) {
      [pscustomobject]@{
        error = 'ocr_language_unavailable'
        requestedLanguage = $Language
        availableLanguages = @($available)
      } | ConvertTo-Json -Compress
      exit 3
    }
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  if ($decoder.PixelWidth -gt $maxDimension -or $decoder.PixelHeight -gt $maxDimension) {
    [pscustomobject]@{
      error = 'image_too_large'
      width = [int]$decoder.PixelWidth
      height = [int]$decoder.PixelHeight
      maxDimension = [int]$maxDimension
    } | ConvertTo-Json -Compress
    exit 5
  }

  if ($selected) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($selected))
  } else {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  }
  if (-not $engine) {
    [pscustomobject]@{
      error = 'ocr_engine_unavailable'
      requestedLanguage = $(if ($Language) { $Language } else { $null })
      availableLanguages = @($available)
    } | ConvertTo-Json -Compress
    exit 4
  }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @(foreach ($line in $result.Lines) {
    $words = @(foreach ($word in $line.Words) {
      [pscustomobject]@{
        text = [string]$word.Text
        x = [double]$word.BoundingRect.X
        y = [double]$word.BoundingRect.Y
        width = [double]$word.BoundingRect.Width
        height = [double]$word.BoundingRect.Height
      }
    })
    if ($words.Count -eq 0) { continue }
    $left = ($words | Measure-Object -Property x -Minimum).Minimum
    $top = ($words | Measure-Object -Property y -Minimum).Minimum
    $right = ($words | ForEach-Object { $_.x + $_.width } | Measure-Object -Maximum).Maximum
    $bottom = ($words | ForEach-Object { $_.y + $_.height } | Measure-Object -Maximum).Maximum
    [pscustomobject]@{
      text = [string]$line.Text
      x = [double]$left
      y = [double]$top
      width = [double]($right - $left)
      height = [double]($bottom - $top)
      words = $words
    }
  })

  [pscustomobject]@{
    language = [string]$engine.RecognizerLanguage.LanguageTag
    requestedLanguage = $(if ($Language) { $Language } else { $null })
    availableLanguages = @($available)
    width = [int]$decoder.PixelWidth
    height = [int]$decoder.PixelHeight
    maxDimension = [int]$maxDimension
    lines = @($lines)
  } | ConvertTo-Json -Depth 6 -Compress
} catch {
  [pscustomobject]@{
    error = 'ocr_failed'
    message = [string]$_.Exception.Message
    availableLanguages = @($available)
  } | ConvertTo-Json -Compress
  exit 6
}
