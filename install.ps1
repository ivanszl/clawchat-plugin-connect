[CmdletBinding()]
param(
  [string]$Version,
  [string]$InstallDirectory,
  [string]$LicenseDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = if ($env:CLAWCHAT_CONNECT_VERSION) { $env:CLAWCHAT_CONNECT_VERSION } else { "v0.1.0-alpha.6" }
}
if (-not $Version.StartsWith("v")) {
  $Version = "v$Version"
}
if ($Version -notmatch "^v[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$") {
  throw "Only alpha versions are available (for example: v0.1.0-alpha.6)"
}

$localApplicationData = if ($env:LOCALAPPDATA) {
  $env:LOCALAPPDATA
} else {
  Join-Path $HOME "AppData\Local"
}
if ([string]::IsNullOrWhiteSpace($InstallDirectory)) {
  $InstallDirectory = if ($env:CLAWCHAT_CONNECT_INSTALL_DIR) {
    $env:CLAWCHAT_CONNECT_INSTALL_DIR
  } else {
    Join-Path $localApplicationData "ClawChatConnect\bin"
  }
}
if ([string]::IsNullOrWhiteSpace($LicenseDirectory)) {
  $LicenseDirectory = if ($env:CLAWCHAT_CONNECT_LICENSE_DIR) {
    $env:CLAWCHAT_CONNECT_LICENSE_DIR
  } else {
    Join-Path $localApplicationData "ClawChatConnect\licenses"
  }
}

$repository = if ($env:CLAWCHAT_CONNECT_REPOSITORY) {
  $env:CLAWCHAT_CONNECT_REPOSITORY
} else {
  "XMethues/clawchat-plugin-connect"
}
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$releaseArchitecture = switch ($architecture) {
  "X64" { "x64" }
  "Arm64" { "arm64" }
  default { throw "Unsupported Windows architecture: $architecture" }
}
$asset = "clawchat-connect-windows-$releaseArchitecture.zip"
$baseUrl = "https://github.com/$repository/releases/download/$Version"
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("clawchat-connect-" + [Guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $temporaryDirectory $asset
$checksumsPath = Join-Path $temporaryDirectory "checksums.txt"
$extractedDirectory = Join-Path $temporaryDirectory "extracted"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

try {
  Write-Host "Downloading ClawChat Connect $Version for Windows $releaseArchitecture..."
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$asset" -OutFile $archivePath
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/checksums.txt" -OutFile $checksumsPath

  $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object {
    $checksumParts = $_ -split "\s+", 2
    $checksumParts.Count -eq 2 -and $checksumParts[1].TrimStart([char]"*") -eq $asset
  } | Select-Object -First 1
  if (-not $checksumLine) {
    throw "Release checksum for $asset was not found"
  }
  $expectedChecksum = (($checksumLine -split "\s+", 2)[0]).ToLowerInvariant()
  $actualChecksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
  if ($actualChecksum -ne $expectedChecksum) {
    throw "Checksum verification failed for $asset"
  }

  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractedDirectory
  $connectSource = Join-Path $extractedDirectory "clawchat-connect.exe"
  $livewareSource = Join-Path $extractedDirectory "liveware.exe"
  $clientSource = Join-Path $extractedDirectory "clawchat-connect-client"
  foreach ($requiredPath in @(
    $connectSource,
    $livewareSource,
    (Join-Path $clientSource "index.html"),
    (Join-Path $extractedDirectory "CHANGELOG.md"),
    (Join-Path $extractedDirectory "LICENSE"),
    (Join-Path $extractedDirectory "THIRD_PARTY_NOTICES.md")
  )) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
      throw "Release archive is missing $requiredPath"
    }
  }

  New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
  $connectTarget = Join-Path $InstallDirectory "clawchat-connect.exe"
  $livewareTarget = Join-Path $InstallDirectory "liveware.exe"
  if (Test-Path -LiteralPath $connectTarget) {
    $stopArguments = @("service", "stop")
    & $connectTarget @stopArguments 2>$null | Out-Null
    Start-Sleep -Milliseconds 500
  }

  $connectStaging = "$connectTarget.new"
  $livewareStaging = "$livewareTarget.new"
  Copy-Item -LiteralPath $connectSource -Destination $connectStaging -Force
  Copy-Item -LiteralPath $livewareSource -Destination $livewareStaging -Force
  Move-Item -LiteralPath $connectStaging -Destination $connectTarget -Force
  Move-Item -LiteralPath $livewareStaging -Destination $livewareTarget -Force

  $clientTarget = Join-Path $InstallDirectory "clawchat-connect-client"
  $clientStaging = "$clientTarget.new"
  if (Test-Path -LiteralPath $clientStaging) {
    Remove-Item -LiteralPath $clientStaging -Recurse -Force
  }
  Copy-Item -LiteralPath $clientSource -Destination $clientStaging -Recurse
  if (Test-Path -LiteralPath $clientTarget) {
    Remove-Item -LiteralPath $clientTarget -Recurse -Force
  }
  Move-Item -LiteralPath $clientStaging -Destination $clientTarget

  New-Item -ItemType Directory -Path $LicenseDirectory -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $extractedDirectory "CHANGELOG.md") -Destination $LicenseDirectory -Force
  Copy-Item -LiteralPath (Join-Path $extractedDirectory "LICENSE") -Destination $LicenseDirectory -Force
  Copy-Item -LiteralPath (Join-Path $extractedDirectory "THIRD_PARTY_NOTICES.md") -Destination $LicenseDirectory -Force

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($null -eq $userPath) {
    $userPath = ""
  }
  $normalizedInstallDirectory = $InstallDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar)
  $pathContainsInstallDirectory = @($userPath -split ";" | Where-Object {
    $_.TrimEnd([IO.Path]::DirectorySeparatorChar) -ieq $normalizedInstallDirectory
  }).Count -gt 0
  if (-not $pathContainsInstallDirectory) {
    $updatedUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
      $InstallDirectory
    } else {
      "$userPath;$InstallDirectory"
    }
    [Environment]::SetEnvironmentVariable("Path", $updatedUserPath, "User")
  }
  $env:PATH = "$InstallDirectory;$env:PATH"

  & $connectTarget "--help" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Installed clawchat-connect.exe failed its startup check"
  }
  & $livewareTarget "--help" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Installed liveware.exe failed its startup check"
  }

  Write-Host "Installed clawchat-connect.exe to $connectTarget"
  Write-Host "Installed bundled Liveware to $livewareTarget"
  Write-Host "Installed Connect Client assets to $clientTarget"
  Write-Host "Run 'clawchat-connect init --agent work --kind codex' to begin."
} finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
