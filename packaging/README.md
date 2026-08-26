# Nex Packaging

Three ways to install Nex on Windows.

---

## 1. Winget (from GitHub)

```powershell
winget install --source=https://github.com/MrEmoji27/nex/packaging/winget MrEmoji27.Nex
```

> **Note:** The public winget repository (`winget install MrEmoji27.Nex`) requires a PR to `microsoft/winget-pkgs`. Pre-release versions like `3.0.0-alpha.1` may be refused there.

---

## 2. One-line PowerShell

```powershell
irm https://raw.githubusercontent.com/MrEmoji27/nex/main/packaging/install.ps1 | iex
```

- Resolves latest release via GitHub API
- Downloads the `.exe` installer
- **Verifies SHA256 before execution** (security critical)
- Runs Inno Setup silently (`/VERYSILENT /SUPPRESSMSGBOXES`)
- Cleans up temp file
- Requires Windows + PowerShell 5.1+

---

## 3. Manual Download

1. Go to [Releases](https://github.com/MrEmoji27/nex/releases)
2. Download `Nex-setup-3.0.0-alpha.1.exe`
3. Verify SHA256: `e0cf3c26a34312e9763df3d0c0d65519888339bdab6958b2ae52942ec31149aa`
   ```powershell
   Get-FileHash Nex-setup-3.0.0-alpha.1.exe -Algorithm SHA256
   ```
4. Run the installer (adds to user PATH, creates Start Menu shortcuts)

---

## Cutting a Release

1. Tag the release:
   ```bash
   git tag -a v3.0.0-alpha.1 -m "Nex 3.0.0-alpha.1"
   git push origin v3.0.0-alpha.1
   ```

2. Build the installer:
   ```bash
   cd packaging
   ./build-installer.sh
   ```
   Outputs `../dist/Nex-setup-3.0.0-alpha.1.exe`

3. Upload the `.exe` to the GitHub Release as an asset.

4. **Update packaging files** with the new version and SHA256:
   - `packaging/winget/MrEmoji27.Nex.yaml` — `PackageVersion`
   - `packaging/winget/MrEmoji27.Nex.installer.yaml` — `PackageVersion`, `InstallerUrl`, `InstallerSha256`
   - `packaging/winget/MrEmoji27.Nex.locale.en-US.yaml` — `PackageVersion`
   - `packaging/install.ps1` — `$expectedSha256`, `$assetName`

5. Commit the updated packaging files.

---

## Security

**Always verify the SHA256 before running any installer.** The one-liner (`install.ps1`) does this automatically. A piped installer that executes an unverified binary is the exact supply-chain attack this guards against.