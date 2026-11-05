[CmdletBinding()]
param(
    [string]$CerPath = (Join-Path $PSScriptRoot "certs\zabibu-technika-dev.cer"),
    [switch]$Yes
)

if (-not $Yes) {
    Write-Warning "This adds the Zabibu Technika development certificate to your current-user Root and TrustedPublisher stores."
    Write-Warning "It is for local testing only. Run again with -Yes to continue."
    exit 1
}

if (-not (Test-Path $CerPath)) {
    Write-Error "Certificate not found: $CerPath"
    exit 1
}

$cert = Import-Certificate -FilePath $CerPath -CertStoreLocation "Cert:\CurrentUser\Root"
Import-Certificate -FilePath $CerPath -CertStoreLocation "Cert:\CurrentUser\TrustedPublisher" | Out-Null

Write-Host "  Trusted CN=Zabibu Technika (Development) for the current user." -ForegroundColor Green
Write-Host "  Thumbprint: $($cert.Thumbprint)"
Write-Host "  This is a development certificate, not a public CA." -ForegroundColor Yellow
