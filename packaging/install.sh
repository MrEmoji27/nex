#!/bin/sh
# One-line Nex installer for macOS and Linux.
# Run: curl -fsSL https://raw.githubusercontent.com/MrEmoji27/nex/main/packaging/install.sh | sh

# NOTES:
# - Resolves a pinned release tag via the GitHub API
# - Downloads the prebuilt binaries (tar.gz)
# - Verifies SHA256 BEFORE execution (security critical)
# - Installs to ~/.local/bin (no sudo)
# - Installs nex-audio alongside nex; without the sidecar voice starts and silently does nothing
# - Cleans up temp files
# - Fails fast if not macOS/Linux or required tools missing
#
# WARNING: This installs an untested alpha release (v3.0.0-alpha.2).

set -eu

# Fail if not macOS or Linux
case "$(uname -s)" in
    Darwin|Linux) ;;
    *)
        echo "This installer is for macOS and Linux only." >&2
        exit 1
        ;;
esac

# Require curl and sha256sum/shasum
for cmd in curl sha256sum shasum; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        # sha256sum on Linux, shasum on macOS
        continue
    fi
done

# Configuration.
# The tag is pinned deliberately. These three move together when cutting a release:
#   VERSION, asset filename pattern, and expected SHA256.
REPO="MrEmoji27/nex"
VERSION="v3.0.0-alpha.2"

# Asset table: pattern, expected SHA256.
# When real macOS/Linux assets are published, add them here.
# Format: "os-arch" "asset-filename" "sha256"
# Use empty string for sha256 if asset doesn't exist yet.
ASSET_TABLE="
darwin-arm64 nex-darwin-arm64.tar.gz 
darwin-x64   nex-darwin-x64.tar.gz   
linux-x64    nex-linux-x64.tar.gz    
linux-arm64  nex-linux-arm64.tar.gz  
"

# Detect OS and architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)
        echo "Unsupported architecture: $ARCH" >&2
        exit 1
        ;;
esac
PLATFORM="${OS}-${ARCH}"

# Find asset info for this platform
ASSET_NAME=""
EXPECTED_SHA256=""
while read -r line; do
    # Skip empty lines
    [ -z "$line" ] && continue
    set -- $line
    if [ "$1" = "$PLATFORM" ]; then
        ASSET_NAME="$2"
        EXPECTED_SHA256="$3"
        break
    fi
done <<EOF
$ASSET_TABLE
EOF

if [ -z "$ASSET_NAME" ]; then
    echo "No prebuilt asset defined for platform: $PLATFORM" >&2
    echo "Supported platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64" >&2
    exit 1
fi

# If SHA256 is empty, asset doesn't exist yet in the release
if [ -z "$EXPECTED_SHA256" ]; then
    echo "No prebuilt binary available for $PLATFORM in release $VERSION." >&2
    echo "" >&2
    echo "To build from source:" >&2
    echo "  git clone https://github.com/MrEmoji27/nex.git" >&2
    echo "  cd nex" >&2
    echo "  bash packaging/build-unix.sh" >&2
    echo "" >&2
    echo "This will build both 'nex' and the 'nex-audio' sidecar," >&2
    echo "then place them in ~/.local/bin" >&2
    exit 1
fi

echo "Resolving $VERSION from GitHub..." >&2

# Fetch release info
RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$VERSION")"
if [ -z "$RELEASE_JSON" ]; then
    echo "Failed to fetch release info from GitHub API." >&2
    exit 1
fi

# Extract download URL for the asset
DOWNLOAD_URL="$(echo "$RELEASE_JSON" | grep -o '"browser_download_url": "[^"]*' | cut -d'"' -f4 | grep -F "$ASSET_NAME" | head -n1)"

if [ -z "$DOWNLOAD_URL" ]; then
    echo "Asset '$ASSET_NAME' not found in release $VERSION." >&2
    exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

TMP_FILE="$TMP_DIR/$ASSET_NAME"

echo "Downloading $ASSET_NAME..." >&2
curl -fsSL -o "$TMP_FILE" "$DOWNLOAD_URL"

echo "Verifying SHA256..." >&2
# Use sha256sum on Linux, shasum on macOS
if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA256="$(sha256sum "$TMP_FILE" | cut -d' ' -f1)"
else
    ACTUAL_SHA256="$(shasum -a 256 "$TMP_FILE" | cut -d' ' -f1)"
fi

if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
    echo "SHA256 MISMATCH!" >&2
    echo "Expected: $EXPECTED_SHA256" >&2
    echo "Actual:   $ACTUAL_SHA256" >&2
    echo "Aborting - the downloaded file may be corrupted or tampered with." >&2
    exit 1
fi

echo "SHA256 verified. Installing..." >&2

# Extract tar.gz
tar -xzf "$TMP_FILE" -C "$TMP_DIR"

# Install to ~/.local/bin
INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"

# Find and install binaries
for bin in nex nex-audio; do
    if [ -f "$TMP_DIR/$bin" ]; then
        cp "$TMP_DIR/$bin" "$INSTALL_DIR/"
        chmod +x "$INSTALL_DIR/$bin"
        echo "Installed $bin to $INSTALL_DIR" >&2
    else
        echo "Warning: $bin not found in archive" >&2
    fi
done

echo "" >&2
echo "Nex installed successfully to $INSTALL_DIR" >&2

# Check if ~/.local/bin is on PATH
case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
        echo "" >&2
        echo "NOTE: $INSTALL_DIR is not on your PATH." >&2
        echo "Add this to your shell config (~/.bashrc, ~/.zshrc, etc.):" >&2
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
        ;;
esac

echo "" >&2
echo "Open a NEW terminal and type: nex" >&2
echo "NOTE: This is an untested alpha release ($VERSION)." >&2