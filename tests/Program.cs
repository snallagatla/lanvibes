using System.Buffers.Binary;
using System.Text.Json;

var passed = 0;
Test("desktop idle deadline protects active requests and resets after completion", () =>
{
    long clock = 0;
    var session = new DesktopSession(() => clock);
    Assert(!session.Idle);
    clock = 5 * 60 * 1000;
    Assert(session.Idle);
    session.Enter();
    clock += 60 * 60 * 1000;
    Assert(!session.Idle);
    session.Leave();
    Assert(!session.Idle);
    clock += 5 * 60 * 1000 - 1;
    Assert(!session.Idle);
    clock++;
    Assert(session.Idle);
    Assert(session.Matches(session.Token) && !session.Matches(null) && !session.Matches(new string('X', 64)));
    Assert(session.Token != new DesktopSession().Token);
});
void Test(string name, Action test) { test(); Console.WriteLine("PASS " + name); passed++; }
void Assert(bool value) { if (!value) throw new Exception("Assertion failed"); }
void Reject(Action action) { try { action(); } catch (Exception ex) when (ex is IOException or InvalidDataException or ArgumentException) { return; } throw new Exception("Expected invalid input to be rejected"); }
Test("NRPT empty/single/array/string nameservers", () =>
{
    Assert(!Snapshot.ParseNrpt("").Any()); Assert(!Snapshot.ParseNrpt("null").Any());
    var single = Snapshot.ParseNrpt("""{"Namespace":[".corp.example"],"NameServers":"192.0.2.1; 2001:db8::1"}""").Single();
    Assert(single.NameServers.Length == 2 && single.Namespace == ".corp.example");
    Assert(Snapshot.ParseNrpt("""[{"Namespace":".a","NameServers":["192.0.2.1"]},{"Namespace":".b","NameServers":null}]""").Count() == 2);
    try { Snapshot.ParseNrpt("{").ToArray(); throw new Exception("Expected invalid JSON"); } catch (JsonException) { }
});
Test("macOS IPv6, supplemental, scoped, empty and malformed order", () =>
{
    const string fixture = """
DNS configuration
resolver #1
  nameserver[0] : 2001:db8::1
  nameserver[1] : fe80::1%en0
  order : invalid
resolver #2
  domain : corp.example
  nameserver[0] : 192.0.2.53
  search domain[0] : corp.example
  flags : Supplemental
DNS configuration (for scoped queries)
resolver #1
  if_index : 4 (en0)
  nameserver[0] : 192.0.2.1
""";
    var resolvers = Snapshot.ParseMacResolvers(fixture).ToArray();
    Assert(resolvers.Length == 3 && resolvers[0].NameServers.Length == 2 && resolvers[0].Order is null);
    Assert(resolvers[1].Kind == "supplemental" && resolvers[2].Kind == "scoped" && resolvers[2].Interface == "en0");
    Assert(!Snapshot.ParseMacResolvers("").Any());
});
Test("DNS wire compressed A response, wrong transaction, NXDOMAIN and truncation", () =>
{
    var query = DnsWire.BuildQuery("example.com", 1, 42);
    var response = query.Concat(new byte[] { 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 192, 0, 2, 1 }).ToArray();
    response[2] = 0x81; response[3] = 0x80; response[7] = 1;
    Assert(DnsWire.Parse(response, "example.com", 1, 42).Contains("192.0.2.1"));
    Reject(() => DnsWire.Parse(response, "example.com", 1, 43));
    Reject(() => DnsWire.Parse(response, "other.example", 1, 42));
    Reject(() => DnsWire.Parse(response[..^1], "example.com", 1, 42));
    response[3] = 0x83; Reject(() => DnsWire.Parse(response, "example.com", 1, 42));
    response[3] = 0x80; response[2] |= 2; Reject(() => DnsWire.Parse(response, "example.com", 1, 42));
});
Test("DNS wire AAAA and compression pointer cycle", () =>
{
    var query = DnsWire.BuildQuery("example.com", 28, 7);
    var response = query.Concat(new byte[] { 0xc0, 0x0c, 0, 28, 0, 1, 0, 0, 0, 30, 0, 16 }).Concat(System.Net.IPAddress.Parse("2001:db8::1").GetAddressBytes()).ToArray();
    response[2] = 0x81; response[7] = 1;
    Assert(DnsWire.Parse(response, "example.com", 28, 7).Contains("2001:db8::1"));
    response[12] = 0xc0; response[13] = 0x0c;
    Reject(() => DnsWire.Parse(response, "example.com", 28, 7));
});
Test("configuration rejects commands, duplicate IDs, credentials and inventory overlap", () =>
{
    DiagnosticConfig Valid() => new() { Targets = [new("public", "Public", "https://example.com", false)] };
    Valid().Validate();
    var c = Valid(); c.Targets = [new("x;whoami", "Bad", "https://example.com", false)]; Reject(c.Validate);
    c = Valid(); c.Targets = [c.Targets[0], c.Targets[0]]; Reject(c.Validate);
    c = Valid(); c.UploadUrl = "https://user:secret@example.com"; Reject(c.Validate);
    c = Valid(); c.DirectDnsName = "example.com;whoami"; Reject(c.Validate);
    c = Valid(); c.ManagedDnsServers = ["2001:db8::1"]; c.LegacyDnsServers = ["2001:0db8:0:0:0:0:0:1"]; Reject(c.Validate);
});
Test("resolver budget spreads probes across VPN and Wi-Fi and skips legacy Windows defaults", () =>
{
    System.Net.IPAddress Ip(string value) => System.Net.IPAddress.Parse(value);
    var plan = ResolverSelection.Select([
        new("VPN", [Ip("198.51.100.53"), Ip("198.51.100.54")]),
        new("WSL", [Ip("fec0:0:0:ffff::1"), Ip("fec0:0:0:ffff::2"), Ip("fec0:0:0:ffff::3")]),
        new("Wi-Fi", [Ip("192.0.2.53"), Ip("192.0.2.54"), Ip("192.0.2.1")])
    ], true);
    Assert(plan.Selected.Select(c => c.Address.ToString()).SequenceEqual(new[] { "198.51.100.53", "192.0.2.53", "198.51.100.54", "192.0.2.54" }));
    Assert(plan.LegacyDefaults.Length == 3 && plan.Omitted.Single().Address.Equals(Ip("192.0.2.1")));
    Assert(plan.Selected[0].Adapters.Single() == "VPN");
});
Test("legacy resolver opt-in and shared adapter context are preserved", () =>
{
    var legacy = System.Net.IPAddress.Parse("fec0:0:0:ffff::1");
    var real = System.Net.IPAddress.Parse("fec0:0:0:ffff::4");
    ResolverAdapter[] adapters = [new("one", [legacy, real]), new("two", [real])];
    var filtered = ResolverSelection.Select(adapters, true);
    Assert(filtered.Selected.Single().Address.Equals(real) && filtered.Selected[0].Adapters.Length == 2);
    var optedIn = ResolverSelection.Select(adapters, false);
    Assert(optedIn.Selected.Length == 2 && optedIn.LegacyDefaults.Length == 0);
    Assert(ResolverSelection.Select([new("empty", [])], true).Selected.Length == 0);
});
using (var cancelled = new CancellationTokenSource())
{
    cancelled.Cancel();
    try { await NativeDiagnostics.RunAsync("public", new() { Targets = [new("public", "Public", "https://example.com", false)] }, cancelled.Token); throw new Exception("Expected cancellation"); }
    catch (OperationCanceledException) { Console.WriteLine("PASS native cancellation"); passed++; }
}
Console.WriteLine($"{passed} native regression groups passed.");
