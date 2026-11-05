# Windows code signing

## Current status

Windows builds are Authenticode-signed with the **Zabibu Technika development
certificate**:

- Subject: `CN=Zabibu Technika (Development), O=Zabibu Technika, C=KE`
- Thumbprint: `8C0B794C2F7481E2EF99446C7ED025A43ACA97B8`
- Public certificate: [`certs/zabibu-technika-dev.cer`](certs/zabibu-technika-dev.cer)
- SHA256 digest and RFC 3161 timestamp: yes

This proves the executable and installer have not changed since signing. It does **not**
make Windows trust the publisher on a clean machine: the development certificate is
self-signed, so SmartScreen may still show **Unknown publisher** until a publicly trusted
code-signing certificate is used.

## What production trust requires

A publicly trusted code-signing certificate with the Code Signing EKU, from a CA such as
DigiCert, Sectigo, Certum, or GlobalSign, or a managed service such as Azure Trusted
Signing or SignPath Foundation (free for open source). The private key must stay off the
build machine except during signing.

Once the certificate exists:

```powershell
# Installed in Cert:\CurrentUser\My
.\packaging\build-windows.ps1 -CertificateThumbprint <THUMBPRINT>

# Or a PFX, imported only for the build
.\packaging\build-windows.ps1 -PfxPath .\zabibu-codesign.pfx -PfxPassword '<password>'
```

The script signs `weaver.exe`, `install.ps1`, `uninstall.ps1`, and `verify.ps1`, then
timestamps them. The zip is created after signing, so the signed bytes are what ships.

## Verify a build

```powershell
Get-AuthenticodeSignature .\weaver.exe | Format-List Status, StatusMessage, SignerCertificate
Get-FileHash .\weaver.exe -Algorithm SHA256
```

With the development certificate the status is `UnknownError` with the message
"A certificate chain processed, but terminated in a root certificate which is not trusted".
The signature itself is valid; only the chain is untrusted.

## Trusting the development certificate (testing only)

[`trust-dev-cert.ps1`](trust-dev-cert.ps1) adds the public certificate to the current
user's `Root` and `TrustedPublisher` stores. This is a local testing convenience, **not** a
distribution strategy. It requires explicit `-Yes`, and can be undone:

```powershell
.\packaging\trust-dev-cert.ps1 -Yes
# undo
Get-ChildItem Cert:\CurrentUser\Root | Where-Object Thumbprint -eq 8C0B794C2F7481E2EF99446C7ED025A43ACA97B8 | Remove-Item
Get-ChildItem Cert:\CurrentUser\TrustedPublisher | Where-Object Thumbprint -eq 8C0B794C2F7481E2EF99446C7ED025A43ACA97B8 | Remove-Item
```

## CI

The workflow template is [`release-windows.yml`](release-windows.yml). Copy it to `.github/workflows/release-windows.yml` after the GitHub token has the `workflow` scope. (The current `gh` session is `teh317`; the browser approval used `zabibutechnika`, so the scope could not be added.) It builds on a Windows runner. Set:

- `WINDOWS_CERT_PFX_BASE64` — base64 of the PFX
- `WINDOWS_CERT_PASSWORD` — its password

If the secrets are absent, the workflow builds an unsigned preview and says so in the
release notes. For Azure Trusted Signing, replace the PFX step with the
`azure/trusted-signing-action` step and its service-principal secrets.

## Release checklist

- [ ] Version bumped in `package.json`
- [ ] `npm test` and `npm run typecheck` pass
- [ ] `packaging\build-windows.ps1` produces the zip and `SHA256SUMS.txt`
- [ ] `Get-AuthenticodeSignature` shows the expected signer (or an explicit unsigned preview)
- [ ] `weaver.exe --version` and `weaver.exe providers` work from the extracted zip
- [ ] `install.ps1` installs and the installed `weaver.exe` runs
- [ ] Release notes state the signature status honestly
