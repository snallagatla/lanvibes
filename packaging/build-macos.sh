#!/bin/bash
# Run on a Mac with Apple Command Line Tools. No .NET SDK needed for packaging.
set -euo pipefail
cd "$(dirname "$0")"
version=0.8.0
rid="${1:-osx-arm64}"
case "$rid" in osx-arm64|osx-x64) ;; *) echo 'Use osx-arm64 or osx-x64' >&2; exit 1 ;; esac
[[ "$(uname -s)" == Darwin ]] || { echo 'Build this installer on macOS.' >&2; exit 1; }
payload="payloads/$rid"
[[ -f "$payload/LanVibes.DnsAgent" ]] || { echo "Missing $payload" >&2; exit 1; }
stage="$(mktemp -d "${TMPDIR:-/tmp}/lanvibes-pkg.XXXXXX")"
app="$stage/LanVibes.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" output
cp assets/lanvibes.icns "$app/Contents/Resources/lanvibes.icns"
# Keep managed assemblies and web assets out of the native-code directory.
mkdir -p "$app/Contents/Resources/payload"
cp -R "$payload/." "$app/Contents/Resources/payload/"
chmod 755 "$app/Contents/Resources/payload/LanVibes.DnsAgent"
cat > "$stage/launcher.c" <<'LAUNCHER'
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
    (void)argc;
    uint32_t size = 0;
    _NSGetExecutablePath(NULL, &size);
    char *path = malloc(size);
    if (!path || _NSGetExecutablePath(path, &size) != 0) return 1;
    char *slash = strrchr(path, '/');
    if (!slash) { free(path); return 1; }
    *slash = '\0';
    const char *suffix = "/../Resources/payload/LanVibes.DnsAgent";
    size_t length = strlen(path) + strlen(suffix) + 1;
    char *target = malloc(length);
    if (!target) { free(path); return 1; }
    snprintf(target, length, "%s%s", path, suffix);
    free(path);
    argv[0] = target;
    execv(target, argv);
    perror("Cannot start LanVibes");
    free(target);
    return 1;
}
LAUNCHER
arch=arm64
if [[ "$rid" == osx-x64 ]]; then arch=x86_64; fi
/usr/bin/xcrun clang -arch "$arch" -mmacosx-version-min=14.0 -Wall -Wextra -Werror "$stage/launcher.c" -o "$app/Contents/MacOS/LanVibes"

cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.lanvibes.diagnostics</string>
<key>CFBundleName</key><string>LanVibes</string>
<key>CFBundleDisplayName</key><string>LanVibes</string>
<key>CFBundleExecutable</key><string>LanVibes</string>
<key>CFBundleIconFile</key><string>lanvibes.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>$version</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
EOF
/usr/bin/plutil -lint "$app/Contents/Info.plist"
label=unsigned
signing_identity='-'
# Bash 3.2 treats empty arrays as unset under nounset; guard optional expansions below.
code_sign_args=()
if [[ -n "${APPLICATION_IDENTITY:-}" ]]; then
  [[ -n "${INSTALLER_IDENTITY:-}" ]] || { echo 'Also set INSTALLER_IDENTITY.' >&2; exit 1; }
  signing_identity="$APPLICATION_IDENTITY"
  code_sign_args=(--timestamp --options runtime)
  label=signed
fi
# Cross-published apphosts need at least an ad-hoc signature on Apple Silicon.
# Ad-hoc signing is not Developer ID signing and does not establish Gatekeeper trust.
while IFS= read -r -d '' binary; do
  if /usr/bin/file -b "$binary" | /usr/bin/grep -q 'Mach-O'; then
    /usr/bin/codesign --force ${code_sign_args[@]+"${code_sign_args[@]}"} --entitlements entitlements.plist --sign "$signing_identity" "$binary"
  fi
done < <(find "$app/Contents/Resources/payload" -type f -print0)
/usr/bin/codesign --force ${code_sign_args[@]+"${code_sign_args[@]}"} --entitlements entitlements.plist --sign "$signing_identity" "$app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
pkg="output/LanVibes-$version-$rid-$label.pkg"
sign_args=()
if [[ "$label" == signed ]]; then sign_args=(--sign "$INSTALLER_IDENTITY" --timestamp); fi
/usr/bin/pkgbuild --component "$app" --install-location /Applications --identifier com.lanvibes.diagnostics --version "$version" ${sign_args[@]+"${sign_args[@]}"} "$pkg"
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  [[ "$label" == signed ]] || { echo 'Notarization requires signed application and installer.' >&2; exit 1; }
  /usr/bin/xcrun notarytool submit "$pkg" --keychain-profile "$NOTARY_PROFILE" --wait
  /usr/bin/xcrun stapler staple "$pkg"
  /usr/bin/xcrun stapler validate "$pkg"
  /usr/sbin/spctl --assess --type install --verbose=2 "$pkg"
fi
/usr/bin/shasum -a 256 "$pkg" > "$pkg.sha256"
echo "Created $pkg. Staging retained at $stage. Validate on a Mac of the matching architecture before distributing."
