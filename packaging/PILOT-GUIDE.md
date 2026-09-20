# LanVibes 0.8.0 manual pilot

These are on-demand desktop packages. They bundle .NET 10 and the dashboard. No SDK, service, login item, scheduled task, telemetry upload or automatic test schedule is installed. Local DNS loads when the user opens the app; external tests run only on request. Exported reports retain full troubleshooting details and are saved by the browser for the user to send to support.

## Windows

Use `LanVibes-0.8.0-windows-setup-unsigned.exe` for the manual pilot; it selects x64 or ARM64 and provides an installation wizard. See [Windows instructions](WINDOWS-PILOT.md).

1. Double-click the combined setup EXE while signed in as the user. It installs to `%LOCALAPPDATA%\LanVibes` and creates a **LanVibes** Start menu shortcut. This is a per-user pilot installation, not an Intune SYSTEM installation.
2. Open **LanVibes** from Start. The dashboard opens in the default browser without a console window. Do not bookmark its local address; each launch creates a new port and session.
3. Select Home, Office or VPN as appropriate, run tests, then **Export support report**.
4. Choose **Quit LanVibes** when finished. Quit attempts to close the tab. Export wanted results before quitting. Closing the tab leaves the process running until its idle timeout, approximately 5 minutes after its last completed local request. Each separate launch owns its own process.
5. To uninstall, quit all sessions, then remove **LanVibes** in Windows Installed apps. Exported reports remain wherever the user saved them.

The pilot MSIs and app executables are **unsigned**. Organization application-control policy may block them. If so, have the endpoint team approve/sign the pilot through its normal process; do not disable device protection. No code-signing certificate was available on the build account.

Support command-line installation (run as the intended user):

```powershell
msiexec /i "LanVibes-0.8.0-win-x64-unsigned.msi" /qn /norestart /L*v "$env:TEMP\LanVibes-install.log"
msiexec /x "LanVibes-0.8.0-win-x64-unsigned.msi" /qn /norestart
```

Quit before upgrades. Higher package versions perform a major upgrade; older versions are blocked. Use one architecture package per workstation. Automatic updates are not included. Uninstall the newer version before manually reinstalling an older pilot; installer rollback is not a tested application downgrade workflow. Detection: HKCU `Software\LanVibes`, value `Version` (`0.8.0`), plus the installed executable. Version does not describe successful diagnostic execution.

## macOS: build on a Mac

`LanVibes-0.8.0-macos-build-kit.zip` is a **build kit, not an installer**. It contains self-contained Intel and Apple Silicon payloads; no .NET SDK is needed on the Mac to package them. Native execution, `.pkg` creation and signing/notarization must be validated on macOS. Pilot target: macOS 14 or later supported by .NET 10.

Extract the ZIP, open Terminal in that extracted directory, and run:

```bash
bash build-macos.sh osx-arm64  # Apple Silicon
bash build-macos.sh osx-x64    # Intel
```

Unsigned development packages appear in `output/`. Use these only in an IT-approved local pilot. For distribution to users, use Developer ID signing and notarization. The Mac needs Apple command-line tools for `xcrun notarytool`, the signing identities in its keychain, and a previously configured notary keychain profile. No certificates or credentials are included in the kit.

```bash
export APPLICATION_IDENTITY='Developer ID Application: YOUR ORGANIZATION (TEAMID)'
export INSTALLER_IDENTITY='Developer ID Installer: YOUR ORGANIZATION (TEAMID)'
export NOTARY_PROFILE='your-existing-keychain-profile'
bash build-macos.sh osx-arm64
bash build-macos.sh osx-x64
```

The script signs native binaries and the app, creates a signed package, submits it for notarization, staples the result and checks Gatekeeper acceptance. A `signed` filename alone does not establish notarization; all notarization and assessment commands must succeed. Apple signing/notarization is untested until the Mac is available.

Double-click the matching validated `.pkg`. It installs `/Applications/LanVibes.app` (installer may request administrator authorization). Launch from Applications as the signed-in user. The same browser, Quit and idle-timeout behavior applies. Quit all sessions before reinstalling/upgrading. To uninstall, quit LanVibes and move `/Applications/LanVibes.app` to Trash; exported reports are retained. Package receipt identifier: `com.lanvibes.diagnostics`. No launch daemon or privileged helper is installed.

## Pilot acceptance

- Test install, launch, export/reimport and uninstall on a clean standard-user workstation of each architecture.
- Verify offline launch, Home/Office/VPN, corporate proxy, DNS/NRPT or macOS resolver observations against OS tools, and the existing Cloudflare speed endpoint when selected.
- Verify Quit during a running test, tab closure and idle expiry, two concurrent launches, sleep/resume, and reboot without automatic startup.
- Test upgrade with the app closed and application-control policy. Check Installer logs when installation fails. Windows ARM64 and both macOS architectures need actual-device validation; Windows x64 validation does not establish those platforms work.
- Reports contain addresses, DNS servers, hostnames, proxy/routes and diagnostic results. Provide the full exported JSON to support through your approved support channel.

## Rebuilding and later Intune rollout

Build requirements: .NET 10 SDK, PowerShell 7, WiX 6.0.2. Source scripts are in `packaging/`.

```powershell
dotnet tool install wix --tool-path .build/tools --version 6.0.2 --add-source https://api.nuget.org/v3/index.json
./packaging/build-windows.ps1 -Runtime win-x64
./packaging/build-windows.ps1 -Runtime win-arm64
./packaging/prepare-macos-kit.ps1
```

For enterprise distribution, sign the Windows app before creating the MSI, then sign/timestamp the MSI with your organization's certificate. See [Azure Artifact Signing setup](AZURE-SIGNING.md) for the integrated Windows signing workflow. Rebuild the self-contained payloads to distribute .NET security updates. Keep endpoint configuration consistent across architectures; edit `agent/diagnostics.json` before building. Do not modify a signed Mac bundle after signing.

The Windows pilot is per-user: do not deploy it as SYSTEM. An Intune user-context Win32 deployment or a separately tested per-machine installer is the next rollout step. macOS Intune should receive the signed/notarized package after pilot validation. No Intune assignment is made by these scripts.

References: [.NET self-contained publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/), [.NET macOS packaging and signing](https://learn.microsoft.com/en-us/dotnet/core/deploying/macos), [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
