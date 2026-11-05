[CmdletBinding()]
param(
    [string]$Path = (Join-Path $PSScriptRoot "weaver.exe")
)

if (-not (Test-Path $Path)) {
    Write-Error "Not found: $Path"
    exit 1
}

$signature = Get-AuthenticodeSignature -FilePath $Path
$hash = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLower()

Write-Host ""
Write-Host "  File:      $Path"
Write-Host "  SHA256:    $hash"
Write-Host "  Signature: $($signature.Status)"
if ($signature.SignerCertificate) {
    Write-Host "  Signer:    $($signature.SignerCertificate.Subject)"
    Write-Host "  Thumbprint:$($signature.SignerCertificate.Thumbprint)"
}
Write-Host ""

if ($signature.Status -ne "Valid") {
    Write-Host "  This build is not signed by a trusted certificate on this machine." -ForegroundColor Yellow
    Write-Host "  See SIGNING.md in the source repository for the production certificate status." -ForegroundColor DarkGray
    exit 1
}

Write-Host "  Signature valid." -ForegroundColor Green
exit 0
