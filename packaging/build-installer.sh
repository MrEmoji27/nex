#!/usr/bin/env bash
# Build the Nex Windows installer end-to-end.
# Usage: bash packaging/build-installer.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# The version lives in three places and they must agree: package.json is what
# the app reports about itself, nex.iss names the installer, and CHANGELOG.md is
# what ships inside the binary. package.json sat at 3.0.0-alpha.2 through four
# releases because nothing checked, so the app told every user it was alpha.2.
echo "==> 0/5 version agreement"
pkg=$(grep -m1 '"version"' package.json | sed 's/.*: *"//; s/".*//')
iss=$(grep -m1 'MyAppVersion' packaging/nex.iss | sed 's/[^"]*"//; s/".*//')
log=$(grep -m1 '^## \[' CHANGELOG.md | sed 's/^## \[//; s/\].*//')
if [ "$pkg" != "$iss" ] || [ "$pkg" != "$log" ]; then
  echo "version mismatch — package.json=$pkg nex.iss=$iss CHANGELOG=$log" >&2
  exit 1
fi
echo "    $pkg"

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
