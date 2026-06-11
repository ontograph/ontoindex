param(
  [string]$Repo = $env:ONTOINDEX_GITHUB_REPO,
  [string]$NpmPrefix = $env:ONTOINDEX_NPM_PREFIX,
  [switch]$ForceUserPrefix
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Repo)) {
  $Repo = "ontograph/ontoindex"
}

function Require-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name. Install Node.js LTS first, then rerun this script."
  }
}

function Invoke-Npm {
  param([string[]]$Arguments)

  & npm @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "npm failed with exit code $LASTEXITCODE"
  }
}

function Get-DefaultUserPrefix {
  if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
    return (Join-Path $env:APPDATA "npm")
  }

  return (Join-Path $HOME ".npm-global")
}

function Find-OntoIndexCommand {
  param([string]$Prefix)

  $existing = Get-Command ontoindex -ErrorAction SilentlyContinue
  if ($existing) {
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

Require-Command "node"
Require-Command "npm"

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

Write-Host "Installing OntoIndex $version from $assetUrl"

try {
  if ($ForceUserPrefix) {
    throw "User prefix requested."
  }

  Invoke-Npm @("install", "-g", $assetUrl)
  $binPath = Find-OntoIndexCommand ""
} catch {
  Write-Host "Global install failed or was skipped: $($_.Exception.Message)"
  Write-Host "Installing into user npm prefix: $NpmPrefix"
  New-Item -ItemType Directory -Force -Path $NpmPrefix | Out-Null
  Invoke-Npm @("install", "-g", "--prefix", $NpmPrefix, $assetUrl)

  if (($env:Path -split ';') -notcontains $NpmPrefix) {
    $env:Path = "$NpmPrefix;$env:Path"
  }

  $binPath = Find-OntoIndexCommand $NpmPrefix
}

if ([string]::IsNullOrWhiteSpace($binPath)) {
  throw "Installed ontoindex command was not found. Check npm prefix: $NpmPrefix"
}

Write-Host "Installed OntoIndex:"
& $binPath --version

if (($env:Path -split ';') -notcontains $NpmPrefix -and (Test-Path (Join-Path $NpmPrefix "ontoindex.cmd"))) {
  Write-Host ""
  Write-Host "Add this directory to your user PATH if ontoindex is not available in new terminals:"
  Write-Host "  $NpmPrefix"
  Write-Host ""
  Write-Host "PowerShell one-liner:"
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$NpmPrefix', 'User')"
}
