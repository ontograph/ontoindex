param(
  [string]$Repo = $env:ONTOINDEX_GITHUB_REPO,
  [string]$NpmPrefix = $env:ONTOINDEX_NPM_PREFIX,
  [switch]$ForceUserPrefix
)

$ErrorActionPreference = "Stop"

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
  if ($IsWindows -or $env:OS -eq "Windows_NT") {
    & cmd.exe /d /c $npmCommand @Arguments
  } else {
    & $npmCommand @Arguments
  }
  if ($LASTEXITCODE -ne 0) {
    throw "npm failed with exit code $LASTEXITCODE"
  }
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

$nodeMajor = Get-NodeMajorVersion
$npmVersion = Get-NpmVersion
if ($nodeMajor -ge 24) {
  throw "OntoIndex currently supports Node.js 20.x and 22.x for published installs. Detected Node.js $nodeMajor.x. tree-sitter@0.25.0 falls back to a native build that fails on Node 24 because it still compiles with C++17 while Node 24 requires C++20. Update your active Node.js runtime to 22 LTS or 20 LTS, then rerun this installer. Recommended on Windows: use nvm-windows to install and activate Node.js 22 LTS before retrying."
}
if (($IsWindows -or $env:OS -eq "Windows_NT") -and $nodeMajor -eq 22 -and -not (Test-VersionAtLeast -Version $npmVersion -Minimum "11.6.0")) {
  throw "OntoIndex on Windows with Node.js 22.x requires npm 11.6.0 or newer. Detected npm $npmVersion. Older npm releases bundle node-gyp versions that can fail to detect Visual Studio 2026 Build Tools. Run 'npm.cmd install -g npm@11.6.3', verify 'npm --version', then rerun this installer."
}

$apiUrl = "https://api.github.com/repos/$Repo/releases/latest"
$release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "ontoindex-installer" }
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

try {
  if ($ForceUserPrefix) {
    throw "User prefix requested."
  }

  Invoke-Npm @("install", "-g", $assetUrl)
  $binPath = Find-OntoIndexCommand ""
} catch {
  Write-Host "Global install failed or was skipped: $($_.Exception.Message)"
  Write-WindowsRepairInstructions $defaultPrefix
  Write-Host "Installing into user npm prefix: $NpmPrefix"
  New-Item -ItemType Directory -Force -Path $NpmPrefix | Out-Null
  try {
    Invoke-Npm @("install", "-g", "--prefix", $NpmPrefix, $assetUrl)
  } catch {
    Write-WindowsRepairInstructions $NpmPrefix
    throw
  }

  if (($env:Path -split ';') -notcontains $NpmPrefix) {
    $env:Path = "$NpmPrefix;$env:Path"
  }

  $installPrefix = $NpmPrefix
  $binPath = Find-OntoIndexCommand $NpmPrefix
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

if (($env:Path -split ';') -notcontains $NpmPrefix -and (Test-Path (Join-Path $NpmPrefix "ontoindex.cmd"))) {
  Write-Host ""
  Write-Host "Add this directory to your user PATH if ontoindex is not available in new terminals:"
  Write-Host "  $NpmPrefix"
  Write-Host ""
  Write-Host "PowerShell one-liner:"
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$NpmPrefix', 'User')"
}
