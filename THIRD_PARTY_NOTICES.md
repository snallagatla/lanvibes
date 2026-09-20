# Third-party components

LanVibes source code, documentation and original artwork are licensed under Apache-2.0 unless otherwise stated. Bundled dependencies are not relicensed under Apache-2.0.

Self-contained packages include .NET and ASP.NET Core runtimes. Their license and third-party notices are included under `licenses/`. The checked-in notices correspond to runtime 10.0.10; update them when changing runtime versions.

Windows installers are built with WiX 6.0.2 and include its bootstrapper components. Preserve the WiX license and applicable redistribution exceptions with release artifacts. Tool caches and downloaded third-party binaries must not be committed as LanVibes source.

Public diagnostic endpoints are independently operated services, not project dependencies or endorsements. Their own terms govern use. The source does not embed or redistribute those services.
