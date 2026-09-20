param(
    [ValidateSet('win-x64','win-arm64')][string]$Runtime = 'win-x64',
    [string]$Version = '0.8.0',
    [switch]$SkipPublish,
    [string]$SigningMetadata,
    [string]$SignToolPath,
    [string]$DlibPath
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$payload = Join-Path $repo ".build/public-0.8.0/publish/$Runtime"
$output = Join-Path $repo 'dist'
$wix = Join-Path $repo '.build/tools/wix.exe'
if (!(Test-Path -LiteralPath $wix)) { throw 'Install WiX first: dotnet tool install wix --tool-path .build/tools --version 6.0.2 --add-source https://api.nuget.org/v3/index.json' }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must be major.minor.patch.' }
$signing = @{ MetadataPath=$SigningMetadata; SignToolPath=$SignToolPath; DlibPath=$DlibPath }
if ($SigningMetadata) { & "$PSScriptRoot/sign-artifacts.ps1" @signing -ValidateOnly }
if (!$SkipPublish) {
    & dotnet publish (Join-Path $repo 'agent/LanVibes.DnsAgent.csproj') -c Release -r $Runtime --self-contained true -p:DesktopPackage=true "-p:Version=$Version" -o $payload --source https://api.nuget.org/v3/index.json --nologo
    if ($LASTEXITCODE) { throw 'Publish failed.' }
}
if (!(Test-Path -LiteralPath "$payload/LanVibes.DnsAgent.exe")) { throw 'Missing published executable.' }
$exeBytes = [IO.File]::ReadAllBytes("$payload/LanVibes.DnsAgent.exe")
$peOffset = [BitConverter]::ToInt32($exeBytes, 0x3c)
if ([BitConverter]::ToUInt16($exeBytes, $peOffset + 24 + 68) -ne 2) {
    throw 'Refusing to package a console executable. Publish with DesktopPackage=true; the executable must use the Windows GUI subsystem.'
}
$fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo("$payload/LanVibes.DnsAgent.exe").FileVersion
if ($fileVersion -ne "$Version.0") { throw "Payload version $fileVersion does not match package version $Version. Re-publish before packaging." }
if ($SigningMetadata) {
    & "$PSScriptRoot/sign-artifacts.ps1" @signing -Path @("$payload/LanVibes.DnsAgent.exe", "$payload/LanVibes.DnsAgent.dll")
}
New-Item -ItemType Directory -Force -Path $output | Out-Null
function EscapeXml([string]$value) { [System.Security.SecurityElement]::Escape($value) }
function StableId([string]$value) {
    'I' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($value))).Substring(0,24)
}
$xml = [Text.StringBuilder]::new()
[void]$xml.AppendLine('<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">')
[void]$xml.AppendLine("<Package Name=`"LanVibes`" Manufacturer=`"LanVibes`" Version=`"$Version`" UpgradeCode=`"9DC90696-3AF4-48A5-A714-9F4ED26E3359`" Scope=`"perUser`" Compressed=`"yes`">")
[void]$xml.AppendLine('<MajorUpgrade DowngradeErrorMessage="A newer version of LanVibes is installed." /><MediaTemplate EmbedCab="yes" /><Property Id="ARPNOMODIFY" Value="1" />')
[void]$xml.AppendLine("<Icon Id=`"LanVibesIcon`" SourceFile=`"$(EscapeXml (Join-Path $PSScriptRoot 'assets/lanvibes.ico'))`" /><Property Id=`"ARPPRODUCTICON`" Value=`"LanVibesIcon`" />")
[void]$xml.AppendLine('<StandardDirectory Id="LocalAppDataFolder"><Directory Id="INSTALLFOLDER" Name="LanVibes">')
$components = [Collections.Generic.List[string]]::new()
function AddDirectory([string]$directory, [string]$relative) {
    foreach ($file in Get-ChildItem -LiteralPath $directory -File | Sort-Object Name) {
        if ($file.Extension -eq '.pdb') { continue }
        $key = "$relative/$($file.Name)"
        $id = StableId $key
        $guidBytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("LanVibes:${Runtime}:$key"))[0..15]
        $componentGuid = [Guid]::new([byte[]]$guidBytes).ToString()
        $fileId = if ($key -eq '/LanVibes.DnsAgent.exe') { 'AgentExe' } else { "F$id" }
        $components.Add($id)
        [void]$xml.AppendLine("<Component Id=`"$id`" Guid=`"$componentGuid`"><File Id=`"$fileId`" Source=`"$(EscapeXml $file.FullName)`" /><RegistryValue Root=`"HKCU`" Key=`"Software\LanVibes\Components`" Name=`"$id`" Type=`"integer`" Value=`"1`" KeyPath=`"yes`" /></Component>")
    }
    foreach ($dir in Get-ChildItem -LiteralPath $directory -Directory | Sort-Object Name) {
        $child = "$relative/$($dir.Name)"
        $id = StableId "dir:$child"
        [void]$xml.AppendLine("<Directory Id=`"D$id`" Name=`"$(EscapeXml $dir.Name)`">")
        AddDirectory $dir.FullName $child
        $components.Add($id)
        [void]$xml.AppendLine("<Component Id=`"$id`" Guid=`"*`"><RemoveFolder Id=`"R$id`" On=`"uninstall`" /><RegistryValue Root=`"HKCU`" Key=`"Software\LanVibes\Components`" Name=`"$id`" Type=`"integer`" Value=`"1`" KeyPath=`"yes`" /></Component></Directory>")
    }
}
AddDirectory $payload ''
[void]$xml.AppendLine('<Component Id="InstallRegistration" Guid="*"><RemoveFolder Id="RemoveInstallFolder" On="uninstall" /><RegistryValue Root="HKCU" Key="Software\LanVibes" Name="Version" Type="string" Value="[ProductVersion]" KeyPath="yes" /></Component></Directory></StandardDirectory>')
[void]$xml.AppendLine('<StandardDirectory Id="ProgramMenuFolder"><Component Id="StartMenuShortcut" Guid="*"><Shortcut Id="LaunchLanVibes" Name="LanVibes" Target="[#AgentExe]" Arguments="--desktop" WorkingDirectory="INSTALLFOLDER" Icon="LanVibesIcon" /><RegistryValue Root="HKCU" Key="Software\LanVibes" Name="Shortcut" Type="integer" Value="1" KeyPath="yes" /></Component></StandardDirectory>')
[void]$xml.AppendLine('<Feature Id="Main" Title="LanVibes" Level="1"><ComponentRef Id="InstallRegistration" /><ComponentRef Id="StartMenuShortcut" />')
foreach ($id in $components) { [void]$xml.AppendLine("<ComponentRef Id=`"$id`" />") }
[void]$xml.AppendLine('</Feature></Package></Wix>')
$source = Join-Path $repo ".build/LanVibes-$Runtime.wxs"
[IO.File]::WriteAllText($source, $xml.ToString())
$arch = $Runtime.Replace('win-','')
$label = if ($SigningMetadata) { 'signed' } else { 'unsigned' }
$msi = Join-Path $output "LanVibes-$Version-$Runtime-$label.msi"
$buildMsi = if ($SigningMetadata) { Join-Path $repo ".build/LanVibes-$Version-$Runtime-signing-candidate.msi" } else { $msi }
& $wix build $source -arch $arch -o $buildMsi
if ($LASTEXITCODE) { throw 'MSI build failed.' }
if ($SigningMetadata) {
    & "$PSScriptRoot/sign-artifacts.ps1" @signing -Path $buildMsi
    Copy-Item -LiteralPath $buildMsi -Destination $msi -Force
}
Get-FileHash -Algorithm SHA256 -LiteralPath $msi | Format-List


