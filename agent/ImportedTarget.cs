using System.Text.RegularExpressions;

public sealed record ImportedTarget(string? Name, string? Url, string? Dns, string? Mode)
{
    public (DiagnosticTarget Target, bool DnsOnly, string Host) Validate()
    {
        if (Url is not null && Dns is not null) throw new InvalidDataException("Specify URL or DNS, not both.");
        var mode = Mode ?? (Dns is not null ? "dns" : "full");
        if (mode is not ("dns" or "full") || (Dns is not null && mode != "dns")) throw new InvalidDataException("Invalid test mode.");
        string host;
        string url;
        if (Dns is not null)
        {
            host = Dns.Trim().TrimEnd('.');
            if (host.Length is < 1 or > 253 || host.Split('.').Any(label => !Regex.IsMatch(label, "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")))
                throw new InvalidDataException("Invalid DNS hostname.");
            url = $"https://{host}/";
        }
        else { url = Url ?? ""; host = ""; }
        var target = new DiagnosticTarget("custom", Name ?? "", url, false);
        new DiagnosticConfig { Targets = [target], PingTargetId = "custom" }.Validate();
        if (Dns is null) host = new Uri(url).DnsSafeHost;
        return (target, mode == "dns", host);
    }
}
