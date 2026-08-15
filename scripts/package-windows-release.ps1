param(
  [Parameter(Mandatory = $true)][string]$ConnectExecutable,
  [Parameter(Mandatory = $true)][string]$ClientDirectory,
  [Parameter(Mandatory = $true)][string]$LivewareExecutable,
  [Parameter(Mandatory = $true)][string]$OfficialPluginsDirectory,
  [Parameter(Mandatory = $true)][string]$OutputArchive
)

$ErrorActionPreference = "Stop"

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$SkillsDirectory = Join-Path $RepositoryRoot "skills"
$Changelog = Join-Path $RepositoryRoot "CHANGELOG.md"
$License = Join-Path $RepositoryRoot "LICENSE"
$ClientEntry = Join-Path $ClientDirectory "index.html"
$OutputArchivePath = [System.IO.Path]::GetFullPath($OutputArchive)
$OutputDirectory = Split-Path -Parent $OutputArchivePath
$StagingDirectory = Join-Path (
  [System.IO.Path]::GetTempPath()
) ("clawchat-connect-release-" + [System.Guid]::NewGuid().ToString("N"))
$PayloadRoot = Join-Path $StagingDirectory "clawchat-connect"

if (-not (Test-Path -LiteralPath $ConnectExecutable -PathType Leaf)) {
  throw "Connect executable does not exist: $ConnectExecutable"
}
if (-not (Test-Path -LiteralPath $ClientDirectory -PathType Container)) {
  throw "Client directory does not exist: $ClientDirectory"
}
if (-not (Test-Path -LiteralPath $ClientEntry -PathType Leaf)) {
  throw "Client entry point does not exist: $ClientEntry"
}
if (-not (Test-Path -LiteralPath $LivewareExecutable -PathType Leaf)) {
  throw "Liveware executable does not exist: $LivewareExecutable"
}
if (-not (Test-Path -LiteralPath $OfficialPluginsDirectory -PathType Container)) {
  throw "Official Plugins directory does not exist: $OfficialPluginsDirectory"
}
foreach ($OfficialPluginId in @(
  "clawling.runtime.codex",
  "clawling.runtime.opencode",
  "clawling.runtime.workbuddy"
)) {
  if (@(Get-ChildItem -LiteralPath $OfficialPluginsDirectory -Filter "$OfficialPluginId-*.connect-plugin" -File).Count -eq 0) {
    throw "Official Plugin Bundle does not exist for ${OfficialPluginId}: $OfficialPluginsDirectory"
  }
}
if (-not (Test-Path -LiteralPath $SkillsDirectory -PathType Container)) {
  throw "Skills directory does not exist: $SkillsDirectory"
}
foreach ($SupportFile in @($Changelog, $License)) {
  if (-not (Test-Path -LiteralPath $SupportFile -PathType Leaf)) {
    throw "Release support file does not exist: $SupportFile"
  }
}
if (Test-Path -LiteralPath $OutputArchivePath) {
  throw "Output archive already exists: $OutputArchivePath"
}

try {
  New-Item -ItemType Directory -Path $PayloadRoot | Out-Null
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

  Copy-Item -LiteralPath $ConnectExecutable -Destination (Join-Path $PayloadRoot "clawchat-connect.exe")
  Copy-Item -LiteralPath $LivewareExecutable -Destination (Join-Path $PayloadRoot "liveware.exe")
  Copy-Item -LiteralPath $ClientDirectory -Destination (Join-Path $PayloadRoot "clawchat-connect-client") -Recurse
  Copy-Item -LiteralPath $OfficialPluginsDirectory -Destination (Join-Path $PayloadRoot "official-plugins") -Recurse
  Copy-Item -LiteralPath $SkillsDirectory -Destination (Join-Path $PayloadRoot "skills") -Recurse
  Copy-Item -LiteralPath $Changelog -Destination $PayloadRoot
  Copy-Item -LiteralPath $License -Destination $PayloadRoot

  Compress-Archive -Path (Join-Path $PayloadRoot "*") -DestinationPath $OutputArchivePath
} finally {
  if (Test-Path -LiteralPath $StagingDirectory) {
    Remove-Item -LiteralPath $StagingDirectory -Recurse -Force
  }
}
