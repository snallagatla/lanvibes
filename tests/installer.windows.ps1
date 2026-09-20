# Installs into the current user's profile and uninstalls only that test installation.
param([Parameter(Mandatory)][string]$Msi, [string]$Version = '0.8.0')
$ErrorActionPreference = 'Stop'
$msiPath = (Resolve-Path -LiteralPath $Msi).Path
$installPath = Join-Path $env:LOCALAPPDATA 'LanVibes'
$registration = 'HKCU:/Software/LanVibes'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'LanVibes.lnk'
# The retained upgrade identity also replaces pre-rename installations.
if ((Test-Path (Join-Path $env:LOCALAPPDATA 'SignalPath')) -or (Test-Path 'HKCU:/Software/SignalPath')) {
    throw 'An earlier branded installation is present. Refusing to upgrade it during a clean-install test.'
}
if ((Test-Path -LiteralPath $installPath) -or (Test-Path $registration) -or (Test-Path -LiteralPath $shortcut)) {
    throw 'An existing LanVibes installation or shortcut is present. Refusing to modify it.'
}
$logRoot = Join-Path ([IO.Path]::GetTempPath()) ('LanVibes-installer-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $logRoot | Out-Null
$installed = $false
try {
    $install = Start-Process msiexec.exe -ArgumentList ('/i "{0}" /qn /norestart /L*v "{1}"' -f $msiPath, "$logRoot/install.log") -WindowStyle Hidden -Wait -PassThru
    if ($install.ExitCode -notin 0,3010) { throw "MSI install returned $($install.ExitCode). See $logRoot/install.log" }
    $installed = $true
    if ((Get-ItemProperty $registration).Version -ne $Version) { throw 'Incorrect installed version.' }
    foreach ($relative in 'LanVibes.DnsAgent.exe','coreclr.dll','hostfxr.dll','diagnostics.json','wwwroot/index.html','wwwroot/app.mjs') {
        if (!(Test-Path -LiteralPath (Join-Path $installPath $relative))) { throw "Missing installed file: $relative" }
    }
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    if ($link.TargetPath -ne (Join-Path $installPath 'LanVibes.DnsAgent.exe')) { throw 'Incorrect Start menu shortcut.' }
    if ($link.Arguments -ne '--desktop') { throw 'Missing desktop launch argument.' }
    & node "$PSScriptRoot/desktop.integration.mjs" $installPath
    if ($LASTEXITCODE) { throw 'Installed payload desktop test failed.' }
    Write-Output 'PASS MSI install, version registration, runtime/assets, Start menu target and installed payload lifecycle'
} finally {
    if ($installed) {
        $uninstall = Start-Process msiexec.exe -ArgumentList ('/x "{0}" /qn /norestart /L*v "{1}"' -f $msiPath, "$logRoot/uninstall.log") -WindowStyle Hidden -Wait -PassThru
        if ($uninstall.ExitCode -notin 0,3010) { throw "Uninstall returned $($uninstall.ExitCode). See $logRoot/uninstall.log" }
        if ((Test-Path -LiteralPath "$installPath/LanVibes.DnsAgent.exe") -or (Test-Path -LiteralPath $shortcut)) { throw 'Uninstall left the executable or shortcut.' }
        if ((Get-ItemProperty $registration -ErrorAction SilentlyContinue).Version) { throw 'Uninstall left version registration.' }
        Write-Output 'PASS uninstall removes executable, shortcut and version registration'
    }
    Write-Output "Installer logs retained at $logRoot"
}


