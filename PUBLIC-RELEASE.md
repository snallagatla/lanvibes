# Preparing a public release

The source defaults are provider-neutral and contain only public diagnostic endpoints. DNS inventory lists are empty. Corporate targets must be configured by each user; keep such customizations and reports private.

## What belongs in GitHub

Use `node scripts/export-public-source.mjs` to produce a reviewed source tree and ZIP under `dist/`. Start your public repository from that clean tree. It deliberately excludes build caches, installed runtimes, installers, signing metadata, diagnostic reports, screenshots, and historical validation logs.

Run `node scripts/audit-public-source.mjs` before committing. Review the resulting URL inventory in `dist/public-url-inventory.txt`. This is a focused source-content check, not a guarantee against every possible secret. Review staged files as well. If publishing an existing Git repository, review its history separately; ignore rules do not remove committed history. The workspace used for this preparation had no Git repository/history.

The only remaining pre-rename identifier in application code supports old report imports. Installer tests also recognize the previous installation name so they cannot accidentally replace an existing installation.

## Downloads

Attach only freshly built, reviewed 0.5.0-or-later installers to GitHub Releases. Do not upload the old 0.4.0 or earlier packages: they were built with organization-specific targets. The entire `dist/` tree is ignored because it may contain those historical files; do not drag it wholesale into GitHub's upload page.

New packages are unsigned. Publish their SHA-256 checksums and describe their pilot status. The macOS ZIP is a build kit and requires a Mac to create and validate the installer. Signing and website hosting are optional follow-up work.

## Configuration migration

`managedDnsServers` replaces the old vendor-specific DNS inventory setting. Local configurations must adopt this key. The generic Home/Office/VPN selection, proxy checks, routes, NRPT and resolver checks remain because they apply to many networks. Default targets contain only `https://example.com/`.

## License and ownership

The repository includes Apache License 2.0, a project NOTICE, and separate third-party notices. Copyright attribution uses “LanVibes contributors” rather than exposing an individual account or employer name. Before publishing, confirm that you have the right to release the contributed code and artwork; removing employer-specific settings does not establish copyright ownership.

## Runtime privacy

The application intentionally collects the current user's network configuration when run. Support reports can contain addresses, network names, proxy settings and diagnostic results. Those are user-generated data, not repository examples. The included example snapshots use documentation-only addresses. Do not attach real support reports to public issues without reviewing them.
