param([string]$Url,[long]$Start,[long]$End,[string]$OutputPath,[string]$HeaderPath)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::DefaultConnectionLimit = 16
$request = [Net.HttpWebRequest]::Create($Url)
$request.AddRange($Start, $End)
$request.Timeout = 90000
$request.ReadWriteTimeout = 90000
$response = $null
$inputStream = $null
$outputStream = $null
try {
  $response = $request.GetResponse()
  $range = $response.Headers['Content-Range']
  [IO.File]::WriteAllText($HeaderPath, ('content-range: ' + $range))
  $inputStream = $response.GetResponseStream()
  $outputStream = [IO.File]::Create($OutputPath)
  $inputStream.CopyTo($outputStream)
} finally {
  if ($outputStream) { $outputStream.Dispose() }
  if ($inputStream) { $inputStream.Dispose() }
  if ($response) { $response.Dispose() }
}
