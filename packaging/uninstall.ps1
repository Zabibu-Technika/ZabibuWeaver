[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Zabibu\Weaver"),
    [switch]$Purge
)

$ErrorActionPreference = "Stop"

if (Test-Path $InstallDir) {
    Remove-Item $InstallDir -Recurse -Force
    Write-Host "  Removed $InstallDir" -ForegroundColor Green
}
else {
    Write-Host "  $InstallDir is not installed." -ForegroundColor Yellow
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @(($userPath -split ";") | Where-Object { $_ -ne "" -and $_ -ne $InstallDir })
[Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
Write-Host "  Removed $InstallDir from the user PATH." -ForegroundColor Green

if ($Purge) {
    $weaverHome = Join-Path $env:USERPROFILE ".weaver"
    if (Test-Path $weaverHome) {
        Remove-Item $weaverHome -Recurse -Force
        Write-Host "  Removed $weaverHome (sessions, receipts, decisions, workspace)." -ForegroundColor Green
    }
}
else {
    Write-Host "  Kept $env:USERPROFILE\.weaver. Use -Purge to remove sessions and receipts too." -ForegroundColor DarkGray
}
