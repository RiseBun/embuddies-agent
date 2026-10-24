param([switch]$SkipDesktop)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$icon = Join-Path $root 'shell\resources\icons\appIcon.ico'
$entry = Join-Path $root 'start-embuddies.vbs'
if (-not (Test-Path -LiteralPath $icon) -or -not (Test-Path -LiteralPath $entry)) { throw 'Launcher or logo is missing.' }
$scriptHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcutShell = New-Object -ComObject WScript.Shell
function Set-EmbuddiesShortcut([string]$Path, [string]$Mode = '') {
    $shortcut = $shortcutShell.CreateShortcut($Path)
    $shortcut.TargetPath = $scriptHost
    $shortcut.Arguments = '"' + $entry + '"' + $Mode
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = $icon + ',0'
    $shortcut.Description = 'embuddies'
    $shortcut.WindowStyle = 1
    $shortcut.Save()
    Write-Output $Path
}
Set-EmbuddiesShortcut (Join-Path $root 'embuddies.lnk')
$candidateName = 'embuddies ' + [char]0x5019 + [char]0x9009 + [char]0x7248 + '.lnk'
Set-EmbuddiesShortcut (Join-Path $root $candidateName) ' /candidate'
if (-not $SkipDesktop) {
    Set-EmbuddiesShortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'embuddies.lnk')
}
# Ask Explorer to refresh icons; do not restart Explorer or delete the user's cache.
if (-not ('EmbuddiesShortcutRefresh' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EmbuddiesShortcutRefresh {
    [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint events, uint flags, IntPtr item1, IntPtr item2);
}
'@
}
[EmbuddiesShortcutRefresh]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
