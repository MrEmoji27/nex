#!/usr/bin/env bash
# Build the Nex Windows installer end-to-end.
# Usage: bash packaging/build-installer.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/4 typecheck"
bun run typecheck

echo "==> 2/4 tests"
bun test

echo "==> 3/4 compile binary"
rm -f dist/nex.exe
bun build --compile --outfile dist/nex.exe src/main/nex.tsx

echo "==> 4/4 installer"
"/c/Program Files (x86)/Inno Setup 6/ISCC.exe" "packaging/nex.iss" >/dev/null

ls -la dist/Nex-setup-*.exe
echo "Done."
