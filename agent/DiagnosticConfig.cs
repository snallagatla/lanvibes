using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

public sealed record DiagnosticTarget(string Id, string Name, string Url, bool Corporate);
public sealed class DiagnosticConfig
{
    public int Port { get; set; } = 17891;
    public DiagnosticTarget[] Targets { get; set; } = [];
    public string DirectDnsName { get; set; } = "example.com";
    public string PingTargetId { get; set; } = "public";
    public string[] ManagedDnsServers { get; set; } = [];
    public string[] LegacyDnsServers { get; set; } = [];
    public string[] PublicIpv4 { get; set; } = [];
    public string[] PublicIpv6 { get; set; } = [];
    public string[] LatencyEndpoints { get; set; } = ["https://speed.cloudflare.com/__down?bytes=1", "https://dns.google/resolve?name=example.com&type=A"];
    public bool IncludeLegacyDnsPlaceholders { get; set; }
    public string[] Doh { get; set; } = [];
    public string[] WebSockets { get; set; } = [];
    public string? DownloadUrl { get; set; }
    public string? UploadUrl { get; set; }
    public string? PortalUrl { get; set; }
    public int PortalExpectedStatus { get; set; } = 204;
    public string PortalExpectedBody { get; set; } = "";

    public static DiagnosticConfig Load(string path)
    {
        var config = JsonSerializer.Deserialize<DiagnosticConfig>(File.ReadAllText(path), new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? throw new InvalidDataException("Missing diagnostic configuration.");
        config.Validate();
        return config;
    }
    public void Validate()
    {
        if (Port is < 1024 or > 65535) throw new InvalidDataException("Port must be between 1024 and 65535.");
        if (Targets is null || Targets.Length is < 1 or > 20 || Targets.Any(t => t is null ||
            !Regex.IsMatch(t.Id ?? "", "^[a-z][a-z0-9-]{0,31}$") || string.IsNullOrWhiteSpace(t.Name) || t.Name.Length > 100 ||
            new[] { "dns-servers", "ping", "portal" }.Contains(t.Id)) || Targets.Select(t => t.Id).Distinct().Count() != Targets.Length)
            throw new InvalidDataException("Targets must have unique, non-reserved IDs and names (maximum 20).");
        if (!Targets.Any(t => t.Id == PingTargetId)) throw new InvalidDataException("Unknown ping target.");
        if (string.IsNullOrEmpty(DirectDnsName) || DirectDnsName.Length > 253 ||
            DirectDnsName.Split('.').Any(l => l.Length is < 1 or > 63 || !Regex.IsMatch(l, "^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$")))
            throw new InvalidDataException("Invalid direct DNS query name.");
        foreach (var url in Targets.Select(t => t.Url)) ValidateUrl(url, "https");
        foreach (var list in new[] { PublicIpv4, PublicIpv6, LatencyEndpoints, Doh, WebSockets })
        {
            if (list is null || list.Length > 8) throw new InvalidDataException("Invalid endpoint list.");
            foreach (var url in list) ValidateUrl(url, ReferenceEquals(list, WebSockets) ? "wss" : "https");
        }
        foreach (var url in new[] { DownloadUrl, UploadUrl }) if (url != null) ValidateUrl(url, "https");
        if (PortalUrl != null) ValidateUrl(PortalUrl, "http", "https");
        if (PortalExpectedStatus is < 200 or > 299 || PortalExpectedBody is null || PortalExpectedBody.Length > 4096)
            throw new InvalidDataException("Portal response must be a bounded successful response.");
        foreach (var list in new[] { ManagedDnsServers, LegacyDnsServers })
            if (list is null || list.Length > 1000 || list.Any(x => !IPAddress.TryParse(x, out _)))
                throw new InvalidDataException("DNS inventory must contain IP addresses.");
        if (ManagedDnsServers.Select(IPAddress.Parse).Intersect(LegacyDnsServers.Select(IPAddress.Parse)).Any())
            throw new InvalidDataException("DNS inventories overlap.");
    }
    private static void ValidateUrl(string? value, params string[] schemes)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || !schemes.Contains(uri.Scheme) ||
            string.IsNullOrEmpty(uri.Host) || uri.UserInfo.Length > 0 || uri.Fragment.Length > 0 || value!.Length > 2048)
            throw new InvalidDataException("Invalid diagnostic endpoint URL.");
    }
}
