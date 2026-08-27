# Nex Packaging

Three ways to install Nex on Windows, plus from-source builds for macOS/Linux.

---

## 1. Winget (from GitHub)

```powershell
winget install --source=https://github.com/MrEmoji27/nex/packaging/winget MrEmoji27.Nex
```

> **Note:** The public winget repository (`winget install MrEmoji27.Nex`) requires a PR to `microsoft/winget-pkgs`. Pre-release versions like `3.0.0-alpha.1` may be refused there.

---

## 2. One-line PowerShell (Windows)

```powershell
irm https://raw.githubusercontent.com/MrEmoji27/nex/main/packaging/install.ps1 | iex
```

- Resolves pinned release via GitHub API
- Downloads the `.exe` installer
- **Verifies SHA256 before execution** (security critical)
- Runs Inno Setup silently (`/VERYSILENT /SUPPRESSMSGBOXES`)
- Cleans up temp file
- Requires Windows + PowerShell 5.1+

---

## 3. Manual Download (Windows)

1. Go to [Releases](https://github.com/MrEmoji27/nex/releases)
2. Download `Nex-setup-3.0.0-alpha.8.exe`
3. Verify SHA256: `57d6ca51f7dfa152b5e420c70f86690aaad8ea1c3f27cc8372b8bc138a36d487`
   ```powershell
   Get-FileHash Nex-setup-3.0.0-alpha.8.exe -Algorithm SHA256
   ```
4. Run the installer (adds to user PATH, creates Start Menu shortcuts)

---

## 4. One-line Shell (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/MrEmoji27/nex/main/packaging/install.sh | sh
```

- Resolves pinned release via GitHub API
- Downloads the prebuilt `tar.gz` for your platform
- **Verifies SHA256 before execution** (security critical)
- Installs `nex` and `nex-audio` to `~/.local/bin` (no sudo)
- Cleans up temp files
- Requires macOS or Linux + `curl` + `sha256sum`/`shasum`

> **Important:** As of `v3.0.0-alpha.8`, **no macOS or Linux binaries are published yet**. The script will detect this and exit with instructions to build from source (see below). When binaries are published, the same command will download and install them.

---

## 5. Build from Source (macOS / Linux)

```bash
git clone https://github.com/MrEmoji27/nex.git
cd nex
bash packaging/build-unix.sh
```

This builds both `nex` (via `bun build --compile`) and the `nex-audio` sidecar (via `cargo build --release`), then packages them into a `tar.gz` under `dist/`. The script refuses to finish if the audio sidecar is missing.

To install the result:
```bash
tar -xzf dist/nex-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/;s/arm64/arm64/').tar.gz -C ~/.local/bin
```
(Or just run `install.sh` once binaries are published — it does this automatically.)

---

## Cutting a Release

1. Tag the release:
   ```bash
   git tag -a v3.0.0-alpha.8 -m "Nex 3.0.0-alpha.8"
   git push origin v3.0.0-alpha.8
   ```

2. Build the Windows installer:
   ```bash
   cd packaging
   ./build-installer.sh
   ```
   Outputs `../dist/Nex-setup-3.0.0-alpha.8.exe`

3. Build the macOS/Linux archives:
   ```bash
   ./build-unix.sh
   ```
   Outputs `../dist/nex-darwin-arm64.tar.gz`, `../dist/nex-darwin-x64.tar.gz`, `../dist/nex-linux-x64.tar.gz`, `../dist/nex-linux-arm64.tar.gz` (run on each platform, or use CI)

4. Upload all assets to the GitHub Release.

5. **Update packaging files** with the new version and SHA256:
   - `packaging/winget/MrEmoji27.Nex.yaml` — `PackageVersion`
   - `packaging/winget/MrEmoji27.Nex.installer.yaml` — `PackageVersion`, `InstallerUrl`, `InstallerSha256`
   - `packaging/winget/MrEmoji27.Nex.locale.en-US.yaml` — `PackageVersion`
   - `packaging/install.ps1` — `$version`, `$assetName`, `$expectedSha256`
   - `packaging/install.sh` — `VERSION`, `ASSET_TABLE` (add entries with real filenames and SHA256s)
   - `packaging/build-unix.sh` — no version pins; it builds whatever is in the tree

6. Commit the updated packaging files.

---

## Security

**Always verify the SHA256 before running any installer.** The one-liners (`install.ps1` and `install.sh`) do this automatically. A piped installer that executes an unverified binary is the exact supply-chain attack this guards against.

**Do not invent checksums for files that do not exist.** A placeholder hash that silently passes is worse than no script. The `install.sh` asset table uses empty strings for missing assets, causing the script to exit with a clear message instead of pretending the binary exists.