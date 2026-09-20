using System.Net;

public sealed record ResolverAdapter(string Name, IPAddress[] Servers);
public sealed record ResolverCandidate(IPAddress Address, string[] Adapters);
public sealed record ResolverProbePlan(ResolverCandidate[] Selected, ResolverCandidate[] LegacyDefaults, ResolverCandidate[] Omitted);

public static class ResolverSelection
{
    // Exact historical Windows automatic defaults, not all site-local/IPv6 addresses.
    // Sites that intentionally use these addresses can opt into probing them.
    private static readonly IPAddress[] LegacyDefaults = [IPAddress.Parse("fec0:0:0:ffff::1"), IPAddress.Parse("fec0:0:0:ffff::2"), IPAddress.Parse("fec0:0:0:ffff::3")];
    public static ResolverProbePlan Select(IEnumerable<ResolverAdapter> source, bool skipLegacyDefaults, int limit = 4)
    {
        var adapters = source.ToArray();
        bool Skip(IPAddress address) => skipLegacyDefaults && LegacyDefaults.Any(d => d.GetAddressBytes().SequenceEqual(address.GetAddressBytes()));
        var all = adapters.SelectMany(a => a.Servers).Distinct().Select(ip =>
            new ResolverCandidate(ip, adapters.Where(a => a.Servers.Contains(ip)).Select(a => a.Name).Distinct().ToArray())).ToArray();
        var eligible = adapters.Select(a => a.Servers.Where(ip => !Skip(ip)).Distinct().ToArray()).ToArray();
        var ordered = new List<IPAddress>();
        // Take one candidate per adapter per round, retaining VPN adapters without gateways.
        for (var i = 0; i < eligible.Select(a => a.Length).DefaultIfEmpty(0).Max(); i++)
            foreach (var servers in eligible)
                if (i < servers.Length && !ordered.Contains(servers[i])) ordered.Add(servers[i]);
        var selected = ordered.Take(Math.Max(0, limit)).Select(ip => all.Single(c => c.Address.Equals(ip))).ToArray();
        return new(selected, all.Where(c => Skip(c.Address)).ToArray(),
            all.Where(c => !Skip(c.Address) && !selected.Any(s => s.Address.Equals(c.Address))).ToArray());
    }
}
