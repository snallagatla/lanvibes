param(
    [string[]]$Path,
    [Parameter(Mandatory)][string]$MetadataPath,
    [Parameter(Mandatory)][string]$SignToolPath,
    [Parameter(Mandatory)][string]$DlibPath,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
foreach ($required in @($MetadataPath,$SignToolPath,$DlibPath)) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing signing prerequisite: $required" }
}
$metadata = Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json
foreach ($field in @('Endpoint','CodeSigningAccountName','CertificateProfileName')) {
    if ([string]::IsNullOrWhiteSpace($metadata.$field) -or $metadata.$field -match '[<>]') { throw "Configure $field in the signing metadata first." }
}
$endpoint = [Uri]$metadata.Endpoint
if ($endpoint.Scheme -ne 'https' -or !$endpoint.Host.EndsWith('.codesigning.azure.net')) { throw 'Use the regional Azure Artifact Signing HTTPS account endpoint.' }
if ($ValidateOnly) { return }
if (!$Path) { throw 'Specify at least one artifact to sign.' }
foreach ($artifact in $Path) {
    $resolved = (Resolve-Path -LiteralPath $artifact).Path
    & $SignToolPath sign /v /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib $DlibPath /dmdf (Resolve-Path -LiteralPath $MetadataPath).Path $resolved
    if ($LASTEXITCODE) { throw "Artifact Signing failed: $resolved" }
    & $SignToolPath verify /pa /all /v $resolved
    if ($LASTEXITCODE) { throw "Signature verification failed: $resolved" }
}
