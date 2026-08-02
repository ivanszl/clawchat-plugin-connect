$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("connect-installer-test-" + [Guid]::NewGuid().ToString("N"))
$payloadDirectory = Join-Path $temporaryDirectory "payload"
$fixtureDirectory = Join-Path $temporaryDirectory "fixtures"
$installDirectory = Join-Path $temporaryDirectory "installed"
$licenseDirectory = Join-Path $temporaryDirectory "licenses"
$invalidSkillParent = Join-Path $temporaryDirectory "invalid-skill-parent"
$observationPath = Join-Path $temporaryDirectory "preflight-observation.txt"
$asset = "clawchat-connect-windows-$([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant() -replace 'x64','x64' -replace 'arm64','arm64').zip"

try {
  New-Item -ItemType Directory -Path $payloadDirectory, $fixtureDirectory, $installDirectory | Out-Null
  & bun build --compile (Join-Path $PSScriptRoot "fixtures\windows-installer-probe.ts") --outfile (Join-Path $payloadDirectory "clawchat-connect.exe")
  if ($LASTEXITCODE -ne 0) { throw "Failed to build Windows installer probe" }
  Copy-Item -LiteralPath (Join-Path $payloadDirectory "clawchat-connect.exe") -Destination (Join-Path $payloadDirectory "liveware.exe")
  New-Item -ItemType Directory -Path (Join-Path $payloadDirectory "clawchat-connect-client"), (Join-Path $payloadDirectory "skills") | Out-Null
  Set-Content -LiteralPath (Join-Path $payloadDirectory "clawchat-connect-client\index.html") -Value "<!doctype html>"
  Set-Content -LiteralPath (Join-Path $payloadDirectory "skills\manifest.json") -Value "{}"
  Set-Content -LiteralPath (Join-Path $payloadDirectory "CHANGELOG.md") -Value "# Changelog"
  Set-Content -LiteralPath (Join-Path $payloadDirectory "LICENSE") -Value "license"
  Set-Content -LiteralPath (Join-Path $payloadDirectory "THIRD_PARTY_NOTICES.md") -Value "notices"

  $installedBinary = Join-Path $installDirectory "clawchat-connect.exe"
  Copy-Item -LiteralPath (Join-Path $payloadDirectory "clawchat-connect.exe") -Destination $installedBinary
  Add-Content -LiteralPath $installedBinary -Value "old-release-overlay"
  $oldHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedBinary).Hash.ToLowerInvariant()

  $fixtureArchivePath = Join-Path $fixtureDirectory $asset
  Compress-Archive -Path (Join-Path $payloadDirectory "*") -DestinationPath $fixtureArchivePath
  $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixtureArchivePath).Hash.ToLowerInvariant()
  Set-Content -LiteralPath (Join-Path $fixtureDirectory "checksums.txt") -Value "$archiveHash  $asset"
  Set-Content -LiteralPath $invalidSkillParent -Value "not a directory"

  function global:Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
    if ($Uri.EndsWith("checksums.txt")) {
      Copy-Item -LiteralPath (Join-Path $fixtureDirectory "checksums.txt") -Destination $OutFile
    } else {
      Copy-Item -LiteralPath $fixtureArchivePath -Destination $OutFile
    }
  }

  $env:CONNECT_TEST_INSTALLED_BINARY = $installedBinary
  $env:CONNECT_TEST_OLD_BINARY_HASH = $oldHash
  $env:CONNECT_TEST_PREFLIGHT_OBSERVATION = $observationPath
  $env:CONNECT_TEST_INVALID_SKILL_PARENT = $invalidSkillParent
  $failure = $null
  try {
    & (Join-Path $repositoryRoot "install.ps1") -Version "v0.0.1" -InstallDirectory $installDirectory -LicenseDirectory $licenseDirectory
  } catch {
    $failure = $_
  }
  if (-not $failure) { throw "Installer unexpectedly succeeded with an invalid Skill target" }
  if (-not (Test-Path -LiteralPath $observationPath)) {
    throw "Installer failed before Skill preflight: $($failure.Exception.Message)"
  }
  if ((Get-Content -Raw -LiteralPath $observationPath) -ne "old`n") {
    throw "Installer replaced Connect assets before Skill preflight"
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $installedBinary).Hash.ToLowerInvariant() -ne $oldHash) {
    throw "Installer did not preserve the previous Connect binary"
  }
} finally {
  Remove-Item Env:CONNECT_TEST_INSTALLED_BINARY -ErrorAction SilentlyContinue
  Remove-Item Env:CONNECT_TEST_OLD_BINARY_HASH -ErrorAction SilentlyContinue
  Remove-Item Env:CONNECT_TEST_PREFLIGHT_OBSERVATION -ErrorAction SilentlyContinue
  Remove-Item Env:CONNECT_TEST_INVALID_SKILL_PARENT -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
