#!/usr/bin/env bash
# Assemble the clean Chrome Web Store upload zip. This directory doubles as the
# unpacked-load target AND the Python test harness, so the store package must be
# a CURATED copy — extension runtime files only, no test tooling, no bytecode,
# no "_"-prefixed names (Chrome reserves those). Never zip the raw directory.
#
#   bash packaging/extension/build-store-zip.sh
#
# Output: packaging/extension/store/mememage-chrome-<version>.zip
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(grep -m1 '"version"' manifest.json | sed 's/.*"version"[^"]*"\([^"]*\)".*/\1/')
STAGE="store/pkg"
ZIP="store/mememage-chrome-${VERSION}.zip"

# The runtime surface, and only it. sync-vendor.sh keeps vendor/mememage current.
SHIP=(manifest.json background.js detector.js content.js popup.html popup.js icons fonts vendor)

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"
for item in "${SHIP[@]}"; do
  if [ ! -e "$item" ]; then echo "MISSING ship item: $item" >&2; exit 1; fi
  cp -R "$item" "$STAGE/"
done

# Scrub anything Chrome rejects or that shouldn't ride along: bytecode, OS cruft,
# and any "_"-prefixed file/dir (reserved). Belt-and-suspenders — SHIP is already
# a whitelist, but vendor/ is copied whole.
find "$STAGE" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE" \( -name '*.pyc' -o -name '.DS_Store' \) -delete 2>/dev/null || true

# Hard guard: no reserved names anywhere in the staged tree.
if find "$STAGE" -name '_*' | grep -q .; then
  echo "GUARD FAIL: reserved \"_\"-prefixed name in the package:" >&2
  find "$STAGE" -name '_*' >&2
  exit 1
fi
# Hard guard: manifest must be present and parse.
python3 -c "import json,sys; json.load(open('$STAGE/manifest.json'))" \
  || { echo "GUARD FAIL: manifest.json is not valid JSON" >&2; exit 1; }

( cd "$STAGE" && zip -qr -X "../../$ZIP" . )
rm -rf "$STAGE"

echo "built $ZIP  (v$VERSION)"
echo "contents:"
unzip -l "$ZIP" | awk 'NR>3 && $4!="" {print "  "$4}' | grep -v '^  $' | sort
SIZE=$(du -h "$ZIP" | cut -f1)
echo "size: $SIZE"
