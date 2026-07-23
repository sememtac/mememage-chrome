#!/usr/bin/env bash
# Copy the vendored JS into the extension. No bundler.
#
#  • The SDK (packaging/js) — zero-dep ESM the service worker imports directly.
#  • The detector (packaging/detector) — its GENERATED plain-script global build, which
#    content scripts load (they cannot import ESM). Rebuilt here before copying.
#  • The resolver (packaging/resolver) — a single ESM module the service worker imports.
#    Fully I/O-injected (no bare-specifier imports), so a plain copy vendors cleanly.
#
# Re-run after any packaging/js, packaging/detector, or packaging/resolver change. The
# extension must never fork these sources — Python -> SDK -> gate stays the single parity
# chain, and the detector + resolver behavior gate is this extension's machine test.
set -euo pipefail
cd "$(dirname "$0")"

# --- SDK ---
rm -rf vendor/mememage && mkdir -p vendor/mememage
cp ../js/src/*.js vendor/mememage/
echo "vendored $(ls vendor/mememage | wc -l | tr -d ' ') SDK modules from packaging/js/src"

# --- detector (rebuild its global, then copy) ---
( cd ../detector && node build.mjs >/dev/null )
cp ../detector/dist/mememage-detector.global.js vendor/mememage-detector.js
echo "vendored detector global ($(wc -c < vendor/mememage-detector.js | tr -d ' ') bytes) from packaging/detector"

# --- resolver (single injected ESM module the SW imports) ---
cp ../resolver/src/resolver.js vendor/mememage-resolver.js
echo "vendored resolver ($(wc -c < vendor/mememage-resolver.js | tr -d ' ') bytes) from packaging/resolver"
