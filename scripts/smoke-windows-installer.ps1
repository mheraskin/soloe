$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function assertExists([string] $path) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Expected installed file was not found: $path"
  }
}

function assertMissing([string] $path) {
  if (Test-Path -LiteralPath $path) {
    throw "Expected uninstalled file to be absent: $path"
  }
}

function invokeSilent([string] $path) {
  $process = Start-Process -FilePath $path -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer process exited with code $($process.ExitCode): $path"
  }
}

$installers = @(Get-ChildItem -Path 'release' -Filter 'Soloe-*-windows-x64.exe' -File)
if ($installers.Count -ne 1) {
  throw "Expected exactly one Windows installer, found $($installers.Count)"
}

$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\soloe'
$installedExecutable = Join-Path $installRoot 'Soloe.exe'
$uninstaller = Join-Path $installRoot 'Uninstall Soloe.exe'

assertMissing $installRoot
invokeSilent $installers[0].FullName

try {
  assertExists $installedExecutable
  assertExists $uninstaller

  $productName = (Get-Item -LiteralPath $installedExecutable).VersionInfo.ProductName
  if ($productName -ne 'Soloe') {
    throw "Installed executable has unexpected product name: $productName"
  }
} finally {
  if (Test-Path -LiteralPath $uninstaller) {
    invokeSilent $uninstaller
  }
}

for ($attempt = 0; $attempt -lt 40 -and (Test-Path -LiteralPath $installRoot); $attempt++) {
  Start-Sleep -Milliseconds 500
}

assertMissing $installRoot
Write-Host 'Windows installer install and uninstall smoke test passed'
