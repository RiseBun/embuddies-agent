param(
  [switch]$Baseline,
  [ValidateSet('debug','release')][string]$Profile='debug',
  [string]$ToolRoot='E:\embuddies-build'
)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$manifest=Get-Content (Join-Path $projectRoot 'native-engine\upstream.json') -Raw | ConvertFrom-Json
$sourceRoot=Join-Path $projectRoot $manifest.sourceDirectory
$sourceRevision=& git -C $sourceRoot rev-parse HEAD
if($LASTEXITCODE -ne 0){throw 'Native source checkout missing.'}
& git -C $sourceRoot merge-base --is-ancestor $manifest.baseline HEAD
if($LASTEXITCODE -ne 0){throw 'Native source does not descend from the pinned upstream baseline.'}
$env:CARGO_TARGET_DIR=Join-Path $ToolRoot 'target'
if(Test-Path -LiteralPath (Join-Path $ToolRoot 'cargo\bin\rustup.exe')){
  $env:CARGO_HOME=Join-Path $ToolRoot 'cargo'
  $env:RUSTUP_HOME=Join-Path $ToolRoot 'rustup'
  $env:PATH=(Join-Path $env:CARGO_HOME 'bin')+';'+$env:PATH
}
$cargo=Get-Command cargo.exe -ErrorAction Stop
$version=& rustc --version
if(-not $version.StartsWith('rustc '+$manifest.toolchain+' ')){throw 'Native engine requires the pinned Rust toolchain.'}
$vswhere='C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if(-not(Test-Path -LiteralPath $vswhere)){throw 'MSVC Build Tools are missing.'}
$vsRoot=& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if(-not $vsRoot){throw 'MSVC x64 compiler and Windows SDK are required.'}
$developerShell=Join-Path $vsRoot 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
Import-Module $developerShell
Enter-VsDevShell -VsInstallPath $vsRoot -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'
$binary=if($Baseline){'codex-app-server'}else{'embuddies-runtime'}
$arguments=@('build','--locked','--package','codex-app-server','--bin',$binary)
if($Profile -eq 'release'){$arguments+='--release'}
Push-Location (Join-Path $sourceRoot 'codex-rs')
try{
  & $cargo.Source @arguments
  if($LASTEXITCODE -ne 0){throw 'Native compilation failed; existing binaries and releases remain unchanged.'}
}finally{Pop-Location}
$output=Join-Path $env:CARGO_TARGET_DIR "$Profile\$binary.exe"
if(-not(Test-Path -LiteralPath $output)){throw 'Native compilation did not produce the expected binary.'}
if($Baseline){Write-Output "Baseline compiled: $output"; return}
$stage=Join-Path $projectRoot ('native-engine\candidates\'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item -LiteralPath $output -Destination (Join-Path $stage $manifest.binary)
$changes=& git -C $sourceRoot diff --binary $manifest.baseline
$changes | Set-Content (Join-Path $stage 'upstream.patch') -Encoding utf8
Copy-Item -LiteralPath (Join-Path $sourceRoot 'LICENSE') -Destination $stage
Copy-Item -LiteralPath (Join-Path $projectRoot 'native-engine\NOTICE') -Destination $stage
@{
  product='embuddies';baseline=$manifest.baseline;revision=$sourceRevision;
  rust=$version;profile=$Profile;target=$manifest.target;
  binary=$manifest.binary;sha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash;
  patchSha256=(Get-FileHash (Join-Path $stage 'upstream.patch') -Algorithm SHA256).Hash;
  builtAt=[DateTime]::UtcNow.ToString('o');status='candidate'
} | ConvertTo-Json | Set-Content (Join-Path $stage 'manifest.json') -Encoding utf8
Write-Output "Native candidate built: $stage"
