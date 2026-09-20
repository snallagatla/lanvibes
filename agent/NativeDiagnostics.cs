using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using System.Text;

public sealed record CheckResult(string Name, string Status, string Detail, double? Milliseconds = null);
public static class NativeDiagnostics
{
    public static async Task<List<CheckResult>> ResolveOnlyAsync(string host, CancellationToken ct) =>
        [await Check("OS DNS", async token =>
        {
            var addresses = await Dns.GetHostAddressesAsync(host, token);
            if (addresses.Length == 0) throw new IOException("OS resolver returned no addresses.");
            return $"{host}: {string.Join(", ", addresses.Select(a => a.ToString()))}. OS policy/cache applies. DNS-only: no TCP, TLS or HTTP probes.";
        }, ct)];
    public static async Task<List<CheckResult>> RunAsync(string id, DiagnosticConfig config, CancellationToken ct) => id switch
    {
        "dns-servers" => await DnsServersAsync(config, ct),
        "ping" => await PingAsync(config.Targets.Single(t => t.Id == config.PingTargetId), ct),
        "portal" => await PortalAsync(config, ct),
        _ => await TargetAsync(config.Targets.Single(t => t.Id == id), ct)
    };

    private static string Error(Exception ex) => ex is OperationCanceledException ? "Timed out" : $"{ex.GetType().Name}: {ex.Message}";
    private static async Task<CheckResult> Check(string name, Func<CancellationToken, Task<string>> action, CancellationToken ct, int seconds = 6)
    {
        ct.ThrowIfCancellationRequested();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(seconds));
        var timer = Stopwatch.StartNew();
        try { return new(name, "pass", await action(deadline.Token), Math.Round(timer.Elapsed.TotalMilliseconds)); }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) { return new(name, ex is SocketException or System.Security.Authentication.AuthenticationException ? "fail" : "inconclusive", Error(ex), Math.Round(timer.Elapsed.TotalMilliseconds)); }
    }

    public static async Task<List<CheckResult>> TargetAsync(DiagnosticTarget target, CancellationToken ct)
    {
        var uri = new Uri(target.Url);
        var results = new List<CheckResult>();
        IPAddress[] addresses = [];
        results.Add(await Check("OS DNS", async token =>
        {
            addresses = await Dns.GetHostAddressesAsync(uri.DnsSafeHost, token);
            if (addresses.Length == 0) throw new IOException("OS resolver returned no addresses.");
            return $"{uri.DnsSafeHost}: {string.Join(", ", addresses.Select(a => a.ToString()))}. OS policy/cache applies; resolver identity is not observed.";
        }, ct));

        // Probe both families independently, bounded to one address per family. Never claim all returned addresses were tested.
        foreach (var address in addresses.GroupBy(a => a.AddressFamily).Select(g => g.First()))
        {
            using var tcp = new TcpClient(address.AddressFamily);
            var connection = await Check($"TCP {address}:{uri.Port}", async token =>
            {
                await tcp.ConnectAsync(address, uri.Port, token);
                return $"Connected directly; local endpoint {tcp.Client.LocalEndPoint}. No HTTP proxy used.";
            }, ct);
            results.Add(connection);
            if (connection.Status != "pass") continue;
            using var tls = new SslStream(tcp.GetStream(), leaveInnerStreamOpen: true);
            results.Add(await Check($"TLS {address}", async token =>
            {
                await tls.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
                {
                    TargetHost = uri.DnsSafeHost,
                    CertificateRevocationCheckMode = X509RevocationMode.NoCheck
                }, token);
                using var cert = tls.RemoteCertificate is null ? null : new X509Certificate2(tls.RemoteCertificate);
                return $"{tls.SslProtocol}; certificate expires {cert?.NotAfter.ToUniversalTime():O}. Hostname and trust validated; revocation not checked.";
            }, ct));
        }
        if (addresses.Length == 0) results.Add(new("Direct TCP/TLS", "not-applicable", "Skipped because OS resolution did not produce an address."));
        // HTTP has its own path because the agent's default proxy may resolve/connect on the device's behalf.
        int? httpStatus = null;
        var http = await Check("HTTP (agent proxy path)", async token =>
        {
            using var client = CreateClient();
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
            var status = (int)response.StatusCode;
            httpStatus = status;
            return $"HTTP {status}; " + (status == 407 ? "proxy authentication required; no credentials submitted. " : status is 401 or 403 ? "application authentication/authorization required or request denied. " : "") +
                "Redirects not followed; no application login attempted. A response proves an HTTP peer replied, not application health.";
        }, ct);
        results.Add(http with { Status = httpStatus == 407 || httpStatus >= 500 ? "fail" : httpStatus >= 400 ? "inconclusive" : http.Status });
        // Route command accepts only an IP produced by the OS, never shell text from the browser.
        if (addresses.FirstOrDefault() is { } routeAddress)
            results.Add(await RouteAsync(routeAddress, ct));
        return results;
    }

    private static HttpClient CreateClient() => new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false, UseCookies = false, Credentials = null,
        ConnectTimeout = TimeSpan.FromSeconds(5)
    }) { Timeout = Timeout.InfiniteTimeSpan };

    private static async Task<CheckResult> RouteAsync(IPAddress ip, CancellationToken ct)
    {
        if (OperatingSystem.IsWindows())
            return await Command("Selected route", "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
                $"$ErrorActionPreference='Stop'; Find-NetRoute -RemoteIPAddress '{ip}' | Select-Object InterfaceAlias,InterfaceIndex,IPAddress,DestinationPrefix,NextHop,RouteMetric | ConvertTo-Json -Depth 3"], ct);
        if (OperatingSystem.IsMacOS()) return await Command("Selected route", "/sbin/route", ["-n", "get", ip.AddressFamily == AddressFamily.InterNetworkV6 ? "-inet6" : "-inet", ip.ToString()], ct);
        return new("Selected route", "not-applicable", "Supported on Windows and macOS.");
    }

    public static async Task<List<CheckResult>> SystemAsync(CancellationToken ct)
    {
        var results = new List<CheckResult>();
        results.Add(await Check("Adapter addressing", _ =>
        {
            var adapters = NetworkInterface.GetAllNetworkInterfaces().Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback);
            var descriptions = new List<string>();
            foreach (var adapter in adapters)
            {
                try
                {
                    var ip = adapter.GetIPProperties();
                    var addresses = ip.UnicastAddresses.Select(a => a.Address.ToString()).ToArray();
                    var linkLocal = ip.UnicastAddresses.Any(a => a.Address.AddressFamily == AddressFamily.InterNetwork && a.Address.GetAddressBytes()[0] == 169 && a.Address.GetAddressBytes()[1] == 254);
                    descriptions.Add($"{adapter.Name} ({adapter.NetworkInterfaceType}): {string.Join(", ", addresses)}; gateways {string.Join(", ", ip.GatewayAddresses.Select(g => g.Address))}" +
                        (linkLocal ? "; IPv4 link-local address detected; inspect DHCP (not proof of DHCP failure)." : ""));
                }
                catch (Exception ex) { descriptions.Add($"{adapter.Name}: {Error(ex)}"); }
            }
            return Task.FromResult(descriptions.Count > 0 ? string.Join("\n", descriptions) : "No active non-loopback adapters reported.");
        }, ct));
        if (OperatingSystem.IsWindows())
        {
            results.Add(await Command("Default routes and DHCP", "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Stop'; @{ Routes=@(Get-NetRoute | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0','::/0') } | Select-Object InterfaceAlias,InterfaceIndex,DestinationPrefix,NextHop,RouteMetric); Interfaces=@(Get-NetIPInterface | Select-Object InterfaceAlias,AddressFamily,ConnectionState,Dhcp,InterfaceMetric) } | ConvertTo-Json -Depth 4"], ct));
            results.Add(await Command("User proxy / PAC", "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
                @"$ErrorActionPreference='Stop'; Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select-Object ProxyEnable,ProxyServer,ProxyOverride,AutoConfigURL,AutoDetect | ConvertTo-Json"], ct));
            results.Add(await Command("WinHTTP proxy", "netsh.exe", ["winhttp", "show", "proxy"], ct));
            results.Add(await Command("Wi-Fi link", "netsh.exe", ["wlan", "show", "interfaces"], ct));
        }
        else if (OperatingSystem.IsMacOS())
        {
            results.Add(await Command("Routes", "/usr/sbin/netstat", ["-rn"], ct));
            results.Add(await Command("System proxy / PAC", "/usr/sbin/scutil", ["--proxy"], ct));
            results.Add(new("Wi-Fi link", "not-applicable", "Detailed Wi-Fi signal collection requires a supported native integration and permissions; adapter/link state is shown above."));
        }
        else results.Add(new("Platform inventory", "not-applicable", "Windows and macOS are supported."));
        results.Add(new("Proxy interpretation", "not-applicable", "Read-only settings for the agent's user. Browser policy/extensions, PAC selection, and service-user settings can differ. No proxy authentication or PAC script is executed by this inventory."));
        return results;
    }

    public static async Task<CheckResult> Command(string name, string file, string[] arguments, CancellationToken ct)
    {
        return await Check(name, async token =>
        {
            using var process = new Process { StartInfo = new(file) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true } };
            foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
            process.Start();
            try
            {
                var output = process.StandardOutput.ReadToEndAsync(token);
                var error = process.StandardError.ReadToEndAsync(token);
                await process.WaitForExitAsync(token);
                var text = await output;
                var err = await error;
                if (process.ExitCode != 0) throw new IOException($"Exit {process.ExitCode}: {err.Trim()}");
                return string.IsNullOrWhiteSpace(text) ? "Command completed with no entries." : text[..Math.Min(text.Length, 24000)].Trim();
            }
            finally { if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(CancellationToken.None); } }
        }, ct);
    }

    private static async Task<List<CheckResult>> PingAsync(DiagnosticTarget target, CancellationToken ct)
    {
        var results = new List<CheckResult>();
        IPAddress? ip = null;
        results.Add(await Check("ICMP target resolution", async token =>
        {
            ip = (await Dns.GetHostAddressesAsync(new Uri(target.Url).DnsSafeHost, token)).First();
            return ip.ToString();
        }, ct));
        if (ip is null) return results;
        var samples = new List<long>();
        var errors = new List<string>();
        for (var i = 0; i < 6; i++)
        {
            ct.ThrowIfCancellationRequested();
            using var ping = new Ping();
            try
            {
                var reply = await ping.SendPingAsync(ip, TimeSpan.FromSeconds(1), new byte[32], null, ct);
                if (reply.Status == IPStatus.Success) samples.Add(reply.RoundtripTime);
                else errors.Add(reply.Status.ToString());
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex) { errors.Add(Error(ex)); }
            await Task.Delay(150, ct);
        }
        var jitter = samples.Count > 1 ? samples.Zip(samples.Skip(1), (a, b) => (double)Math.Abs(a - b)).Average() : 0;
        results.Add(new("ICMP latency / loss", samples.Count == 6 ? "pass" : "inconclusive",
            $"{samples.Count}/6 replies; observed loss {(6 - samples.Count) * 100 / 6.0:F1}%. " +
            (samples.Count > 0 ? $"Mean {samples.Average():F1} ms; min {samples.Min()} ms; max {samples.Max()} ms; mean successive RTT difference {jitter:F1} ms. " : "") +
            "Small ICMP sample only; filtering/rate limiting may explain loss. " + string.Join("; ", errors.Distinct())));
        return results;
    }

    private static async Task<List<CheckResult>> DnsServersAsync(DiagnosticConfig config, CancellationToken ct)
    {
        var adapters = new List<ResolverAdapter>();
        var results = new List<CheckResult>();
        foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces().Where(n => n.OperationalStatus == OperationalStatus.Up))
        {
            try { adapters.Add(new(adapter.Name, adapter.GetIPProperties().DnsAddresses.ToArray())); }
            catch (Exception ex) { results.Add(new($"Resolver inventory: {adapter.Name}", "inconclusive", Error(ex))); }
        }
        var plan = ResolverSelection.Select(adapters, OperatingSystem.IsWindows() && !config.IncludeLegacyDnsPlaceholders);
        results.Insert(0, new("Direct DNS scope", "not-applicable", $"Queries {config.DirectDnsName} A and AAAA directly, bypassing OS split-DNS policy/cache. Selected {plan.Selected.Length} resolvers (maximum four), taking turns across active adapters. This is not effective-route selection; answers may legitimately differ."));
        foreach (var candidate in plan.LegacyDefaults)
            results.Add(new($"Skipped Windows default: {candidate.Address}", "not-applicable", $"Reported by {string.Join(", ", candidate.Adapters)}. Historical Windows automatic DNS address; not actively tested by default. Still visible in the DNS snapshot. Set includeLegacyDnsPlaceholders=true if your network intentionally uses it."));
        foreach (var candidate in plan.Omitted)
            results.Add(new($"Not sampled: {candidate.Address}", "not-applicable", $"Reported by {string.Join(", ", candidate.Adapters)}. Omitted by the four-resolver budget, not a reachability finding."));
        foreach (var candidate in plan.Selected)
            foreach (var type in new ushort[] { 1, 28 })
                foreach (var tcp in new[] { false, true })
                {
                    var result = await Check($"{candidate.Address} {(type == 1 ? "A" : "AAAA")} {(tcp ? "TCP" : "UDP")} DNS", async token =>
                        await DnsWire.QueryAsync(candidate.Address, config.DirectDnsName, type, tcp, token), ct, 2);
                    results.Add(result with { Detail = $"Adapter(s): {string.Join(", ", candidate.Adapters)}. {result.Detail}" });
                }
        if (plan.Selected.Length == 0) results.Add(new("Configured resolvers", "inconclusive", "No eligible adapter DNS addresses to test; inspect the snapshot and skipped entries."));
        return results;
    }

    private static async Task<List<CheckResult>> PortalAsync(DiagnosticConfig config, CancellationToken ct)
    {
        if (config.PortalUrl is null) return [new("Captive portal", "not-applicable", "No controlled portal-detection endpoint configured.")];
        var status = "inconclusive";
        var result = await Check("Captive portal", async token =>
        {
            using var client = CreateClient();
            using var response = await client.GetAsync(config.PortalUrl, HttpCompletionOption.ResponseHeadersRead, token);
            await using var stream = await response.Content.ReadAsStreamAsync(token);
            var buffer = new byte[4097];
            var count = 0;
            while (count < buffer.Length)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(count), token);
                if (read == 0) break;
                count += read;
            }
            var matches = (int)response.StatusCode == config.PortalExpectedStatus && count <= 4096 && Encoding.UTF8.GetString(buffer, 0, count) == config.PortalExpectedBody;
            status = matches ? "pass" : "inconclusive";
            return matches ? "Expected status and body received. No portal interception observed for this request." : $"Unexpected HTTP {(int)response.StatusCode} or content. Possible portal, proxy interception, or endpoint change; not proof of a captive portal.";
        }, ct);
        return [result with { Status = result.Status == "pass" ? status : result.Status }];
    }
}
