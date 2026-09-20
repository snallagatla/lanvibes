param([string]$Version = '0.8.0', [switch]$SkipPublish, [switch]$SkipMsi,
    [string]$SigningMetadata, [string]$SignToolPath, [string]$DlibPath)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$signing = @{ MetadataPath=$SigningMetadata; SignToolPath=$SignToolPath; DlibPath=$DlibPath }
if ($SigningMetadata) {
    if ($SkipMsi) { throw 'Signed builds must rebuild and verify their MSI payloads; do not use SkipMsi.' }
    & "$PSScriptRoot/sign-artifacts.ps1" @signing -ValidateOnly
}
if (!$SkipMsi) {
    foreach ($rid in 'win-x64','win-arm64') {
        & "$PSScriptRoot/build-windows.ps1" -Runtime $rid -Version $Version -SkipPublish:$SkipPublish -SigningMetadata $SigningMetadata -SignToolPath $SignToolPath -DlibPath $DlibPath
    }
}
$wix = Join-Path $repo '.build/tools/wix.exe'
$dist = Join-Path $repo 'dist'
$setup = Join-Path $dist "LanVibes-$Version-windows-setup-unsigned.exe"
$label = if ($SigningMetadata) { 'signed' } else { 'unsigned' }
if ($SigningMetadata) { $setup = Join-Path $repo ".build/LanVibes-$Version-signing-input.exe" }
# x86 bootstrapper runs on both x64 and ARM64 Windows. NativeMachine selects the
# actual OS architecture, even when the installer itself runs under emulation.
& $wix build "$PSScriptRoot/Bundle.wxs" -arch x86 -ext WixToolset.BootstrapperApplications.wixext -d "Version=$Version" -d "Dist=$dist" -d "Assets=$PSScriptRoot/assets" -d "SigningLabel=$label" -o $setup
if ($LASTEXITCODE) { throw 'Combined installer build failed.' }
if ($SigningMetadata) {
    $engine = Join-Path $repo ".build/LanVibes-$Version-engine.exe"
    & $wix burn detach $setup -engine $engine
    if ($LASTEXITCODE) { throw 'Burn engine extraction failed.' }
    & "$PSScriptRoot/sign-artifacts.ps1" @signing -Path $engine
    $candidate = Join-Path $repo ".build/LanVibes-$Version-signing-candidate.exe"
    & $wix burn reattach $setup -engine $engine -o $candidate
    if ($LASTEXITCODE) { throw 'Burn engine reattachment failed.' }
    & "$PSScriptRoot/sign-artifacts.ps1" @signing -Path $candidate
    $setup = Join-Path $dist "LanVibes-$Version-windows-setup-signed.exe"
    Copy-Item -LiteralPath $candidate -Destination $setup -Force
}
Get-FileHash -Algorithm SHA256 -LiteralPath $setup | Format-List


