$ErrorActionPreference = 'Stop'
if (-not $env:WINDOWS_CERTIFICATE) {
    Write-Output 'Windows installers will be unsigned (no signing certificate configured).'
    exit 0
}
if (-not $env:WINDOWS_CERTIFICATE_PASSWORD) { throw 'WINDOWS_CERTIFICATE_PASSWORD is required.' }
$certificatePath = Join-Path $env:RUNNER_TEMP 'theprivator-signing.pfx'
try {
    [IO.File]::WriteAllBytes($certificatePath, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE))
    $password = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
    $certificate = Import-PfxCertificate -FilePath $certificatePath -CertStoreLocation Cert:\CurrentUser\My -Password $password
    if (@($certificate).Count -ne 1) { throw 'Expected one code-signing certificate.' }
    $config = Get-Content 'tmp/ci-bundle.json' -Raw | ConvertFrom-Json
    $config.bundle | Add-Member -Name windows -MemberType NoteProperty -Value @{
        certificateThumbprint = $certificate.Thumbprint
        digestAlgorithm = 'sha256'
        timestampUrl = 'http://timestamp.digicert.com'
    }
    $config | ConvertTo-Json -Depth 10 | Set-Content 'tmp/ci-bundle.json' -Encoding utf8
    "THEPRIVATOR_SIGNING_THUMBPRINT=$($certificate.Thumbprint)" | Out-File $env:GITHUB_ENV -Append -Encoding utf8
} finally {
    Remove-Item $certificatePath -Force -ErrorAction SilentlyContinue
}
