#define MyAppName "embuddies"
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#define MyAppPublisher "embuddies"
#define MyAppExeName "embuddies.exe"
#ifndef MyAppId
  #define MyAppId "{{3DF1AF71-AD0B-4F5E-9162-59B25EB82FA6}"
#endif
#ifndef MyAppInstallName
  #define MyAppInstallName "embuddies"
#endif
#ifndef StageRoot
  #define StageRoot "..\build\windows"
#endif

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppInstallName}
DefaultGroupName={#MyAppInstallName}
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\build
OutputBaseFilename=embuddies-Windows-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\resources\app\shell\resources\icons\appIcon.ico
SetupIconFile={#StageRoot}\resources\app\shell\resources\icons\appIcon.ico
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#StageRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\embuddies"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\resources\app\shell\resources\icons\appIcon.ico"; AppUserModelID: "com.embuddies.app"
Name: "{autodesktop}\embuddies"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\resources\app\shell\resources\icons\appIcon.ico"; AppUserModelID: "com.embuddies.app"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,embuddies}"; Flags: nowait postinstall skipifsilent
