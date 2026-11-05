[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$OutputDir = "dist",
    [string]$CertificateThumbprint = "",
    [string]$PfxPath = "",
    [string]$PfxPassword = "",
    [switch]$CreateDevCert,
    [switch]$SkipSign,
    [switch]$KeepStage
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$appName = "weaver"
$exeName = "weaver.exe"
$entryRelative = "src/index.ts"
$launcherSource = Join-Path $PSScriptRoot "launcher\WeaverLauncher.cs"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if ([string]::IsNullOrWhiteSpace($Version)) {
    $package = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
    $Version = [string]$package.version
}
if ([string]::IsNullOrWhiteSpace($Version)) { throw "Could not determine the version." }
if (-not (Test-Path $launcherSource)) { throw "Missing launcher source: $launcherSource" }
if (-not (Test-Path $csc)) { throw "The .NET Framework C# compiler was not found at $csc" }

$nodeSource = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = (& $nodeSource --version).Trim()
if (-not $nodeVersion.StartsWith("v")) { throw "Could not read the Node version from $nodeSource" }

$out = Join-Path $repo $OutputDir
$stageName = "$appName-$Version-win-x64"
$stage = Join-Path $out $stageName
$zip = Join-Path $out "$stageName.zip"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage "runtime") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $stage "app") | Out-Null
New-Item -ItemType Directory -Force $out | Out-Null

Write-Host "Staging $stageName" -ForegroundColor Cyan

foreach ($item in @("src", "core", "engines", "package.json", "LICENSE", "README.md", "SAFETY.md")) {
    $source = Join-Path $repo $item
    if (Test-Path $source) {
        Copy-Item $source (Join-Path $stage "app") -Recurse -Force
    }
}

Get-ChildItem (Join-Path $stage "app") -Recurse -File -Include "*.test.ts", "*.test.mjs", "*.test.js" -ErrorAction SilentlyContinue |
    Remove-Item -Force

Copy-Item $nodeSource (Join-Path $stage "runtime\node.exe") -Force
$nodeLicense = Join-Path (Split-Path $nodeSource -Parent) "LICENSE"
if (Test-Path $nodeLicense) {
    Copy-Item $nodeLicense (Join-Path $stage "runtime\LICENSE-node.txt") -Force
}

foreach ($file in @("install.ps1", "uninstall.ps1", "verify.ps1", "Install.cmd")) {
    $source = Join-Path $PSScriptRoot $file
    if (Test-Path $source) { Copy-Item $source $stage -Force }
}

Write-Host "Compiling the Windows launcher" -ForegroundColor Cyan
& $csc /nologo /target:exe /optimize+ "/out:$stage\$exeName" $launcherSource
if ($LASTEXITCODE -ne 0) { throw "The C# launcher did not compile." }

$test = & (Join-Path $stage $exeName) --version 2>&1
if ($LASTEXITCODE -ne 0 -or "$test".Trim() -notmatch "^\d+\.\d+\.\d+") {
    throw "The packaged launcher failed its version check: $test"
}
Write-Host "Launcher reports version $("$test".Trim())" -ForegroundColor Green

$certificate = $null
$importedCertificate = $null
if (-not $SkipSign) {
    if (-not [string]::IsNullOrWhiteSpace($PfxPath)) {
        if (-not (Test-Path $PfxPath)) { throw "PFX file not found: $PfxPath" }
        $secure = ConvertTo-SecureString $PfxPassword -AsPlainText -Force
        $importedCertificate = Import-PfxCertificate -FilePath $PfxPath -Password $secure -CertStoreLocation "Cert:\CurrentUser\My"
        $certificate = Get-Item "Cert:\CurrentUser\My\$($importedCertificate.Thumbprint)"
    }
    elseif (-not [string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
        $certificate = Get-Item "Cert:\CurrentUser\My\$CertificateThumbprint" -ErrorAction Stop
    }
    elseif ($CreateDevCert) {
        Write-Host "Creating a development code-signing certificate" -ForegroundColor Cyan
        $certificate = New-SelfSignedCertificate `
            -Type CodeSigningCert `
            -Subject "CN=Zabibu Technika (Development), O=Zabibu Technika, C=KE" `
            -CertStoreLocation "Cert:\CurrentUser\My" `
            -KeyUsage DigitalSignature `
            -NotAfter (Get-Date).AddYears(3)
        $certDir = Join-Path $PSScriptRoot "certs"
        New-Item -ItemType Directory -Force $certDir | Out-Null
        Export-Certificate -Cert $certificate -FilePath (Join-Path $certDir "zabibu-technika-dev.cer") -Force | Out-Null
    }
}

function Sign-PackageFile([string]$path, $signer) {
    if (-not (Test-Path $path)) { return }
    try {
        $signature = Set-AuthenticodeSignature -FilePath $path -Certificate $signer -HashAlgorithm SHA256 -TimestampServer "http://timestamp.digicert.com" -ErrorAction Stop
    }
    catch {
        Write-Warning "Timestamped signing failed for $(Split-Path -Leaf $path); signing without a timestamp."
        $signature = Set-AuthenticodeSignature -FilePath $path -Certificate $signer -HashAlgorithm SHA256
    }
    if ($signature.Status -ne "Valid") {
        Write-Warning "Signature status for $(Split-Path -Leaf $path): $($signature.Status)"
    }
    else {
        Write-Host "Signed $(Split-Path -Leaf $path)" -ForegroundColor Green
    }
}

if ($certificate) {
    Sign-PackageFile (Join-Path $stage $exeName) $certificate
    Sign-PackageFile (Join-Path $stage "install.ps1") $certificate
    Sign-PackageFile (Join-Path $stage "uninstall.ps1") $certificate
    Sign-PackageFile (Join-Path $stage "verify.ps1") $certificate
}
elseif (-not $SkipSign) {
    Write-Warning "No signing certificate supplied. Use -CreateDevCert for a development signature, or -CertificateThumbprint / -PfxPath for a real certificate."
}
else {
    Write-Warning "Signing skipped."
}

$signingLine = if ($certificate) {
    "Authenticode: signed with $($certificate.Subject)"
} else {
    "Authenticode: unsigned preview"
}

$readme = @"
Weaver $Version - Windows x64
================================

A self-contained build. Node $nodeVersion is included; no install is required.

Run:
  weaver.exe

Install for the current user (adds Weaver to PATH):
  powershell -ExecutionPolicy Bypass -File install.ps1

Or double-click Install.cmd.

Verify:
  powershell -ExecutionPolicy Bypass -File verify.ps1

$signingLine
Node runtime: $nodeVersion

Weaver keeps state in %USERPROFILE%\.weaver and projects in
%USERPROFILE%\.weaver\workspace by default. Use -C <dir> to choose another
workspace.

Source: https://github.com/Zabibu-Technika/ZabibuWeaver
License: MIT
"@
Set-Content (Join-Path $stage "README.txt") $readme -Encoding UTF8

Write-Host "Creating $stageName.zip" -ForegroundColor Cyan
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
$sumLine = "$hash  $stageName.zip"
Set-Content (Join-Path $out "SHA256SUMS.txt") $sumLine -Encoding ASCII

$release = [ordered]@{
    name = $appName
    version = $Version
    platform = "win-x64"
    file = "$stageName.zip"
    size = (Get-Item $zip).Length
    sha256 = $hash
    signed = [bool]$certificate
    signer = if ($certificate) { $certificate.Subject } else { $null }
    thumbprint = if ($certificate) { $certificate.Thumbprint } else { $null }
    node = $nodeVersion
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
}
$release | ConvertTo-Json | Set-Content (Join-Path $out "release.json") -Encoding UTF8

if (-not $KeepStage) {
    Remove-Item $stage -Recurse -Force
}

$sizeMb = [Math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ""
Write-Host "Built $zip ($sizeMb MB)" -ForegroundColor Green
Write-Host "SHA256 $hash"
Write-Host "Release metadata: $(Join-Path $out "release.json")"

if ($importedCertificate) {
    Remove-Item "Cert:\CurrentUser\My\$($importedCertificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
}
