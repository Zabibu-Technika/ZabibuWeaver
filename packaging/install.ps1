[CmdletBinding()]
param(
    [string]$Version = "latest",
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Zabibu\Weaver"),
    [switch]$NoPath
)

$ErrorActionPreference = "Stop"
$repo = "Zabibu-Technika/ZabibuWeaver"
$app = "weaver"
$exe = "weaver.exe"

function Write-Step([string]$Message) {
    Write-Host "  $Message" -ForegroundColor Cyan
}

$sourceDir = $null
$localExe = Join-Path $PSScriptRoot $exe
if (Test-Path $localExe) {
    $sourceDir = $PSScriptRoot
    Write-Step "Installing from the extracted package."
} else {
    Write-Step "Finding the latest Weaver release."
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "weaver-installer" }
    $asset = $release.assets | Where-Object { $_.name -like "$app-*-win-x64.zip" } | Select-Object -First 1
    if (-not $asset) { throw "No Windows x64 package was found in the latest release." }

    $tmp = Join-Path $env:TEMP ("weaver-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $zip = Join-Path $tmp $asset.name

    Write-Step "Downloading $($asset.name)."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing

    $sumsAsset = $release.assets | Where-Object { $_.name -eq "SHA256SUMS.txt" } | Select-Object -First 1
    if ($sumsAsset) {
        $sumsPath = Join-Path $tmp "SHA256SUMS.txt"
        Invoke-WebRequest -Uri $sumsAsset.browser_download_url -OutFile $sumsPath -UseBasicParsing
        $line = Get-Content $sumsPath | Where-Object { $_ -match [regex]::Escape($asset.name) } | Select-Object -First 1
        if ($line) {
            $expected = ($line -split "\s+")[0].ToLower()
            $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
            if ($expected -ne $actual) {
                throw "Checksum mismatch: expected $expected, got $actual. Delete the download and try again."
            }
            Write-Step "SHA256 verified."
        }
    }

    Write-Step "Extracting."
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $sourceDir = $tmp
    if (-not (Test-Path (Join-Path $sourceDir $exe))) {
        $candidate = Get-ChildItem $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName $exe) } | Select-Object -First 1
        if (-not $candidate) { throw "The package did not contain $exe." }
        $sourceDir = $candidate.FullName
    }
}

if (Test-Path $InstallDir) {
    Remove-Item $InstallDir -Recurse -Force
}
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Copy-Item (Join-Path $sourceDir "*") $InstallDir -Recurse -Force

if (-not $NoPath) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @(($userPath -split ";") | Where-Object { $_ -ne "" })
    if ($parts -notcontains $InstallDir) {
        [Environment]::SetEnvironmentVariable("Path", (($parts + $InstallDir) -join ";"), "User")
        $env:Path = "$env:Path;$InstallDir"
        Write-Step "Added $InstallDir to your user PATH."
    }
}

$installedExe = Join-Path $InstallDir $exe
$installedVersion = & $installedExe --version
Write-Host ""
Write-Host "  Weaver $installedVersion is installed." -ForegroundColor Green
Write-Host "  Run: weaver" -ForegroundColor White
Write-Host "  Location: $InstallDir"
Write-Host "  Upgrade: run this installer again; it replaces the current install." -ForegroundColor DarkGray
