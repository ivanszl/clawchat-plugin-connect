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
$officialPluginBundles = @(
  "clawling.runtime.codex-0.0.0-test-win32.connect-plugin",
  "clawling.runtime.opencode-0.0.0-test-win32.connect-plugin",
  "clawling.runtime.workbuddy-0.0.0-test-win32.connect-plugin"
)
$originalUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$originalProcessPath = $env:PATH

try {
  New-Item -ItemType Directory -Path $payloadDirectory, $fixtureDirectory, $installDirectory | Out-Null
  & bun build --compile (Join-Path $PSScriptRoot "fixtures\windows-installer-probe.ts") --outfile (Join-Path $payloadDirectory "clawchat-connect.exe")
  if ($LASTEXITCODE -ne 0) { throw "Failed to build Windows installer probe" }
  Copy-Item -LiteralPath (Join-Path $payloadDirectory "clawchat-connect.exe") -Destination (Join-Path $payloadDirectory "liveware.exe")
  New-Item -ItemType Directory -Path (
    Join-Path $payloadDirectory "clawchat-connect-client"
  ), (Join-Path $payloadDirectory "official-plugins"), (Join-Path $payloadDirectory "skills") | Out-Null
  Set-Content -LiteralPath (Join-Path $payloadDirectory "clawchat-connect-client\index.html") -Value "<!doctype html>"
  Set-Content -LiteralPath (Join-Path $payloadDirectory "skills\manifest.json") -Value "{}"
  foreach ($bundle in $officialPluginBundles) {
    Set-Content -LiteralPath (Join-Path $payloadDirectory "official-plugins\$bundle") -Value "installed release"
  }
  Set-Content -LiteralPath (Join-Path $payloadDirectory "CHANGELOG.md") -Value "# Changelog"
  Set-Content -LiteralPath (Join-Path $payloadDirectory "LICENSE") -Value "license"

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

  Remove-Item Env:CONNECT_TEST_INVALID_SKILL_PARENT
  & (Join-Path $repositoryRoot "install.ps1") -Version "v0.0.1" -InstallDirectory $installDirectory -LicenseDirectory $licenseDirectory
  $installedOfficialPlugins = Join-Path $installDirectory "official-plugins"
  $installedBundleNames = @(Get-ChildItem -LiteralPath $installedOfficialPlugins -File -Name | Sort-Object)
  if (Compare-Object -ReferenceObject @($officialPluginBundles | Sort-Object) -DifferenceObject $installedBundleNames) {
    throw "Normal Windows installation did not retain the exact official Plugin Bundles"
  }

  $retiredBundle = "clawling.runtime.retired-0.0.0-test-win32.connect-plugin"
  Set-Content -LiteralPath (Join-Path $installedOfficialPlugins $retiredBundle) -Value "retired installed release"
  $rollbackBundleNames = @($officialPluginBundles + $retiredBundle | Sort-Object)
  $rollbackBundleContents = @{}
  foreach ($bundle in $rollbackBundleNames) {
    $rollbackBundleContents[$bundle] = Get-Content -Raw -LiteralPath (Join-Path $installedOfficialPlugins $bundle)
  }
  foreach ($bundle in $officialPluginBundles) {
    Set-Content -LiteralPath (Join-Path $payloadDirectory "official-plugins\$bundle") -Value "upgrade release"
  }
  Remove-Item -LiteralPath $fixtureArchivePath
  Compress-Archive -Path (Join-Path $payloadDirectory "*") -DestinationPath $fixtureArchivePath
  $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixtureArchivePath).Hash.ToLowerInvariant()
  Set-Content -LiteralPath (Join-Path $fixtureDirectory "checksums.txt") -Value "$archiveHash  $asset"
  $env:CONNECT_TEST_FAIL_SKILLS_INSTALL = "1"
  $rollbackFailure = $null
  try {
    & (Join-Path $repositoryRoot "install.ps1") -Version "v0.0.1" -InstallDirectory $installDirectory -LicenseDirectory $licenseDirectory
  } catch {
    $rollbackFailure = $_
  }
  if (-not $rollbackFailure) { throw "Installer unexpectedly committed a failing upgrade" }
  $rolledBackBundleNames = @(Get-ChildItem -LiteralPath $installedOfficialPlugins -File -Name | Sort-Object)
  if (Compare-Object -ReferenceObject $rollbackBundleNames -DifferenceObject $rolledBackBundleNames) {
    throw "Windows installer rollback left a mixed official Plugin directory"
  }
  foreach ($bundle in $rollbackBundleNames) {
    if ((Get-Content -Raw -LiteralPath (Join-Path $installedOfficialPlugins $bundle)) -ne $rollbackBundleContents[$bundle]) {
      throw "Windows installer rollback did not restore official Plugin Bundle $bundle"
    }
  }
} finally {
  Remove-Item Env:CONNECT_TEST_INSTALLED_BINARY -ErrorAction SilentlyContinue
  Remove-Item Env:CONNECT_TEST_OLD_BINARY_HASH -ErrorAction SilentlyContinue
  Remove-Item Env:CONNECT_TEST_PREFLIGHT_OBSERVATION -ErrorAction SilentlyContinue
  Remove-Item Env:CONNECT_TEST_INVALID_SKILL_PARENT -ErrorAction SilentlyContinue
  Remove-Item Env:CONNECT_TEST_FAIL_SKILLS_INSTALL -ErrorAction SilentlyContinue
  [Environment]::SetEnvironmentVariable("Path", $originalUserPath, "User")
  $env:PATH = $originalProcessPath
  Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

exit 0
