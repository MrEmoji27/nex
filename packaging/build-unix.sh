#!/usr/bin/env bash
# Build the Nex macOS/Linux binaries end-to-end.
# Usage: bash packaging/build-unix.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/5 typecheck"
bun run typecheck

echo "==> 2/5 tests"
bun test

echo "==> 3/5 audio sidecar"
( cd audio && cargo build --release )
# The sidecar binary name differs by platform
if [ "$(uname -s)" = "Darwin" ]; then
    SIDECAR_BIN="audio/target/release/nex-audio"
else
    SIDECAR_BIN="audio/target/release/nex-audio"
fi
test -f "$SIDECAR_BIN" || { echo "sidecar missing; voice would silently fail"; exit 1; }

echo "==> 4/5 compile nex binary"
rm -f dist/nex
bun build --compile --outfile dist/nex src/main/nex.tsx
test -f dist/nex || { echo "nex binary not produced"; exit 1; }

echo "==> 5/5 package tar.gz"
# Detect platform for archive naming
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac
PLATFORM="${OS}-${ARCH}"

ARCHIVE_NAME="nex-${PLATFORM}.tar.gz"
mkdir -p dist/pkg
cp dist/nex dist/pkg/
cp "$SIDECAR_BIN" dist/pkg/nex-audio
tar -czf "dist/$ARCHIVE_NAME" -C dist/pkg nex nex-audio
rm -rf dist/pkg

echo "Created dist/$ARCHIVE_NAME"
ls -la "dist/$ARCHIVE_NAME"
echo "Done."