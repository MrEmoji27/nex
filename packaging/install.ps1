<# 
.SYNOPSIS
    One-line Nex installer for Windows.
    Run: irm https://raw.githubusercontent.com/MrEmoji27/nex/main/packaging/install.ps1 | iex

.NOTES
    - Resolves latest release via GitHub API
    - Downloads the Inno Setup installer (.exe)
    - Verifies SHA256 BEFORE execution (security critical)
    - Runs installer silently (/VERYSILENT /SUPPRESSMSGBOXES)
    - Cleans up temp file
    - Fails fast if not Windows or PowerShell too old

    WARNING: This installs an untested alpha release (v3.0.0-alpha.1).
#>

# Fail if not Windows
if ($IsLinux -or $IsMacOS) {
    Write-Error "This installer is for Windows only."
    exit 1
}

# Require PowerShell 5.1+ (Invoke-RestMethod, Expand-Archive)
if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Error "PowerShell 5.1 or later is required. You have $($PSVersionTable.PSVersion)."
    exit 1
}

# Configuration
$repo = "MrEmoji27/nex"
$expectedSha256 = "e0cf3c26a34312e9763df3d0c0d65519888339bdab6958b2ae52942ec31149aa"
$assetName = "Nex-setup-3.0.0-alpha.1.exe"

Write-Host "Resolving latest release from GitHub..." -ForegroundColor Cyan

try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -ErrorAction Stop
}
catch {
    Write-Error "Failed to fetch release info from GitHub API: $_"
    exit 1
}

$asset = $release.assets | Where-Object { $_.name -eq $assetName }
if (-not $asset) {
    Write-Error "Asset '$assetName' not found in latest release."
    exit 1
}

$downloadUrl = $asset.browser_download_url
$tempFile = Join-Path $env:TEMP $assetName

Write-Host "Downloading $assetName..." -ForegroundColor Cyan
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tempFile -ErrorAction Stop
}
catch {
    Write-Error "Download failed: $_"
    exit 1
}

Write-Host "Verifying SHA256..." -ForegroundColor Cyan
$actualSha256 = (Get-FileHash -Path $tempFile -Algorithm SHA256).Hash.ToLower()
if ($actualSha256 -ne $expectedSha256) {
    Write-Error "SHA256 MISMATCH! Expected: $expectedSha256`nActual:   $actualSha256`nAborting - the downloaded file may be corrupted or tampered with."
    Remove-Item -Force $tempFile -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "SHA256 verified. Installing silently..." -ForegroundColor Green

try {
    $process = Start-Process -FilePath $tempFile -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES" -Wait -PassThru -ErrorAction Stop
    if ($process.ExitCode -ne 0) {
        Write-Error "Installer exited with code $($process.ExitCode)."
        exit 1
    }
}
finally {
    Remove-Item -Force $tempFile -ErrorAction SilentlyContinue
}

Write-Host "`nNex installed successfully!" -ForegroundColor Green
Write-Host "Open a NEW terminal and type: nex" -ForegroundColor Cyan
Write-Host "(New terminals pick up the PATH change; already-open ones will not.)" -ForegroundColor Gray
Write-Host "`nNOTE: This is an untested alpha release (v3.0.0-alpha.1)." -ForegroundColor Yellow