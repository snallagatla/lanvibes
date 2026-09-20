param([Parameter(Mandatory)][string]$Setup, [string]$Version = '0.8.0')
$ErrorActionPreference = 'Stop'
$setupPath = (Resolve-Path -LiteralPath $Setup).Path
$registration = 'HKCU:/Software/LanVibes'
$installPath = Join-Path $env:LOCALAPPDATA 'LanVibes'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'LanVibes.lnk'
# The retained upgrade identity also replaces pre-rename installations.
if ((Test-Path (Join-Path $env:LOCALAPPDATA 'SignalPath')) -or (Test-Path 'HKCU:/Software/SignalPath')) {
    throw 'An earlier branded installation is present. Refusing to upgrade it during a clean-install test.'
}
if ((Test-Path $registration) -or (Test-Path -LiteralPath $installPath) -or (Test-Path -LiteralPath $shortcut)) { throw 'Existing installation detected; refusing to modify it.' }
$logs = Join-Path ([IO.Path]::GetTempPath()) ('LanVibes-bundle-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $logs | Out-Null
$installed = $false
try {
    $result = Start-Process -FilePath $setupPath -ArgumentList ('/install /quiet /norestart /log "{0}"' -f "$logs/install.log") -WindowStyle Hidden -Wait -PassThru
    if ($result.ExitCode -notin 0,3010) { throw "Bundle install failed: $($result.ExitCode). Logs: $logs" }
    $installed = $true
    if ((Get-ItemProperty $registration).Version -ne $Version) { throw 'Incorrect installed version.' }
    $exe = Join-Path $installPath 'LanVibes.DnsAgent.exe'
    $bytes = [IO.File]::ReadAllBytes($exe)
    $pe = [BitConverter]::ToInt32($bytes, 0x3c)
    $machine = [BitConverter]::ToUInt16($bytes, $pe + 4)
    $arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    $expected = switch ($arch) { 'X64' { 0x8664 } 'Arm64' { 0xaa64 } default { throw "Unsupported OS: $arch" } }
    if ($machine -ne $expected) { throw "Wrong native payload: $machine for $arch" }
    if (!(Test-Path -LiteralPath $shortcut)) { throw 'Missing Start menu shortcut.' }
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    if ($link.TargetPath -ne $exe -or $link.Arguments -ne '--desktop') { throw 'Incorrect desktop shortcut.' }
    & node "$PSScriptRoot/desktop.integration.mjs" $installPath
    if ($LASTEXITCODE) { throw 'Installed desktop lifecycle failed.' }
    Write-Output "PASS combined installer selects native $arch payload, installs $Version, shortcut and desktop session lifecycle"
} finally {
    if ($installed) {
        $result = Start-Process -FilePath $setupPath -ArgumentList ('/uninstall /quiet /norestart /log "{0}"' -f "$logs/uninstall.log") -WindowStyle Hidden -Wait -PassThru
        if ($result.ExitCode -notin 0,3010) { throw "Bundle uninstall failed: $($result.ExitCode). Logs: $logs" }
        if ((Test-Path -LiteralPath "$installPath/LanVibes.DnsAgent.exe") -or (Test-Path -LiteralPath $shortcut)) { throw 'Uninstall left application or shortcut.' }
        if ((Get-ItemProperty $registration -ErrorAction SilentlyContinue).Version) { throw 'Uninstall left version registration.' }
        Write-Output 'PASS bundle uninstall removes application, shortcut and version registration'
    }
    Write-Output "Logs retained: $logs"
}


