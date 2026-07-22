#!/usr/bin/env bash
# Copy the SDK verbatim into the extension. No bundler — the SDK is zero-dep ESM, so
# the extension's service worker imports it directly. Re-run after any packaging/js
# change; the extension must never fork the SDK (Python -> SDK -> gate stays the
# single parity chain, the extension is a thin shell).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf vendor/mememage && mkdir -p vendor/mememage
cp ../js/src/*.js vendor/mememage/
echo "vendored $(ls vendor/mememage | wc -l | tr -d ' ') SDK modules from packaging/js/src"
