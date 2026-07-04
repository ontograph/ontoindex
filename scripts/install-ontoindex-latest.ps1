param(
  [string]$Repo = $env:ONTOINDEX_GITHUB_REPO,
  [string]$NpmPrefix = $env:ONTOINDEX_NPM_PREFIX,
  [switch]$ForceUserPrefix
)

$ErrorActionPreference = "Stop"

function Get-EnvInt {
  param(
    [string]$Name,
    [int]$Default
  )

  $value = [Environment]::GetEnvironmentVariable($Name)
  $parsed = 0
  if (-not [string]::IsNullOrWhiteSpace($value) -and [int]::TryParse($value, [ref]$parsed) -and $parsed -gt 0) {
    return $parsed
  }

  return $Default
}

function Write-InstallerLog {
  param([string]$Message)

  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Message"
}

function Get-NodeMajorVersion {
  $version = & node -p "process.versions.node"
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to detect Node.js version."
  }

  $major = 0
  if (-not [int]::TryParse(($version -split '\.')[0], [ref]$major)) {
    throw "Unable to parse Node.js version: $version"
  }

  return $major
}

function Get-NpmVersion {
  $npmCommand = Resolve-NpmCommand
  if ($IsWindows -or $env:OS -eq "Windows_NT") {
    $version = & cmd.exe /d /c $npmCommand "--version"
  } else {
    $version = & $npmCommand "--version"
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to detect npm version."
  }

  return $version.Trim()
}

function Test-VersionAtLeast {
  param(
    [string]$Version,
    [string]$Minimum
  )

  $currentParts = $Version.Split('.')
  $minimumParts = $Minimum.Split('.')
  $length = [Math]::Max($currentParts.Length, $minimumParts.Length)

  for ($i = 0; $i -lt $length; $i++) {
    $current = if ($i -lt $currentParts.Length) { [int]$currentParts[$i] } else { 0 }
    $required = if ($i -lt $minimumParts.Length) { [int]$minimumParts[$i] } else { 0 }

    if ($current -gt $required) {
      return $true
    }

    if ($current -lt $required) {
      return $false
    }
  }

  return $true
}

if ([string]::IsNullOrWhiteSpace($Repo)) {
  $Repo = "ontograph/ontoindex"
}

function Require-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name. Install Node.js LTS first, then rerun this script."
  }
}

function Resolve-WgetCommand {
  $wgetExe = Get-Command "wget.exe" -ErrorAction SilentlyContinue
  if ($wgetExe) {
    return $wgetExe
  }

  $wget = Get-Command "wget" -ErrorAction SilentlyContinue
  if ($wget) {
    return $wget
  }

  throw "Required command not found: wget. Install wget or use a PowerShell environment where the wget alias is available, then rerun this script."
}

function Invoke-WgetDownload {
  param(
    [string]$Uri,
    [string]$OutFile,
    [int]$TimeoutSec
  )

  $wget = Resolve-WgetCommand
  if ($wget.CommandType -eq "Application") {
    & $wget.Source `
      "--user-agent=ontoindex-installer" `
      "--tries=3" `
      "--waitretry=2" `
      "--timeout=$TimeoutSec" `
      "--read-timeout=$TimeoutSec" `
      "-O" $OutFile `
      $Uri
    if ($LASTEXITCODE -ne 0) {
      throw "wget download failed with exit code $LASTEXITCODE"
    }
    return
  }

  & $wget.Source -UseBasicParsing -Uri $Uri -OutFile $OutFile -TimeoutSec $TimeoutSec -Headers @{ "User-Agent" = "ontoindex-installer" }
}

function Invoke-WgetJson {
  param(
    [string]$Uri,
    [int]$TimeoutSec
  )

  $wget = Resolve-WgetCommand
  if ($wget.CommandType -eq "Application") {
    $json = & $wget.Source `
      "--user-agent=ontoindex-installer" `
      "--tries=3" `
      "--waitretry=2" `
      "--timeout=$TimeoutSec" `
      "--read-timeout=$TimeoutSec" `
      "-qO-" `
      $Uri
    if ($LASTEXITCODE -ne 0) {
      throw "wget metadata fetch failed with exit code $LASTEXITCODE"
    }
    return $json | ConvertFrom-Json
  }

  return & $wget.Source -UseBasicParsing -Uri $Uri -TimeoutSec $TimeoutSec -Headers @{ "User-Agent" = "ontoindex-installer" } | ConvertFrom-Json
}
function Resolve-NpmCommand {
  if ($IsWindows -or $env:OS -eq "Windows_NT") {
    $npmCmd = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
    if ($npmCmd) {
      return $npmCmd.Source
    }
  }

  $npm = Get-Command "npm" -ErrorAction SilentlyContinue
  if ($npm) {
    return $npm.Source
  }

  throw "Required command not found: npm. Install Node.js LTS first, then rerun this script."
}

function Invoke-Npm {
  param([string[]]$Arguments)

  $npmCommand = Resolve-NpmCommand
  Write-InstallerLog "Running npm $($Arguments -join ' ')"
  if ($IsWindows -or $env:OS -eq "Windows_NT") {
    & cmd.exe /d /c $npmCommand @Arguments
  } else {
    & $npmCommand @Arguments
  }
  if ($LASTEXITCODE -ne 0) {
    throw "npm failed with exit code $LASTEXITCODE"
  }
  Write-InstallerLog "npm command completed"
}

function Invoke-NpmCapture {
  param([string[]]$Arguments)

  $npmCommand = Resolve-NpmCommand
  if ($IsWindows -or $env:OS -eq "Windows_NT") {
    $output = & cmd.exe /d /c $npmCommand @Arguments
  } else {
    $output = & $npmCommand @Arguments
  }
  if ($LASTEXITCODE -ne 0) {
    throw "npm failed with exit code $LASTEXITCODE"
  }

  return ($output | Out-String).Trim()
}

function Get-DefaultUserPrefix {
  if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
    return (Join-Path $env:APPDATA "npm")
  }

  return (Join-Path $HOME ".npm-global")
}

function Find-OntoIndexCommand {
  param([string]$Prefix)

  if ($IsWindows -or $env:OS -eq "Windows_NT") {
    $existingCmd = Get-Command "ontoindex.cmd" -ErrorAction SilentlyContinue
    if ($existingCmd) {
      return $existingCmd.Source
    }
  }

  $existing = Get-Command "ontoindex" -ErrorAction SilentlyContinue
  if ($existing -and -not (($IsWindows -or $env:OS -eq "Windows_NT") -and $existing.Source -like "*.ps1")) {
    return $existing.Source
  }

  if (-not [string]::IsNullOrWhiteSpace($Prefix)) {
    $candidates = @(
      (Join-Path $Prefix "ontoindex.cmd"),
      (Join-Path $Prefix "ontoindex.ps1"),
      (Join-Path (Join-Path $Prefix "bin") "ontoindex")
    )

    foreach ($candidate in $candidates) {
      if (Test-Path $candidate) {
        return $candidate
      }
    }
  }

  return $null
}

function Get-NpmPrefixPath {
  param([string]$Prefix)

  if (-not [string]::IsNullOrWhiteSpace($Prefix)) {
    return $Prefix
  }

  return (Invoke-NpmCapture @("config", "get", "prefix"))
}

function Get-NpmRootPath {
  param([string]$Prefix)

  if (-not [string]::IsNullOrWhiteSpace($Prefix)) {
    return (Invoke-NpmCapture @("root", "-g", "--prefix", $Prefix))
  }

  return (Invoke-NpmCapture @("root", "-g"))
}

function Get-OntoIndexInstallState {
  param([string]$Prefix)

  $resolvedPrefix = Get-NpmPrefixPath $Prefix
  $nodeModulesRoot = Get-NpmRootPath $Prefix
  $packageDir = Join-Path $nodeModulesRoot "ontoindex"
  $cliPath = Join-Path $packageDir "dist\\cli\\index.js"

  return [pscustomobject]@{
    Prefix = $resolvedPrefix
    NodeModulesRoot = $nodeModulesRoot
    PackageDir = $packageDir
    PackageJson = Join-Path $packageDir "package.json"
    CliPath = $cliPath
    CmdShim = Join-Path $resolvedPrefix "ontoindex.cmd"
    Ps1Shim = Join-Path $resolvedPrefix "ontoindex.ps1"
  }
}

function Save-ReleaseAsset {
  param(
    [string]$AssetUrl,
    [string]$AssetName
  )

  $timeoutSeconds = Get-EnvInt -Name "ONTOINDEX_INSTALL_DOWNLOAD_TIMEOUT_SEC" -Default 1600
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ontoindex-install-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
  $assetPath = Join-Path $tempDir $AssetName
  $lastError = $null

  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Write-InstallerLog "Downloading release asset to $assetPath (attempt $attempt/3, timeout ${timeoutSeconds}s)"
      Invoke-WgetDownload -Uri $AssetUrl -OutFile $assetPath -TimeoutSec $timeoutSeconds
      $assetSize = (Get-Item $assetPath).Length
      if ($assetSize -gt 0) {
        Write-InstallerLog "Downloaded $AssetName ($assetSize bytes)"
        return [pscustomobject]@{
          Path = $assetPath
          TempDir = $tempDir
        }
      }

      throw "Downloaded asset is empty."
    } catch {
      $lastError = $_.Exception.Message
      Write-InstallerLog "Download attempt $attempt failed: $lastError"
      Remove-Item $assetPath -Force -ErrorAction SilentlyContinue
      if ($attempt -lt 3) {
        $sleepSeconds = 2 * $attempt
        Write-InstallerLog "Retrying download in ${sleepSeconds}s"
        Start-Sleep -Seconds $sleepSeconds
      }
    }
  }

  Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  throw "Failed to download OntoIndex release asset after 3 attempts: $lastError"
}

function Get-LadybugExtensionsCachePath {
  $configured = [Environment]::GetEnvironmentVariable("ONTOINDEX_LADYBUG_EXTENSIONS_CACHE")
  if (-not [string]::IsNullOrWhiteSpace($configured)) {
    return $configured
  }

  $base = if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    Join-Path $env:LOCALAPPDATA "ontoindex\ladybugdb-extensions"
  } else {
    Join-Path $HOME ".cache\ontoindex\ladybugdb-extensions"
  }

  return (Join-Path $base "v0.17.0\win_amd64")
}

function Download-LadybugExtensions {
  if ([Environment]::GetEnvironmentVariable("ONTOINDEX_SKIP_LADYBUG_EXTENSIONS") -eq "1") {
    Write-InstallerLog "Skipping LadybugDB extension cache prefetch: ONTOINDEX_SKIP_LADYBUG_EXTENSIONS=1"
    return
  }

  if (-not ($IsWindows -or $env:OS -eq "Windows_NT")) {
    return
  }

  $require = [Environment]::GetEnvironmentVariable("ONTOINDEX_REQUIRE_LADYBUG_EXTENSIONS")
  $cacheDir = Get-LadybugExtensionsCachePath
  $baseUrl = [Environment]::GetEnvironmentVariable("ONTOINDEX_LADYBUG_EXTENSIONS_BASE_URL")
  if ([string]::IsNullOrWhiteSpace($baseUrl)) {
    $baseUrl = "https://extension.ladybugdb.com/v0.17.0/win_amd64"
  }
  $timeoutSeconds = Get-EnvInt -Name "ONTOINDEX_INSTALL_DOWNLOAD_TIMEOUT_SEC" -Default 600

  try {
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    Write-InstallerLog "Prefetching LadybugDB fts/vector extensions into $cacheDir"

    foreach ($asset in @(
      @{ File = "libfts.lbug_extension"; Url = "$baseUrl/fts/libfts.lbug_extension" },
      @{ File = "libvector.lbug_extension"; Url = "$baseUrl/vector/libvector.lbug_extension" }
    )) {
      $assetPath = Join-Path $cacheDir $asset.File
      if ((Test-Path $assetPath) -and ((Get-Item $assetPath).Length -gt 0)) {
        Write-InstallerLog "Using cached $($asset.File)"
        continue
      }

      if (Test-Path $assetPath) {
        Remove-Item $assetPath -Force -ErrorAction SilentlyContinue
      }

      Write-InstallerLog "Downloading $($asset.File) from $($asset.Url)"
      Invoke-WgetDownload -Uri $asset.Url -OutFile $assetPath -TimeoutSec $timeoutSeconds

      if (-not (Test-Path $assetPath) -or ((Get-Item $assetPath).Length -le 0)) {
        throw "Downloaded asset is empty: $($asset.File)"
      }
    }
  } catch {
    Write-Warning "LadybugDB extension prefetch failed; OntoIndex install will continue."
    Write-Warning "Rerun with ONTOINDEX_REQUIRE_LADYBUG_EXTENSIONS=1 to make this fatal."
    if ($require -eq "1") {
      throw
    }
  }
}

function Write-WindowsRepairInstructions {
  param([string]$Prefix)

  if (-not ($IsWindows -or $env:OS -eq "Windows_NT")) {
    return
  }

  $state = Get-OntoIndexInstallState $Prefix

  Write-Host ""
  Write-Host "Repair commands for a broken partial install:"
  Write-Host "  npm.cmd uninstall -g ontoindex"
  Write-Host "  if (Test-Path '$($state.PackageDir)') { Remove-Item '$($state.PackageDir)' -Recurse -Force }"
  Write-Host "  if (Test-Path '$($state.CmdShim)') { Remove-Item '$($state.CmdShim)' -Force }"
  Write-Host "  if (Test-Path '$($state.Ps1Shim)') { Remove-Item '$($state.Ps1Shim)' -Force }"
}

function Remove-ExistingOntoIndexInstall {
  param([string]$Prefix)

  $state = Get-OntoIndexInstallState $Prefix
  $removed = $false

  if (Test-Path $state.PackageDir) {
    Remove-Item $state.PackageDir -Recurse -Force
    $removed = $true
  }

  foreach ($shim in @($state.CmdShim, $state.Ps1Shim)) {
    if (Test-Path $shim) {
      Remove-Item $shim -Force
      $removed = $true
    }
  }

  if ($removed) {
    Write-Host "Removed previous OntoIndex install from $($state.Prefix)"
  }
}

function Test-OntoIndexInstall {
  param(
    [string]$Prefix,
    [string]$BinPath
  )

  $state = Get-OntoIndexInstallState $Prefix

  if (-not (Test-Path $state.PackageJson)) {
    throw "Installed package metadata not found: $($state.PackageJson)"
  }

  if (-not (Test-Path $state.CliPath)) {
    throw "Installed CLI entrypoint not found: $($state.CliPath)"
  }

  Push-Location $state.PackageDir
  try {
    & node -e "require('tree-sitter'); require('@ladybugdb/core')"
    if ($LASTEXITCODE -ne 0) {
      throw "Native dependency smoke test failed."
    }
  } finally {
    Pop-Location
  }

  & $BinPath --version
  if ($LASTEXITCODE -ne 0) {
    throw "Installed ontoindex command failed validation."
  }
}

Require-Command "node"
$null = Resolve-NpmCommand
$null = Resolve-WgetCommand

$nodeMajor = Get-NodeMajorVersion
$npmVersion = Get-NpmVersion
if ($nodeMajor -lt 22) {
  throw "OntoIndex supports Node.js 22.12.0 through Node.js 25.x for published installs. Detected Node.js $nodeMajor.x. commander@15 requires Node.js >=22.12.0, and Windows native installs need newer npm/node-gyp. Recommended on Windows: use nvm-windows to install and activate Node.js 22 LTS or newer before retrying."
}
if ($nodeMajor -eq 22 -and -not (Test-VersionAtLeast -Version ((& node -p "process.versions.node") 2>$null) -Minimum "22.12.0")) {
  throw "OntoIndex requires Node.js 22.12.0 or newer. Detected Node.js $((& node -p "process.versions.node") 2>$null)."
}
if ($nodeMajor -ge 26) {
  throw "OntoIndex supports Node.js 22.12.0 through Node.js 25.x for published installs. Detected Node.js $nodeMajor.x. Node.js $nodeMajor.x has not been validated with the vendored tree-sitter runtime yet. Recommended on Windows: use nvm-windows to install and activate Node.js 22 LTS, 24, or 25 before retrying."
}
if (($IsWindows -or $env:OS -eq "Windows_NT") -and -not (Test-VersionAtLeast -Version $npmVersion -Minimum "11.6.0")) {
  throw "OntoIndex on Windows with Node.js 22.x requires npm 11.6.0 or newer. Detected npm $npmVersion. Older npm releases bundle node-gyp versions that can fail to detect Visual Studio 2026 Build Tools. Run 'npm.cmd install -g npm@11.6.3', verify 'npm --version', then rerun this installer."
}

Download-LadybugExtensions

$apiUrl = "https://api.github.com/repos/$Repo/releases/latest"
$releaseTimeoutSeconds = Get-EnvInt -Name "ONTOINDEX_INSTALL_RELEASE_TIMEOUT_SEC" -Default 600
Write-InstallerLog "Fetching latest release metadata from $apiUrl (timeout ${releaseTimeoutSeconds}s)"
$release = Invoke-WgetJson -Uri $apiUrl -TimeoutSec $releaseTimeoutSeconds
$asset = $release.assets | Where-Object {
  $_.name -match '^ontoindex-[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\.tgz$'
} | Select-Object -First 1

if (-not $asset) {
  throw "No ontoindex tarball asset found on latest release $($release.tag_name)."
}

$assetUrl = $asset.browser_download_url
$version = if ($asset.name -match '^ontoindex-(.+)\.tgz$') { $Matches[1] } else { "unknown" }

if ([string]::IsNullOrWhiteSpace($NpmPrefix)) {
  $NpmPrefix = Get-DefaultUserPrefix
}
$defaultPrefix = Get-NpmPrefixPath ""
$installPrefix = $defaultPrefix

Write-Host "Installing OntoIndex $version from $assetUrl"

$downloadedAsset = Save-ReleaseAsset -AssetUrl $assetUrl -AssetName $asset.name
$installSource = $downloadedAsset.Path
$npmNetworkArgs = @(
  "--loglevel=info",
  "--fetch-retries=3",
  "--fetch-timeout=600000",
  "--fetch-retry-factor=2",
  "--fetch-retry-mintimeout=1000",
  "--fetch-retry-maxtimeout=30000"
)

try {
  try {
    if ($ForceUserPrefix) {
      throw "User prefix requested."
    }

    Remove-ExistingOntoIndexInstall $defaultPrefix
    Invoke-Npm (@("install", "-g") + $npmNetworkArgs + @($installSource))
    $binPath = Find-OntoIndexCommand ""
  } catch {
    $globalInstallError = $_.Exception.Message
    Write-InstallerLog "Global install failed or was skipped: $globalInstallError"
    Write-InstallerLog "Installing into user npm prefix: $NpmPrefix"
    New-Item -ItemType Directory -Force -Path $NpmPrefix | Out-Null
    try {
      Remove-ExistingOntoIndexInstall $NpmPrefix
      Invoke-Npm (@("install", "-g", "--prefix", $NpmPrefix) + $npmNetworkArgs + @($installSource))
    } catch {
      Write-WindowsRepairInstructions $defaultPrefix
      Write-WindowsRepairInstructions $NpmPrefix
      throw
    }

    if (($env:Path -split ';') -notcontains $NpmPrefix) {
      $env:Path = "$NpmPrefix;$env:Path"
    }

    $installPrefix = $NpmPrefix
    $binPath = Find-OntoIndexCommand $NpmPrefix
  }
} finally {
  Remove-Item $downloadedAsset.TempDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ([string]::IsNullOrWhiteSpace($binPath)) {
  throw "Installed ontoindex command was not found. Check npm prefix: $installPrefix"
}

Write-Host "Installed OntoIndex:"
try {
  Test-OntoIndexInstall -Prefix $installPrefix -BinPath $binPath
} catch {
  Write-WindowsRepairInstructions $installPrefix
  throw
}

Write-Host "Note: this installer uses npm to resolve third-party runtime packages."
Write-Host "A non-fatal npm warning about deprecated transitive packages can appear while upstream packages catch up."
Write-Host "For air-gapped installs, use a separately prepared npm cache or internal registry mirror."
Write-Host ""
Write-Host "Next step: run 'ontoindex setup' after installation to configure MCP clients and agent guidance."
Write-Host "The setup command is idempotent and will not duplicate existing OntoIndex settings."

if (($env:Path -split ';') -notcontains $NpmPrefix -and (Test-Path (Join-Path $NpmPrefix "ontoindex.cmd"))) {
  Write-Host ""
  Write-Host "Add this directory to your user PATH if ontoindex is not available in new terminals:"
  Write-Host "  $NpmPrefix"
  Write-Host ""
  Write-Host "PowerShell one-liner:"
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$NpmPrefix', 'User')"
}
