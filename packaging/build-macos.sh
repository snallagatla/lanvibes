#!/bin/bash
# Run on a Mac. Payloads are already self-contained; no .NET SDK needed.
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
cp -R "$payload/." "$app/Contents/MacOS/"
chmod 755 "$app/Contents/MacOS/LanVibes.DnsAgent"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.lanvibes.diagnostics</string>
<key>CFBundleName</key><string>LanVibes</string>
<key>CFBundleDisplayName</key><string>LanVibes</string>
<key>CFBundleExecutable</key><string>LanVibes.DnsAgent</string>
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
    /usr/bin/codesign --force "${code_sign_args[@]}" --entitlements entitlements.plist --sign "$signing_identity" "$binary"
  fi
done < <(find "$app/Contents/MacOS" -type f -print0)
/usr/bin/codesign --force "${code_sign_args[@]}" --entitlements entitlements.plist --sign "$signing_identity" "$app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
pkg="output/LanVibes-$version-$rid-$label.pkg"
sign_args=()
if [[ "$label" == signed ]]; then sign_args=(--sign "$INSTALLER_IDENTITY" --timestamp); fi
/usr/bin/pkgbuild --component "$app" --install-location /Applications --identifier com.lanvibes.diagnostics --version "$version" "${sign_args[@]}" "$pkg"
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  [[ "$label" == signed ]] || { echo 'Notarization requires signed application and installer.' >&2; exit 1; }
  /usr/bin/xcrun notarytool submit "$pkg" --keychain-profile "$NOTARY_PROFILE" --wait
  /usr/bin/xcrun stapler staple "$pkg"
  /usr/bin/xcrun stapler validate "$pkg"
  /usr/sbin/spctl --assess --type install --verbose=2 "$pkg"
fi
/usr/bin/shasum -a 256 "$pkg" > "$pkg.sha256"
echo "Created $pkg. Staging retained at $stage. Validate on a Mac of the matching architecture before distributing."
