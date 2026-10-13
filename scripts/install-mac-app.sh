#!/bin/bash
# Builds ~/Applications/Machtls-Planner.app and adds it to the Dock.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/scripts/mac-app"
APP="${HOME}/Applications/Machtls-Planner.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

swift "${SRC}/draw-icon.swift" "${WORK}/icon-1024.png"
ICONSET="${WORK}/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "${WORK}/icon-1024.png" --out "${ICONSET}/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "${WORK}/icon-1024.png" --out "${ICONSET}/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "${WORK}/AppIcon.icns"

rm -rf "$APP"
mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"
cp "${SRC}/Info.plist" "${APP}/Contents/Info.plist"
cp "${SRC}/launcher" "${APP}/Contents/MacOS/launcher"
python3 - "${APP}/Contents/MacOS/launcher" "$ROOT" <<'PY'
import pathlib, sys
path, root = sys.argv[1:]
file = pathlib.Path(path)
file.write_text(file.read_text().replace("__PLANNER_ROOT__", root))
PY
cp "${WORK}/AppIcon.icns" "${APP}/Contents/Resources/AppIcon.icns"
chmod +x "${APP}/Contents/MacOS/launcher"
xattr -cr "$APP" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"

python3 - "$APP" <<'PY'
import os, plistlib, sys
app = sys.argv[1]
path = os.path.expanduser("~/Library/Preferences/com.apple.dock.plist")
with open(path, "rb") as handle:
    dock = plistlib.load(handle)
apps = dock.setdefault("persistent-apps", [])

def label(item):
    data = item.get("tile-data", {}).get("file-data", {})
    return str(data.get("_CFURLString", ""))

if any(label(item).endswith("Machtls-Planner.app") for item in apps):
    raise SystemExit(0)
apps.append({
    "tile-type": "file-tile",
    "tile-data": {
        "file-data": {
            "_CFURLString": app,
            "_CFURLStringType": 0,
        }
    },
})
with open(path, "wb") as handle:
    plistlib.dump(dock, handle, fmt=plistlib.FMT_BINARY)
print("dock-added")
PY

killall Dock
echo "Installed ${APP}"
