using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Text.Json;
using System.Text.RegularExpressions;

public sealed record AdapterInfo(
    string Name, string Id, string Status, string Type,
    string[] Addresses, string[] Gateways, string[] DnsServers, string DnsSuffix);
public sealed record ResolverInfo(
    string Kind, string? Domain, string? Interface, string[] NameServers,
    string[] SearchDomains, string? Flags, int? Order);
public sealed record NrptInfo(string Namespace, string[] NameServers);
public sealed record DnsSnapshot(
    int SchemaVersion, string Source, string Os, DateTimeOffset CapturedAt,
    AdapterInfo[] Adapters, ResolverInfo[] Resolvers, NrptInfo[] Nrpt,
    string[] Warnings);

public static class Snapshot
{
    public static async Task<DnsSnapshot> CollectAsync(CancellationToken ct = default)
    {
        var warnings = new List<string>();
        var adapters = new List<AdapterInfo>();
        NetworkInterface[] networks;
        try { networks = NetworkInterface.GetAllNetworkInterfaces(); }
        catch (Exception ex) { networks = []; warnings.Add("Adapter enumeration unavailable: " + ex.GetType().Name); }
        foreach (var network in networks)
        {
            try
            {
                var ip = network.GetIPProperties();
                adapters.Add(new AdapterInfo(
                    network.Name, network.Id, network.OperationalStatus.ToString(),
                    network.NetworkInterfaceType.ToString(),
                    ip.UnicastAddresses.Select(x => x.Address.ToString()).ToArray(),
                    ip.GatewayAddresses.Select(x => x.Address.ToString()).ToArray(),
                    ip.DnsAddresses.Select(x => x.ToString()).Distinct().ToArray(),
                    ip.DnsSuffix ?? ""));
            }
            catch (Exception ex) { warnings.Add($"Cannot inspect adapter {network.Name}: {ex.GetType().Name}"); }
        }

        var resolvers = Array.Empty<ResolverInfo>();
        var nrpt = Array.Empty<NrptInfo>();
        if (OperatingSystem.IsMacOS())
        {
            var (output, error) = await RunFixedCommandAsync(ct, "/usr/sbin/scutil", "--dns");
            if (error != null) warnings.Add("macOS scutil --dns unavailable: " + error);
            else resolvers = ParseMacResolvers(output!).ToArray();
        }
        if (OperatingSystem.IsWindows())
        {
            // NRPT is separate from adapter DNS settings; include when available.
            const string command = "$ErrorActionPreference='Stop'; Get-DnsClientNrptPolicy -Effective | Select-Object Namespace,NameServers | ConvertTo-Json -Compress -Depth 5";
            var (output, error) = await RunFixedCommandAsync(ct, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command);
            if (error != null) warnings.Add("Windows NRPT unavailable: " + error);
            else
            {
                try { nrpt = ParseNrpt(output!).ToArray(); }
                catch (JsonException) { warnings.Add("Windows NRPT output could not be parsed."); }
            }
        }
        if (adapters.Count == 0) warnings.Add("No network adapters could be enumerated.");
        return new DnsSnapshot(1, "LanVibes local agent", OperatingSystem.IsWindows() ? "Windows" :
            OperatingSystem.IsMacOS() ? "macOS" : "Unsupported OS", DateTimeOffset.UtcNow,
            adapters.ToArray(), resolvers, nrpt, warnings.ToArray());
    }

    public static IEnumerable<ResolverInfo> ParseMacResolvers(string output)
    {
        // scutil output presents a general resolver section and optionally a scoped section.
        var kind = "resolver";
        var blockKind = kind;
        Dictionary<string, List<string>>? block = null;
        foreach (var raw in output.Replace("\r", "").Split('\n').Append("resolver #END"))
        {
            var line = raw.Trim();
            if (line.StartsWith("DNS configuration (for scoped queries)", StringComparison.OrdinalIgnoreCase))
            { kind = "scoped"; continue; }
            if (line.StartsWith("DNS configuration", StringComparison.OrdinalIgnoreCase))
            { kind = "resolver"; continue; }
            if (Regex.IsMatch(line, @"^resolver #(?:\d+|END)$"))
            {
                if (block is not null)
                {
                    var servers = Values(block, "nameserver");
                    if (servers.Length > 0)
                    {
                        var domain = Values(block, "domain").FirstOrDefault();
                        var flags = Values(block, "flags").FirstOrDefault();
                        var index = Values(block, "if_index").FirstOrDefault();
                        var matchedInterface = index is null ? null : Regex.Match(index, @"\(([^)]+)\)");
                        var interfaceName = matchedInterface is { Success: true } ? matchedInterface.Groups[1].Value : null;
                        var orderText = Values(block, "order").FirstOrDefault();
                        int? order = int.TryParse(orderText, out var n) ? n : null;
                        yield return new ResolverInfo(blockKind == "scoped" ? "scoped" :
                            !string.IsNullOrEmpty(domain) ? "supplemental" : "resolver",
                            domain, interfaceName, servers, Values(block, "search domain"), flags, order);
                    }
                }
                block = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
                blockKind = kind;
                continue;
            }
            if (block is null) continue;
            var match = Regex.Match(line, @"^(.+?)(?:\[\d+\])?\s*:\s*(.*)$");
            if (!match.Success) continue;
            var key = match.Groups[1].Value.Trim();
            var value = match.Groups[2].Value.Trim();
            if (!block.TryGetValue(key, out var values)) block[key] = values = new List<string>();
            values.Add(value);
        }
    }

    private static string[] Values(Dictionary<string, List<string>> block, string key) =>
        block.TryGetValue(key, out var values) ? values.ToArray() : Array.Empty<string>();

    public static IEnumerable<NrptInfo> ParseNrpt(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) yield break;
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        var entries = root.ValueKind == JsonValueKind.Array ? root.EnumerateArray().ToArray() : new[] { root };
        foreach (var entry in entries)
        {
            if (entry.ValueKind != JsonValueKind.Object) continue;
            var ns = entry.TryGetProperty("Namespace", out var n) ?
                (n.ValueKind == JsonValueKind.Array ? string.Join(", ", n.EnumerateArray().Select(x => x.ToString())) : n.ToString()) : "";
            var servers = new List<string>();
            if (entry.TryGetProperty("NameServers", out var val))
            {
                if (val.ValueKind == JsonValueKind.Array)
                    servers.AddRange(val.EnumerateArray().Select(e => e.ToString()));
                else if (val.ValueKind == JsonValueKind.String)
                    servers.AddRange(val.GetString()!.Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries));
            }
            if (!string.IsNullOrWhiteSpace(ns)) yield return new NrptInfo(ns, servers.ToArray());
        }
    }

    private static async Task<(string? Output, string? Error)> RunFixedCommandAsync(CancellationToken ct, string path, params string[] arguments)
    {
        try
        {
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo(path)
            {
                RedirectStandardOutput = true, RedirectStandardError = true,
                UseShellExecute = false, CreateNoWindow = true
            };
            foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
            process.Start();
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(5));
            try
            {
                var stdout = process.StandardOutput.ReadToEndAsync(deadline.Token);
                var stderr = process.StandardError.ReadToEndAsync(deadline.Token);
                await process.WaitForExitAsync(deadline.Token);
                var output = await stdout;
                var err = await stderr;
                return process.ExitCode == 0 ? (output, null) : (null, err.Trim().Length > 0 ? err.Trim() : $"exit {process.ExitCode}");
            }
            catch (OperationCanceledException)
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
                ct.ThrowIfCancellationRequested();
                return (null, "timed out");
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) { return (null, ex.GetType().Name); }
    }
}
