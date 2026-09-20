# LanVibes 0.8.0 Windows pilot

Distribute **LanVibes-0.8.0-windows-setup-unsigned.exe**. This one offline installer includes both Windows x64 and ARM64 payloads and selects the native OS architecture. Users do not need .NET or an internet connection to install or open the local dashboard. Pilot target: Windows 11.

Validation status: automated application checks passed. See `dist/WINDOWS-0.8.0-VALIDATION.md` for coverage and remaining device acceptance checks.

## Manual installation

1. Export any results and choose **Quit LanVibes** in all existing sessions before upgrading. Older console/server instances must also be stopped (Ctrl+C in their command window). Already-running processes retain their previous behavior until stopped.
2. Double-click the combined setup EXE as the intended signed-in user.
3. The welcome screen shows **Install**. Choose it to see installation progress and then the completion screen. No silent switch is needed for normal installation.
4. Open **LanVibes** from Start after installation. This remains a per-user application in `%LOCALAPPDATA%\LanVibes`.
5. To remove it, quit all sessions and uninstall **LanVibes** from Installed apps, or open the setup EXE again and choose Uninstall.

The embedded architecture-specific MSIs are build components and retain minimal UI. Give users the combined EXE to get the wizard. A 32-bit OS is rejected with an explanatory message. The EXE bootstrapper can run under Windows emulation; selection uses the native architecture, not the bootstrapper process architecture.

## Idle exit

Quit now attempts to close the current browser tab after stopping the agent. Export results before choosing Quit. If browser policy prevents automatic closing, a stopped-session message explains that the user can close the tab manually; export remains available while that tab stays open.

Earlier Windows package builds incorrectly produced console/server executables because a build condition did not expand its property. The current release retains the fix for that packaging defect and defaults Windows/macOS launches to desktop mode. It uses **5 minutes** after the last completed authenticated local request, with a check every second. Local refreshes and test requests reset the clock; active requests prevent termination. Merely leaving the tab open does not keep the agent alive. Closing it leaves the agent until idle expiry. **Quit LanVibes** stops the session explicitly.

The timeout applies to packaged desktop sessions. A manually started `--headless` server is intended for developer/CLI hosting and remains running. The application does not install a Windows service, scheduled task or startup entry. Each separate desktop launch owns its own process and idle timer.

## Optional unattended installation

Use explicit switches only for IT automation. These are per-user packages: run as the target user, not SYSTEM.

```powershell
./LanVibes-0.8.0-windows-setup-unsigned.exe /install /quiet /norestart
./LanVibes-0.8.0-windows-setup-unsigned.exe /uninstall /quiet /norestart
```

For troubleshooting, append `/log "C:\path\LanVibes-setup.log"`. Upgrades use the MSI's existing upgrade identity, including upgrades from the standalone 0.2.0 MSI. Exported reports remain in the user's chosen location after uninstall. Downgrades are blocked; keep older artifacts for controlled rollback after uninstall.

## Build and validation

```powershell
dotnet tool install wix --tool-path .build/tools --version 6.0.2
./.build/tools/wix.exe extension add WixToolset.BootstrapperApplications.wixext/6.0.2
./packaging/build-windows-bundle.ps1
```

The project NuGet.Config uses the public NuGet feed. The build creates both self-contained MSIs and the combined EXE. Windows installer payloads are **unsigned pilot builds**; organization application-control policy may require signing/approval. Do not disable device protection if it blocks execution.

The x64 installer and application can be tested on this build workstation. Native ARM64 device acceptance remains required. The LanVibes 0.8.0 Mac build kit includes both native architectures and the new icon; installer creation and validation require a Mac. This update does not deploy anything through Intune.

Wizard implementation: [WiX standard bootstrapper](https://docs.firegiant.com/wix/tools/burn/wixstdba/). Native architecture selection: [Burn built-in variables](https://docs.firegiant.com/wix/tools/burn/builtin-variables/).

## Launch and speed-test defaults

Start opens the default browser automatically after the listener is ready, with no command window. The app chooses an available loopback port instead of requiring users to enter port 17891. The speed-test checkbox starts checked; no external tests run until the user clicks Run network tests.




## Expired tabs and signing

Quit on a tab whose agent is unreachable now explains that the session may have expired, then attempts to close only that tab. It does not claim confirmed process shutdown after a network error. Saved results remain exportable if the browser keeps the tab open.

For signed production builds, follow [Azure Artifact Signing](AZURE-SIGNING.md). The supplied account is configured; identity validation and a certificate profile must be completed before signing.
