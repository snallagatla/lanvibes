using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

// LanVibes DNS Agent: read-only, loopback-only proof of concept. No shell commands accept browser input.
// For a service deployment, package/sign the executable, run as an unprivileged user,
// and review same-origin local access, data sensitivity and endpoint management lifecycle.
var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true };
if (args.Length > 0 && args[0] == "--self-test")
{
    const string fixture = """
DNS configuration

resolver #1
  nameserver[0] : 192.0.2.1
  order : 200000
resolver #2
  domain : corp.example
  search domain[0] : corp.example
  nameserver[0] : 198.51.100.53
  flags : Supplemental
  if_index : 7 (utun4)

DNS configuration (for scoped queries)
resolver #1
  nameserver[0] : 192.0.2.1
  if_index : 4 (en0)
  flags : Scoped
""";
    var result = Snapshot.ParseMacResolvers(fixture).ToArray();
    if (result.Length != 3 || result[0].Kind != "resolver" ||
        result[1].Kind != "supplemental" || result[1].Domain != "corp.example" ||
        result[1].Interface != "utun4" || result[2].Kind != "scoped" ||
        result[2].Interface != "en0")
        throw new Exception("macOS scutil parser fixture FAILED");
    Console.WriteLine("macOS scutil parser fixture PASS (3 resolvers: general, supplemental, scoped)");
    return;
}
if (args.Length > 0 && args[0] == "--snapshot")
{
    var snapshot = await Snapshot.CollectAsync();
    var json = JsonSerializer.Serialize(snapshot, jsonOptions);
    if (args.Length > 1) await File.WriteAllTextAsync(args[1], json);
    else Console.WriteLine(json);
    return;
}

// Offline-first mode: dashboard and API share one exact loopback origin.
// Do not add remote origins or wildcard CORS support to this local diagnostics app.
// Desktop behavior is a runtime default, not a compile-time packaging flag.
// Only explicit --headless opts Windows/macOS into a persistent CLI server.
bool desktopMode = !args.Contains("--headless") &&
    (OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() || args.Contains("--desktop"));
var session = desktopMode ? new DesktopSession() : null;
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = args.Where(a => a != "--desktop" && a != "--headless" && a != "--no-browser").ToArray(), ContentRootPath = AppContext.BaseDirectory });
if (desktopMode) builder.Logging.ClearProviders(); // Never log the browser bootstrap token.
var diagnostics = DiagnosticConfig.Load(Path.Combine(builder.Environment.ContentRootPath, "diagnostics.json"));
builder.WebHost.UseUrls($"http://127.0.0.1:{(desktopMode ? 0 : diagnostics.Port)}"); // NEVER bind to a LAN address.
var app = builder.Build();
var localHost = $"127.0.0.1:{diagnostics.Port}";
var localOrigin = $"http://{localHost}";
app.Use(async (ctx, next) =>
{
    // Restrict both direct requests and DNS rebinding attempts to this exact listener.
    if (!IPAddress.IsLoopback(ctx.Connection.RemoteIpAddress ?? IPAddress.None) ||
        !string.Equals(ctx.Request.Host.Value, localHost, StringComparison.Ordinal))
    {
        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }

    // No CORS. Reject any Origin that is not the dashboard's own origin.
    var origin = ctx.Request.Headers["Origin"].ToString();
    if (origin.Length > 0 && !string.Equals(origin, localOrigin, StringComparison.Ordinal))
    {
        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }

    // Reject fetches to the diagnostic API from other sites. Missing headers from
    // command-line clients and typed browser navigations are still permitted.
    var fetchSite = ctx.Request.Headers["Sec-Fetch-Site"].ToString();
    if ((ctx.Request.Path.StartsWithSegments("/dns") || ctx.Request.Path.StartsWithSegments("/diagnostics") || ctx.Request.Path.StartsWithSegments("/system") || ctx.Request.Path.StartsWithSegments("/config")) && fetchSite.Length > 0 &&
        fetchSite != "same-origin" && fetchSite != "none")
    {
        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }

    ctx.Response.Headers["Cache-Control"] = "no-store";
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    ctx.Response.Headers["X-Frame-Options"] = "DENY";
    ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
    ctx.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
    ctx.Response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
    // JavaScript is local and external; no inline script or event handlers permitted.
    ctx.Response.Headers["Content-Security-Policy"] =
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; connect-src 'self' https: wss:; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    if (ctx.Request.Method == "OPTIONS")
    {
        ctx.Response.StatusCode = StatusCodes.Status405MethodNotAllowed;
        return;
    }
    if (session is not null)
    {
        var cookieName = session.CookieName(ctx.Request.Host.Port!.Value);
        if (ctx.Request.Path == "/launch" && ctx.Request.Method == "GET" && session.Matches(ctx.Request.Query["token"]))
        {
            ctx.Response.Cookies.Append(cookieName, session.Token, new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Strict, Path = "/", IsEssential = true });
            ctx.Response.Redirect("/");
            return;
        }
        if (!session.Matches(ctx.Request.Cookies[cookieName]))
        {
            ctx.Response.StatusCode = 403;
            return;
        }
        session.Enter();
    }
    try { await next(); }
    finally { session?.Leave(); }
});

// wwwroot/index.html is copied with the project and publish output; requests to
// the dashboard are served from the same local origin as /dns.
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapGet("/health", () => Results.Json(new
{
    service = "LanVibes DNS Agent", schemaVersion = 1, status = "ok", mode = "offline-local"
}));
var localGate = new SemaphoreSlim(1, 1);
app.MapGet("/dns", async (HttpContext ctx) =>
{
    if (!await localGate.WaitAsync(0, ctx.RequestAborted)) return Results.StatusCode(429);
    try { return Results.Json(await Snapshot.CollectAsync(ctx.RequestAborted), jsonOptions); }
    finally { localGate.Release(); }
});
app.MapGet("/config", () =>
{
    var value = JsonSerializer.SerializeToNode(diagnostics, jsonOptions)!;
    value["desktopSession"] = desktopMode;
    return Results.Json(value, jsonOptions);
});
app.MapPost("/session/quit", (HttpContext ctx) =>
{
    if (session is null) return Results.NotFound();
    if (ctx.Request.Headers["Origin"] != localOrigin || ctx.Request.Headers["X-LanVibes"] != "run")
        return Results.StatusCode(403);
    ctx.Response.OnCompleted(() => { app.Lifetime.StopApplication(); return Task.CompletedTask; });
    return Results.Ok();
});
app.MapGet("/system", async (HttpContext ctx) =>
{
    if (!await localGate.WaitAsync(0, ctx.RequestAborted)) return Results.StatusCode(429);
    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
    deadline.CancelAfter(TimeSpan.FromSeconds(30));
    try { return Results.Json(await NativeDiagnostics.SystemAsync(deadline.Token), jsonOptions); }
    catch (OperationCanceledException) { return Results.StatusCode(408); }
    finally { localGate.Release(); }
});
var diagnosticGate = new SemaphoreSlim(1, 1);
app.MapPost("/diagnostics/{id}", async (string id, HttpContext ctx) =>
{
    // Imported HTTPS targets use the same authenticated origin, validation and probe budget.
    if (ctx.Request.Headers["Origin"] != localOrigin || ctx.Request.Headers["X-LanVibes"] != "run")
        return Results.StatusCode(403);
    var runConfig = diagnostics;
    string? dnsOnlyHost = null;
    if (id == "custom" && ctx.Request.ContentLength is > 0)
    {
        if (ctx.Request.ContentLength is null or > 8192 || !ctx.Request.HasJsonContentType()) return Results.BadRequest();
        try
        {
            var imported = await ctx.Request.ReadFromJsonAsync<ImportedTarget>(ctx.RequestAborted);
            if (imported is null) return Results.BadRequest();
            var (target, dnsOnly, host) = imported.Validate();
            if (dnsOnly) dnsOnlyHost = host;
            runConfig = new DiagnosticConfig { Targets = [target], PingTargetId = "custom" };
            runConfig.Validate();
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or BadHttpRequestException)
        { return Results.BadRequest(new { error = "Invalid custom URL, DNS hostname or test mode." }); }
    }
    else if (id != "dns-servers" && id != "ping" && id != "portal" && !diagnostics.Targets.Any(t => t.Id == id))
        return Results.NotFound();
    if (!await diagnosticGate.WaitAsync(0, ctx.RequestAborted)) return Results.StatusCode(429);
    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
    deadline.CancelAfter(TimeSpan.FromSeconds(45));
    try { return Results.Json(dnsOnlyHost is null
        ? await NativeDiagnostics.RunAsync(id, runConfig, deadline.Token)
        : await NativeDiagnostics.ResolveOnlyAsync(dnsOnlyHost, deadline.Token), jsonOptions); }
    catch (OperationCanceledException) { return Results.StatusCode(408); }
    finally { diagnosticGate.Release(); }
});
if (session is null)
{
    Console.WriteLine($"LanVibes local dashboard: {localOrigin}/");
    app.Run();
}
else
{
    await app.StartAsync();
    localOrigin = app.Urls.Single();
    localHost = new Uri(localOrigin).Authority;
    using var idleTimer = new Timer(_ => { if (session.Idle) app.Lifetime.StopApplication(); }, null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
    try
    {
        var launchUrl = $"{localOrigin}/launch?token={session.Token}";
        // Explicit CLI automation mode: stdout is private to the calling process.
        if (args.Contains("--no-browser")) Console.WriteLine($"Launch: {launchUrl}");
        else DesktopSession.OpenBrowser(launchUrl);
        await app.WaitForShutdownAsync();
    }
    finally { await app.StopAsync(); }
}
