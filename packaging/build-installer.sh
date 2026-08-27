#!/usr/bin/env bash
# Build the Nex Windows installer end-to-end.
# Usage: bash packaging/build-installer.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/5 typecheck"
bun run typecheck

echo "==> 2/5 tests"
bun test

echo "==> 3/5 audio sidecar"
( cd audio && cargo build --release )
test -f audio/target/release/nex-audio.exe || { echo "sidecar missing; voice would silently fail"; exit 1; }

echo "==> 4/5 compile binary"
rm -f dist/nex.exe
bun build --compile --outfile dist/nex.exe src/main/nex.tsx

echo "==> 5/5 installer"
"/c/Program Files (x86)/Inno Setup 6/ISCC.exe" "packaging/nex.iss" >/dev/null

ls -la dist/Nex-setup-*.exe
echo "Done."
