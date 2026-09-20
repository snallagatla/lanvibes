param([switch]$SkipPublish)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$kit = Join-Path $repo '.build/public-0.8.0/macos-kit'
New-Item -ItemType Directory -Force -Path "$kit/payloads", "$repo/dist" | Out-Null
foreach ($rid in 'osx-arm64','osx-x64') {
    $payload = Join-Path $repo ".build/public-0.8.0/publish/$rid"
    if (!$SkipPublish) {
        & dotnet publish "$repo/agent/LanVibes.DnsAgent.csproj" -c Release -r $rid --self-contained true -p:DesktopPackage=true -o $payload --source https://api.nuget.org/v3/index.json --nologo
        if ($LASTEXITCODE) { throw "Publish failed for $rid" }
    }
    if (!(Test-Path -LiteralPath "$payload/LanVibes.DnsAgent")) { throw "Missing payload: $rid" }
    New-Item -ItemType Directory -Force -Path "$kit/payloads/$rid" | Out-Null
    Copy-Item -Path "$payload/*" -Destination "$kit/payloads/$rid" -Recurse -Force
}
Copy-Item -LiteralPath "$PSScriptRoot/build-macos.sh", "$PSScriptRoot/entitlements.plist", "$PSScriptRoot/PILOT-GUIDE.md" -Destination $kit -Force
New-Item -ItemType Directory -Force -Path "$kit/assets" | Out-Null
Copy-Item -LiteralPath "$PSScriptRoot/assets/lanvibes.icns" -Destination "$kit/assets/lanvibes.icns" -Force
# Bash scripts must have Unix line endings even when this kit is prepared on Windows.
$script = [IO.File]::ReadAllText("$kit/build-macos.sh").Replace("`r`n", "`n")
[IO.File]::WriteAllText("$kit/build-macos.sh", $script, [Text.UTF8Encoding]::new($false))
$archive = Join-Path $repo 'dist/LanVibes-0.8.0-macos-build-kit.zip'
Compress-Archive -Path "$kit/*" -DestinationPath $archive -Force
Get-FileHash -Algorithm SHA256 -LiteralPath $archive | Format-List
