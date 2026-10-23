param([switch]$Development, [switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
trap {
    $launchLog = Join-Path $env:LOCALAPPDATA 'embuddies\logs\startup.log'
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($launchLog)) | Out-Null
    [IO.File]::AppendAllText($launchLog, ([DateTime]::Now.ToString('s') + ' ' + $_.Exception.Message + [Environment]::NewLine))
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
$electron = Join-Path $PSScriptRoot 'desktop\node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron)) { throw 'Install the locked desktop dependencies first.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'frontend\dist\index.html'))) { throw 'Build the React frontend before starting.' }
# The native Rust kernel is optional: the default model-agnostic loop does not require it.
# An existing local candidate is used only as a fallback (EMBUDDIES_ENGINE=native).
$native = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'native-engine\candidates') -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json') } |
    Select-Object -First 1
$binary = $null
if ($native) {
    $manifest = Get-Content -LiteralPath (Join-Path $native.FullName 'manifest.json') -Raw | ConvertFrom-Json
    $binary = [IO.Path]::GetFullPath((Join-Path $native.FullName $manifest.binary))
    if (-not $binary.StartsWith($native.FullName + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Native binary must be inside its candidate directory.' }
    if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $manifest.sha256) { throw 'Native candidate integrity mismatch.' }
}
$namespace = if ($Development) { 'embuddies-development' } else { 'embuddies' }
$data = Join-Path $env:LOCALAPPDATA ($namespace + '\data')
$profile = Join-Path $env:LOCALAPPDATA ($namespace + '\profile')
if ($VerifyOnly) {
    [pscustomobject]@{ executable = $electron; native = $binary; data = $data; profile = $profile } | ConvertTo-Json
    return
}
# Use the same data and profile for every normal entry point. Development is explicit.
$env:EMBUDDIES_DATA_DIR = $data
if ($binary) { $env:EMBUDDIES_NATIVE_EXECUTABLE = $binary }
else { Remove-Item -LiteralPath 'Env:EMBUDDIES_NATIVE_EXECUTABLE' -ErrorAction SilentlyContinue }
foreach ($variable in @('ELECTRON_RUN_AS_NODE', 'EMBUDDIES_BUNDLE_ROOT', 'EMBUDDIES_RUNTIME_ROOT', 'EMBUDDIES_UI_ROOT')) {
    Remove-Item -LiteralPath ('Env:' + $variable) -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $profile -Force | Out-Null
Start-Process -FilePath $electron -ArgumentList @(('"' + (Join-Path $PSScriptRoot 'desktop') + '"'), ('"--user-data-dir=' + $profile + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
