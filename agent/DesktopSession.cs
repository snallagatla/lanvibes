using System.Diagnostics;
using System.Security.Cryptography;
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("LanVibes.Tests")]

// A launch owns its listener and random session. No shared port or machine-wide service.
internal sealed class DesktopSession
{
    public readonly string Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private readonly Func<long> now;
    private long lastActivity;
    private int activeRequests;
    internal DesktopSession(Func<long>? clock = null)
    {
        now = clock ?? (() => Environment.TickCount64);
        lastActivity = now();
    }
    public void Enter() { Interlocked.Increment(ref activeRequests); Touch(); }
    public void Leave() { Touch(); Interlocked.Decrement(ref activeRequests); }
    private void Touch() => Interlocked.Exchange(ref lastActivity, now());
    public bool Idle => Volatile.Read(ref activeRequests) == 0 &&
        now() - Interlocked.Read(ref lastActivity) >= TimeSpan.FromMinutes(5).TotalMilliseconds;
    public string CookieName(int port) => $"LanVibes-{port}";
    public bool Matches(string? value) => value is not null && value.Length == Token.Length &&
        CryptographicOperations.FixedTimeEquals(System.Text.Encoding.ASCII.GetBytes(value), System.Text.Encoding.ASCII.GetBytes(Token));

    public static void OpenBrowser(string url)
    {
        if (OperatingSystem.IsWindows()) Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        else if (OperatingSystem.IsMacOS())
        {
            var start = new ProcessStartInfo("/usr/bin/open") { UseShellExecute = false };
            start.ArgumentList.Add(url);
            Process.Start(start);
        }
        else throw new PlatformNotSupportedException("Desktop launch supports Windows and macOS.");
    }
}
