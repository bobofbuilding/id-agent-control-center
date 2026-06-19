#!/bin/bash
# Build a consumer-ready macOS .app bundle for idctl with the brand icon.
# Produces dist/ID Agents Control Center.app — double-click opens the TUI in
# Terminal. The standalone binary is bundled inside, so the .app is fully
# self-contained (no Node, no install needed).
#
# Requires: the compiled binary at dist/idctl-<arch> (run `npm run build:bin`
# first), plus macOS `sips` + `iconutil` (both stock).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_NAME="ID Agents Control Center"
BUNDLE_ID="world.idchain.idctl"
VERSION="$(node -e "process.stdout.write(require('./package.json').version)")"
SRC_ICON="assets/icon-source.jpg"
ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && ARCH="x64" || ARCH="arm64"
BIN="dist/idctl-darwin-${ARCH}"

[ -f "$BIN" ] || { echo "missing $BIN — run: npm run build:bin -- darwin-${ARCH}"; exit 1; }
[ -f "$SRC_ICON" ] || { echo "missing $SRC_ICON"; exit 1; }

APP="dist/${APP_NAME}.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ── 1. Icon: jpg → 1024 master png → .iconset (all sizes) → .icns ──
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
sips -s format png -z 1024 1024 "$SRC_ICON" --out "$WORK/master.png" >/dev/null
ICONSET="$WORK/AppIcon.iconset"; mkdir -p "$ICONSET"
for spec in "16:16x16" "32:16x16@2x" "32:32x32" "64:32x32@2x" \
            "128:128x128" "256:128x128@2x" "256:256x256" "512:256x256@2x" \
            "512:512x512" "1024:512x512@2x"; do
  px="${spec%%:*}"; nm="${spec##*:}"
  sips -z "$px" "$px" "$WORK/master.png" --out "$ICONSET/icon_${nm}.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# ── 2. Bundle the standalone binary + a Terminal launcher ──
cp "$BIN" "$APP/Contents/MacOS/idctl"
chmod +x "$APP/Contents/MacOS/idctl"

cat > "$APP/Contents/MacOS/launcher" <<'SH'
#!/bin/bash
# .app entry point: open the TUI in a new Terminal window (needs a real TTY).
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/idctl"
CMD="clear; exec \"$BIN\""
osascript - "$CMD" <<'OSA'
on run argv
  tell application "Terminal"
    activate
    do script (item 1 of argv)
  end tell
end run
OSA
SH
chmod +x "$APP/Contents/MacOS/launcher"

# ── 3. Info.plist + PkgInfo ──
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

# ── 4. Codesign (ad-hoc): inner JIT binary with entitlements, then the bundle ──
codesign --force --options runtime --entitlements build/entitlements.plist --sign - "$APP/Contents/MacOS/idctl" >/dev/null 2>&1 || true
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "built: $APP  (v${VERSION}, ${ARCH})"
