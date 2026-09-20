# LanVibes public website draft

This standalone static information/download page is ready for local review. It uses the existing logo. It contains no diagnostics, telemetry, third-party resources, internal endpoint configuration or active package download links. Signed Windows releases and validated macOS packages can be linked once ready.

Host only this directory, never the repository root or the entire dist folder. The workstation dashboard in agent/wwwroot remains local; it requires the local agent and session cookie and is not the public website.

Hosting provider, public/internal audience, domain and Azure resource names are awaiting confirmation. No cloud resources or public deployments have been created.

For Azure Static Web Apps, use this directory as the app location with no application build step. For Azure Storage static website hosting, use index.html as the index document. Release binaries can be hosted separately and linked from the page; publish only deliberately selected release files. Configure HTTPS/custom domains according to the selected host's documentation.
