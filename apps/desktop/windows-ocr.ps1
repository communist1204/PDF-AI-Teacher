$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$stream = $null
$writer = $null
$bitmap = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  function AwaitOperation($operation, [Type] $resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.GetAwaiter().GetResult()
  }
  $language = [Windows.Globalization.Language]::new('zh-Hans-CN')
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) { throw 'OCR_LANGUAGE_UNAVAILABLE' }
  # Input comes from the main process crop only; no paths, clipboard or screen polling.
  $inputText = [Console]::In.ReadToEnd()
  if ($inputText.Length -gt 24000000) { throw 'OCR_IMAGE_TOO_LARGE' }
  $bytes = [Convert]::FromBase64String($inputText.Trim())
  $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
  $writer = [Windows.Storage.Streams.DataWriter]::new($stream)
  $writer.WriteBytes($bytes)
  $null = AwaitOperation ($writer.StoreAsync()) ([UInt32])
  $null = $writer.DetachStream()
  $writer.Dispose(); $writer = $null
  $stream.Seek(0)
  $decoder = AwaitOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  if ($decoder.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $decoder.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'OCR_IMAGE_TOO_LARGE' }
  $bitmap = AwaitOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = AwaitOperation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($result.Lines | ForEach-Object { $_.Text })
  @{ text = ($lines -join "`n"); language = $engine.RecognizerLanguage.LanguageTag } | ConvertTo-Json -Compress | ForEach-Object { [Console]::Out.WriteLine($_) }
} catch {
  # Do not emit raw errors: they can include recognizer input or local machine details.
  $code = if ($_.Exception.Message -match 'OCR_LANGUAGE_UNAVAILABLE') { 'OCR_LANGUAGE_UNAVAILABLE' } elseif ($_.Exception.Message -match 'OCR_IMAGE_TOO_LARGE') { 'OCR_IMAGE_TOO_LARGE' } else { 'OCR_FAILED' }
  [Console]::Out.WriteLine('{"error":"' + $code + '"}')
  exit 1
} finally {
  if ($null -ne $bitmap) { $bitmap.Dispose() }
  if ($null -ne $writer) { $writer.Dispose() }
  if ($null -ne $stream) { $stream.Dispose() }
}
