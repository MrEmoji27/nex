; Nex installer — Inno Setup 6 script
; Builds Nex-setup-<version>.exe: single binary + Start Menu shortcut + PATH.

#define MyAppName "Nex"
#define MyAppVersion "3.0.0-alpha.6"
#define MyAppPublisher "Nex contributors"
#define MyAppExeName "nex.exe"
#define RepoRoot ".."

[Setup]
AppId={{8E1B6C4A-52D7-4B3E-9A64-NEXALPHA00001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Per-user install (VS Code-style): no UAC prompt, no Program Files.
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile={#RepoRoot}\LICENSE
OutputDir={#RepoRoot}\dist
OutputBaseFilename=Nex-setup-{#MyAppVersion}
SetupIconFile={#RepoRoot}\packaging\nex.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
UsedUserAreasWarning=no
Uninstallable=yes
UninstallDisplayIcon={app}\{#MyAppExeName}

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "addpath"; Description: "Add Nex to PATH (lets you run 'nex' from any terminal)"; GroupDescription: "Integration:"; Flags: checkedonce

[Files]
Source: "{#RepoRoot}\dist\nex.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\dist\README-FIRST.txt"; DestDir: "{app}"; Flags: ignoreversion
; The audio sidecar. Voice needs a real sound card and a real Opus codec, which
; the bundled runtime cannot provide, so it lives in its own process beside the
; app. Without this file voice starts and then silently does nothing, which is
; worse than voice being absent — so the build refuses to run if it is missing.
Source: "{#RepoRoot}\audio\target\release\nex-audio.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Nex Chat"; Filename: "{app}\{#MyAppExeName}"; Comment: "Terminal-native p2p chat"
Name: "{group}\Nex Headless Node"; Filename: "{sys}\cmd.exe"; Parameters: "/K ""{app}\nex.exe"" headless"; Comment: "Run a headless Nex node"
Name: "{autodesktop}\Nex Chat"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Dirs]
; Pre-create the user data dir with proper ACLs so first run never fails.
Name: "{userappdata}\Nex"; Permissions: users-full

[Registry]
; Add to the USER Path (no admin rights needed at runtime to take effect for the user).
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Tasks: addpath; Check: NeedsAddPath('{app}')

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Param) + ';', ';' + Uppercase(OrigPath) + ';') = 0;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Msg: string;
begin
  if CurStep = ssPostInstall then
  begin
    MsgBox(
      'Nex is installed.' #13#10 #13#10 +
      'Open a NEW terminal and type:' #13#10 +
      '    nex' #13#10 #13#10 +
      '(New terminals pick up the PATH change; already-open ones will not.)' #13#10 #13#10 +
      'Your identity and messages live in %USERPROFILE%\.nex - encrypted with a key stored on this machine.',
      mbInformation, MB_OK);
  end;
end;

[UninstallDelete]
; Keep user data by default; uncomment to wipe on uninstall:
; Type: filesandordirs; Name: "{userappdata}\Nex"
