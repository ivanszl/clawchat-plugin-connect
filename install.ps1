[CmdletBinding()]
param(
  [string]$Version,
  [string]$InstallDirectory,
  [string]$LicenseDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

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
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = $env:CLAWCHAT_CONNECT_VERSION
}
if ([string]::IsNullOrWhiteSpace($Version)) {
  $releaseChannelUrl = "https://raw.githubusercontent.com/$repository/release-channel/latest-alpha.txt"
  $Version = (Invoke-WebRequest -UseBasicParsing -Uri $releaseChannelUrl).Content.Trim()
  if ([string]::IsNullOrWhiteSpace($Version)) {
    throw "Alpha release channel was empty for $repository"
  }
}
if (-not $Version.StartsWith("v")) {
  $Version = "v$Version"
}
if ($Version -notmatch "^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$") {
  throw "Invalid release version: $Version"
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
$transactionStarted = $false
$transactionCommitted = $false
$backupDirectory = Join-Path $temporaryDirectory "backup"
$connectExisted = $false
$livewareExisted = $false
$clientExisted = $false
$skillsExisted = $false
$licensesExisted = $false

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
  $skillsSource = Join-Path $extractedDirectory "skills"
  foreach ($requiredPath in @(
    $connectSource,
    $livewareSource,
    (Join-Path $clientSource "index.html"),
    (Join-Path $skillsSource "manifest.json"),
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
  & $connectSource "--help" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Staged clawchat-connect.exe failed its startup check"
  }
  & $livewareSource "--help" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Staged liveware.exe failed its startup check"
  }
  & $connectSource "skills" "preflight" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Managed Agent skill target failed its preflight check"
  }
  if (Test-Path -LiteralPath $connectTarget) {
    $stopArguments = @("service", "stop")
    & $connectTarget @stopArguments 2>$null | Out-Null
    Start-Sleep -Milliseconds 500
  }

  $connectStaging = "$connectTarget.new"
  $livewareStaging = "$livewareTarget.new"
  Copy-Item -LiteralPath $connectSource -Destination $connectStaging -Force
  Copy-Item -LiteralPath $livewareSource -Destination $livewareStaging -Force
  $clientTarget = Join-Path $InstallDirectory "clawchat-connect-client"
  $clientStaging = "$clientTarget.new"
  if (Test-Path -LiteralPath $clientStaging) {
    Remove-Item -LiteralPath $clientStaging -Recurse -Force
  }
  Copy-Item -LiteralPath $clientSource -Destination $clientStaging -Recurse
  $skillsBundleTarget = Join-Path $InstallDirectory "skills"
  $skillsBundleStaging = "$skillsBundleTarget.new"
  if (Test-Path -LiteralPath $skillsBundleStaging) {
    Remove-Item -LiteralPath $skillsBundleStaging -Recurse -Force
  }
  Copy-Item -LiteralPath $skillsSource -Destination $skillsBundleStaging -Recurse
  $licenseStaging = Join-Path $temporaryDirectory "licenses-new"
  New-Item -ItemType Directory -Path $licenseStaging | Out-Null
  Copy-Item -LiteralPath (Join-Path $extractedDirectory "CHANGELOG.md") -Destination $licenseStaging
  Copy-Item -LiteralPath (Join-Path $extractedDirectory "LICENSE") -Destination $licenseStaging
  Copy-Item -LiteralPath (Join-Path $extractedDirectory "THIRD_PARTY_NOTICES.md") -Destination $licenseStaging

  New-Item -ItemType Directory -Path $backupDirectory | Out-Null
  $targets = @(
    @{ Target = $connectTarget; Backup = (Join-Path $backupDirectory "connect"); Name = "connect" },
    @{ Target = $livewareTarget; Backup = (Join-Path $backupDirectory "liveware"); Name = "liveware" },
    @{ Target = $clientTarget; Backup = (Join-Path $backupDirectory "client"); Name = "client" },
    @{ Target = $skillsBundleTarget; Backup = (Join-Path $backupDirectory "skills"); Name = "skills" },
    @{ Target = $LicenseDirectory; Backup = (Join-Path $backupDirectory "licenses"); Name = "licenses" }
  )
  foreach ($entry in $targets) {
    if (Test-Path -LiteralPath $entry.Target) {
      Copy-Item -LiteralPath $entry.Target -Destination $entry.Backup -Recurse
      Set-Variable -Name ($entry.Name + "Existed") -Value $true
    }
  }
  $transactionStarted = $true
  foreach ($entry in $targets) {
    if (Test-Path -LiteralPath $entry.Target) {
      Remove-Item -LiteralPath $entry.Target -Recurse -Force
    }
  }
  Move-Item -LiteralPath $connectStaging -Destination $connectTarget
  Move-Item -LiteralPath $livewareStaging -Destination $livewareTarget
  Move-Item -LiteralPath $clientStaging -Destination $clientTarget
  Move-Item -LiteralPath $skillsBundleStaging -Destination $skillsBundleTarget
  New-Item -ItemType Directory -Path (Split-Path -Parent $LicenseDirectory) -Force | Out-Null
  Move-Item -LiteralPath $licenseStaging -Destination $LicenseDirectory

  & $connectTarget "skills" "install" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Managed Agent skill installation failed"
  }
  $transactionCommitted = $true

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

  Write-Host "Installed clawchat-connect.exe to $connectTarget"
  Write-Host "Installed bundled Liveware to $livewareTarget"
  Write-Host "Installed Connect Client assets to $clientTarget"
  Write-Host "Installed managed Agent skills to $HOME\.agents\skills"
  Write-Host "Run 'clawchat-connect init --agent work --kind codex' to begin."
} catch {
  if ($transactionStarted -and -not $transactionCommitted) {
    foreach ($entry in $targets) {
      if (Test-Path -LiteralPath $entry.Target) {
        Remove-Item -LiteralPath $entry.Target -Recurse -Force
      }
      $existed = Get-Variable -Name ($entry.Name + "Existed") -ValueOnly
      if ($existed) {
        Copy-Item -LiteralPath $entry.Backup -Destination $entry.Target -Recurse
      }
    }
  }
  throw
} finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
