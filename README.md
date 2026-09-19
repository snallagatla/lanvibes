# LanVibes — offline-first workstation network diagnostics

LanVibes serves a local dashboard and read-only workstation configuration from a .NET 10 agent. Windows/macOS launches open the default browser on an authenticated random loopback port. Explicit `--headless` hosting uses **http://127.0.0.1:17891/** by default. Startup contacts only the local agent; external diagnostics run only after **Run network tests**.

Status: working proof of concept with automated regression coverage. It remains a foreground app, not an installed Windows Service or macOS launchd service. Windows browser startup and Stop behavior were checked. macOS/VPN/proxy real-device acceptance testing remains required.

## Run

Install the .NET 10 SDK (Visual Studio: ASP.NET and web development workload). Open `agent/LanVibes.DnsAgent.csproj` and choose `LanVibes.Offline`, or run:

```powershell
dotnet run --project ./agent/LanVibes.DnsAgent.csproj --launch-profile LanVibes.Offline
```

Stop an earlier instance before rebuilding its executable or starting another instance on the same port. In Visual Studio, stop debugging, rebuild, and press F5. A running old process does not automatically adopt source changes.

On macOS:

```bash
dotnet run --project ./agent/LanVibes.DnsAgent.csproj --no-launch-profile

```

The dashboard requires a running agent; opening HTML directly via `file://` is unsupported. No internet, VPN, CDN, Confluence or remote server is required for local DNS collection.

## Workflow

1. Review **Current DNS Configuration**. Refresh reads current local settings. **Import snapshot or report** accepts schema-v1 DNS snapshots and exported support reports up to 5 MB, including reports exported by earlier versions. It validates nested fields and retains previous valid data on failure. Configured DNS does not prove which resolver handled a query.
2. Select **Home / off VPN**, **Office**, or **VPN**. Home skips targets marked `corporate`; Office and VPN include them. These are user-selected expectations, not automatic VPN detection.
3. Optionally select **Include speed tests**. Cloudflare is configured, but transfers are opt-in: one response capped at 20 MB and one 1 MB synthetic upload per run. Application byte limits exclude protocol overhead and already-buffered transport bytes.
4. Click **Run network tests**. Tests run sequentially, with idle latency before throughput. A small HTTP latency sample intentionally overlaps the download. Duplicate starts are disabled.
5. **Stop** aborts browser requests and propagates cancellation to native requests/subprocesses. Completed observations remain; remaining checks show Cancelled. Native cleanup can take a short time; immediate retries can receive HTTP 429.
6. **Inspect local routes, proxy and link** runs only local inventory commands. **Export support report** downloads the displayed DNS snapshot and all collected test names, results, details and timings as JSON for your support team. No redaction option is applied. Nothing is uploaded automatically.

Support reports can be imported into a separate **Imported support report** panel without executing tests or replacing current run results. Import also restores the included DNS snapshot. Older redacted reports remain readable, but omitted DNS data and test names cannot be recovered: results appear as numbered tests, and any existing DNS view is retained separately. The export button always exports the current run results and displayed DNS snapshot, not the separate imported-report panel. The supported export/import file size is 5 MB.

## Coverage and interpretation

| Check | Evidence and limits |
|---|---|
| DNS snapshot | Adapters, addresses, suffixes/servers, gateways, Windows effective NRPT, macOS scoped/supplemental resolvers. Resolver selection is not observed. |
| OS DNS | Native hostname lookup for each configured target, including OS policy/cache behavior. |
| TCP/TLS | Direct connection to the first returned address of each family; local endpoint and TLS hostname/trust validation. Certificate revocation is not checked. No verification bypass. |
| HTTP | Separate agent/default-proxy path; no redirects, application credentials or cookies. 407 identifies a proxy challenge; 401/403 are inconclusive application access; 5xx is a failed HTTP observation. A response does not prove authenticated application health. |
| Selected route | Windows Find-NetRoute / macOS route get for the first resolved address. Other destinations may use different routes. |
| Direct DNS UDP/TCP | A/AAAA queries for a configured public name to up to four DNS servers, selected round-robin across active adapters so one adapter cannot fill the budget first. Retains VPN adapters without gateways and shows adapter context, excluded defaults and omitted candidates. Verifies transaction, echoed question, bounds and compression pointers. Bypasses OS split-DNS policy; answers can legitimately differ. Does not enumerate resolver-only NRPT/scutil servers. |
| Routes/DHCP/link | Active addresses and IPv4 link-local indication; Windows default routes, interface metrics/DHCP; macOS route table. Link-local is not proof of DHCP failure. |
| Proxy/PAC | Windows current-user settings and WinHTTP; macOS scutil proxy settings. Does not execute PAC or authenticate. Browser policy/extensions and service-user settings can differ. |
| Wi-Fi | Windows netsh wlan interface output; errors are explicit. Detailed macOS signal collection is not implemented and is reported Not applicable. |
| ICMP | Six one-second attempts; observed loss, RTT and mean successive RTT difference. Filtering/rate limiting can explain loss; unavailable ICMP is inconclusive. |
| Browser IPv4/IPv6 | Validates address family before accepting fallback. IPv6 is informational. |
| Public DoH A/AAAA | Public resolver access, separate from OS DNS. AAAA does not establish IPv6 transport availability. |
| WebSocket | Exact echo required. Error/timeout/close without echo is inconclusive; no unique firewall diagnosis. |
| Speed/loaded latency | CORS-visible HTTP success required. Download counts received bytes; upload measures request/response time, without independent server byte verification. Small samples are approximate. No generic GitHub POST test. |
| Captive portal | Implemented but disabled until a controlled endpoint is configured. Exact status/body comparison without redirects; mismatch is inconclusive. |

Results: **Pass**, **Fail**, **Inconclusive**, **Not applicable**, **Cancelled**. Overall uses non-informational target observations. Public-address discovery (both IPv4 and IPv6), DoH, speed, latency, ICMP and local inventory are informational and do not independently degrade overall. Cancelled runs are incomplete. Expand stages rather than treating Overall as a root-cause diagnosis.

## Configuration

Edit `agent/diagnostics.json` and rebuild, or edit the file alongside a published executable and restart. Configuration is validated at startup and cannot be edited through the browser.

- `targets`: up to 20 HTTPS targets with unique IDs, names and a `corporate` flag. Defaults retain public and LinkedIn/Okta/Glean/Atlassian/Observe targets.
- `directDnsName`: public name safe to send to every tested adapter resolver; default `example.com`. Do not configure an internal name unless policy permits disclosure to every candidate resolver.
- `pingTargetId`: target ID for ICMP.
- `bluecatDnsServers`, `legacyDnsServers`: approved inventories. Empty inventories classify nothing; overlapping addresses are rejected. IPv6 is normalized.
- `publicIpv4`, `publicIpv6`, `doh`, `webSockets`: HTTPS/WSS browser endpoint lists.
- `latencyEndpoints`: dedicated small CORS-readable HTTPS responses, independent of public-IP discovery. Defaults use a one-byte Cloudflare response and a Google DoH response. A discarded warm-up selects one working endpoint; all six measured samples and loaded-latency probes use that same endpoint. Failed providers are reported separately, not included in the median. Loaded probes start after download headers and are cancelled when transfer ends. A short download can finish without a complete overlapping sample.
- `includeLegacyDnsPlaceholders`: defaults to `false`. On Windows only, skips the exact historical automatic DNS defaults `fec0:0:0:ffff::1`, `::2`, and `::3` (all with prefix `fec0:0:0:ffff`). They remain visible in the snapshot and skipped-result details. Set `true` to test them if intentionally used by your network; no other IPv6 or virtual-adapter resolvers are automatically excluded.
- `downloadUrl`, `uploadUrl`: Cloudflare defaults; replace with approved CORS-capable endpoints or set to `null`. Upload must accept a 1 MB POST and return a small CORS-readable success response. Redirects are rejected. Do not use generic application URLs.
- `portalUrl`: `null` by default; approved HTTP/HTTPS detector. `portalExpectedStatus` defaults to 204 and `portalExpectedBody` to empty. Plain HTTP is permitted only here because interception is being observed. Responses are capped at 4096 bytes.
- `port`: optional, default 17891, range 1024–65535. Exact loopback binding/Host/Origin checks follow it. This setting applies to explicit headless hosting.

No configuration disables TLS trust validation. URL userinfo/credentials are rejected; do not put secrets in configuration.

## API and security boundary

- `GET /health`: liveness; `GET /dns`: schema-v1 local snapshot; `GET /config`: configuration; `GET /system`: local inventory.
- `POST /diagnostics/{id}`: configured target ID, `dns-servers`, `ping`, or `portal`. Requires the exact local Origin and `X-LanVibes: run`. Starts probes, not network-setting mutations. Browser-supplied arbitrary hosts/commands are not accepted.
- Exact Host, loopback peer, foreign-Origin and cross-site fetch checks; no CORS; no-store responses. JavaScript uses local modules; CSP excludes inline scripts.
- One active native diagnostic and one local collection at a time; excess requests get 429. Native requests have 45-second budgets; inventory 30 seconds; individual stages/subprocesses shorter limits. Cancellation propagates.
- Loopback/same-origin is not authentication or per-user isolation. Local processes can access information and invoke probes with matching headers. Review service identity, endpoint sharing and approved destinations before deployment.

## Snapshot CLI and portable publishing

```powershell
dotnet run --project ./agent/LanVibes.DnsAgent.csproj -- --snapshot ./lanvibes-dns.json
dotnet run --project ./agent/LanVibes.DnsAgent.csproj -- --self-test
dotnet publish ./agent/LanVibes.DnsAgent.csproj -c Release -r win-x64 --self-contained true -o ./publish/win-x64
```

For Apple Silicon use `-r osx-arm64`. Distribute the entire publish directory, including `wwwroot` and `diagnostics.json`. Published assets/configuration resolve relative to the executable, independent of working directory. Signing, notarization, service/launchd installation, auto-start, updates and uninstall remain deployment work.

## Regression tests

No third-party test packages required; Node.js 20+ and .NET 10 SDK:

```powershell
node --test tests/core.test.mjs tests/startup.test.mjs tests/probes.test.mjs tests/session.test.mjs
dotnet run --project tests/LanVibes.Tests.csproj -c Release -p:UseAppHost=false
dotnet publish agent/LanVibes.DnsAgent.csproj -c Release -p:UseAppHost=false -o ./publish/validation
node tests/integration.mjs ./publish/validation
```

Native tests cover NRPT/macOS fixtures, DNS protocol validation, configuration and cancellation. JavaScript covers nested imports, full report round trips, legacy redacted report imports, IPv6 fallback, bounded bodies/timeouts, sequential/cancellable runs, upload errors, WebSocket failure and no remote startup probes. Integration tests launch an isolated published copy on a free loopback port, check assets/MIME types/request security, and execute only the disabled portal check. They do not contact external diagnostic endpoints. Temporary integration packages are retained for inspection.

## Device acceptance still required

- Windows/macOS native-output comparison; VPN on/off, split DNS, IPv4-only/dual-stack, proxy/PAC/auth challenges, sleep/resume and adapter changes.
- Disconnect internet/VPN while retaining loopback; reload and verify local collection and no remote startup requests.
- Corporate browser policy/CORS, blocked ICMP, endpoint failures, stalled responses, port collisions, cancellation and recovery.
- Signed desktop packaging and intended per-user privacy model before deployment. Automated validation does not certify public endpoint availability or throughput accuracy across networks.

## Manual pilot packages

See [the Windows 0.4.0 pilot guide](packaging/WINDOWS-PILOT.md). The combined EXE selects x64 or ARM64 automatically and shows an installation wizard by default. Packaged launches run as the signed-in user, use an authenticated random loopback port, open the default browser, and stop through **Quit LanVibes** or 15 minutes without local requests. Active requests prevent idle shutdown. There is no background service or automatic startup. Explicit headless operation retains the configured fixed port and does not auto-exit. Windows/macOS development launches also default to desktop mode. Use `--headless` explicitly with packaged binaries for CLI hosting; `--desktop --no-browser` prints a private launch URL for automated testing and must not be shared. Older release artifacts are historical; use the current LanVibes package.

Windows per-user MSI build scripts and the macOS `.app`/`.pkg` build script are in `packaging/`. `dist/` contains pilot artifacts. macOS payloads can be cross-published, but native installer creation, signing/notarization and device acceptance require a Mac. Test packaged Windows lifecycle with `node tests/desktop.integration.mjs .build/lanvibes/publish/win-x64`.

## Interpreting partial failures

- `Failed to fetch` from public-IP services does not establish an internet outage or absence of IPv6. Browser JavaScript cannot identify whether endpoint availability, DNS/TLS, CORS or policy caused it. Each address family has independent provider fallbacks and strict response validation. An observed address may be a proxy/VPN egress address.
- Corporate/Observe `Not applicable` means the selected Home/off-VPN profile did not run those targets. Select Office or VPN and rerun; no VPN state is inferred.
- Captive-portal `Not applicable` means no controlled detector is configured. Loaded-latency `Not applicable` can mean no baseline or a download too short for an overlapping sample; neither invalidates successful throughput.

## Source layout

`Program.cs` hosts APIs and guards; `Snapshot.cs` collects/parses configuration; `NativeDiagnostics.cs` runs native observations; `DnsWire.cs` handles bounded DNS messages; `DiagnosticConfig.cs` validates configuration. Dashboard modules are `wwwroot/app.mjs` (rendering), `core.mjs` (execution/validation/export) and `probes.mjs` (browser probes). `tests/` contains regression suites and `examples/` synthetic snapshots.




LanVibes branding includes dashboard SVG, Windows executable/installer icons and a macOS icon. See [Azure signing setup](packaging/AZURE-SIGNING.md). Old report format identifiers are accepted for backward compatibility. Windows upgrade identities are retained across the rename.
