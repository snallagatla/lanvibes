# LanVibes local dashboard design

The agent serves bundled dashboard assets and read-only workstation observations over IPv4 loopback. Desktop launches use an authenticated random port and open the browser; explicit headless hosting defaults to port 17891. No external hosting, VPN, or internet access is required to launch the dashboard and inspect local settings.

External diagnostics run only after user action. Targets are validated configuration entries; the public distribution includes only example.com and documented public diagnostic providers. Generic Office/VPN profiles allow users to include locally configured private targets without automatic VPN detection.

The agent does not modify network settings or automatically upload reports. Reports contain full collected network details and must be treated as private. Loopback checks, session authentication, same-origin requests, concurrency limits, cancellation, and bounded responses reduce exposure; they do not protect against every process running as the same user.

Desktop packaging is on demand, with no service or login startup. Quit and idle shutdown stop the local agent. Native macOS installer creation and real-device validation require a Mac. Signing, update distribution, and any website hosting are separate deployment choices.

Acceptance testing should cover offline startup, native DNS output comparison, VPN/split DNS, IPv4 and IPv6, proxies, browser policy, cancellation, sleep/resume, idle shutdown, and report import/export. See README for automated checks and remaining device testing.
