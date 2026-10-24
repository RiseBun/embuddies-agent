param([switch]$SkipArchive,[switch]$SkipInstaller,[string]$BuildRoot='E:\embuddies-build\desktop',[string]$NativeCandidate)
$ErrorActionPreference='Stop'
# JSON files must be UTF-8 without BOM: Node's JSON.parse rejects a leading BOM.
function Write-JsonNoBom([string]$Path, $Value, [int]$Depth = 10) {
  $json = $Value | ConvertTo-Json -Depth $Depth
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}
$projectRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$buildRoot=[IO.Path]::GetFullPath($BuildRoot)
# The native Rust kernel is optional. Omit -NativeCandidate to build a model-agnostic bundle.
$nativeRoot=$null
$nativeManifest=$null
if($NativeCandidate){
  $nativeRoot=[IO.Path]::GetFullPath($NativeCandidate)
  $nativeManifest=Get-Content -LiteralPath (Join-Path $nativeRoot 'manifest.json') -Raw|ConvertFrom-Json
  if($nativeManifest.product -ne 'embuddies' -or (Get-FileHash -LiteralPath (Join-Path $nativeRoot $nativeManifest.binary) -Algorithm SHA256).Hash -ne $nativeManifest.sha256){throw 'Native candidate validation failed.'}
}
$nodeExecutable=(Get-Command node -ErrorAction Stop).Source
$npmCommand=Get-Command npm.cmd -ErrorAction SilentlyContinue
$npmScript=Join-Path $projectRoot '.tmp\npm-tool\package\bin\npm-cli.js'
if(-not $npmCommand -and -not(Test-Path -LiteralPath $npmScript)){throw 'npm build tool missing; previous release unchanged.'}
$electronRoot=Join-Path $projectRoot 'desktop\node_modules\electron\dist'
if(-not(Test-Path -LiteralPath (Join-Path $electronRoot 'electron.exe'))){throw 'Install locked desktop dependencies before building; previous release unchanged.'}
$electronVersion=(Get-Content (Join-Path $projectRoot 'desktop\node_modules\electron\package.json') -Raw|ConvertFrom-Json).version
if((Get-Content (Join-Path $electronRoot 'version') -Raw).Trim() -ne $electronVersion){throw 'Electron package/binary mismatch.'}
$version=(Get-Content (Join-Path $projectRoot 'desktop\package.json') -Raw|ConvertFrom-Json).version
$iscc=Get-Command iscc.exe -ErrorAction SilentlyContinue
if(-not $iscc -and (Test-Path -LiteralPath (Join-Path $projectRoot '.tmp\tools\inno\ISCC.exe'))){$iscc=@{Source=(Join-Path $projectRoot '.tmp\tools\inno\ISCC.exe')}}
if(-not $SkipInstaller -and -not $iscc){throw 'Inno Setup missing. Use -SkipInstaller for candidate testing only.'}
$candidateId=[Guid]::NewGuid().ToString('N')
Push-Location (Join-Path $projectRoot 'frontend')
try{
  if($npmCommand){& $npmCommand.Source run build}
  else{& $nodeExecutable $npmScript run build}
  if($LASTEXITCODE -ne 0){throw 'Frontend build failed; previous release unchanged.'}
}finally{Pop-Location}
$candidateRoot=Join-Path $buildRoot "candidates\$version-$candidateId"
$stage=Join-Path $candidateRoot 'windows'
New-Item -ItemType Directory -Path $stage -Force|Out-Null
Get-ChildItem -LiteralPath $electronRoot|Copy-Item -Destination $stage -Recurse -Force
Rename-Item -LiteralPath (Join-Path $stage 'electron.exe') -NewName 'embuddies.exe'
if (-not ('EmbuddiesIconResources' -as [type])) { Add-Type -Path (Join-Path $projectRoot 'launcher\IconResources.cs') }
[EmbuddiesIconResources]::SetIcon((Join-Path $stage 'embuddies.exe'), (Join-Path $projectRoot 'shell\resources\icons\appIcon.ico'))
function Assert-ExecutableIntegrity([string]$file){
  $acl=& icacls.exe $file
  if($LASTEXITCODE -ne 0){throw 'Unable to inspect executable integrity label.'}
  if(($acl -join "`n") -match 'S-1-16-4096|Low Mandatory') {throw 'Executable carries a low integrity label; build from a normal Windows account.'}
}
Assert-ExecutableIntegrity (Join-Path $stage 'embuddies.exe')
$appRoot=Join-Path $stage 'resources\app'
New-Item -ItemType Directory -Path $appRoot -Force|Out-Null
Write-JsonNoBom (Join-Path $appRoot 'package.json') @{name='embuddies';version=$version;main='desktop/main.cjs'}
Write-JsonNoBom (Join-Path $appRoot 'distribution.json') @{channel='candidate';candidateId=$candidateId}
foreach($directory in @('desktop')){
  $target=Join-Path $appRoot $directory
  New-Item -ItemType Directory -Path $target -Force|Out-Null
  Get-ChildItem -LiteralPath (Join-Path $projectRoot $directory) -File|Where-Object {$_.Extension -in @('.mjs','.cjs') -or $_.Name -in @('package.json','package-lock.json')}|Copy-Item -Destination $target
}
$stageRuntime=Join-Path $appRoot 'runtime'
& $nodeExecutable (Join-Path $projectRoot 'runtime\scripts\stage-native-runtime.mjs') $stageRuntime
if($LASTEXITCODE -ne 0){throw 'Production module staging failed.'}
New-Item -ItemType Directory -Path (Join-Path $appRoot 'frontend') -Force|Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'frontend\dist') -Destination (Join-Path $appRoot 'frontend') -Recurse
if($nativeRoot){
  Copy-Item -LiteralPath $nativeRoot -Destination (Join-Path $appRoot 'native-engine') -Recurse
  $nativeManifest.binary='embuddies-runtime.exe'
  Write-JsonNoBom (Join-Path $appRoot 'native-engine\active.json') $nativeManifest 8
}
New-Item -ItemType Directory -Path (Join-Path $appRoot 'shell') -Force|Out-Null
New-Item -ItemType Directory -Path (Join-Path $appRoot 'shell\resources') -Force|Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'shell\resources\icons') -Destination (Join-Path $appRoot 'shell\resources') -Recurse
# 受限执行器：编译并随包分发，运行命令时使用 Windows Job Object。
$sandboxSource=Join-Path $projectRoot 'launcher\SandboxRunner.cs'
$sandboxExe=Join-Path $projectRoot 'launcher\sandbox-run.exe'
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if((Test-Path $csc) -and (Test-Path $sandboxSource)){
  & $csc /nologo '/target:exe' "/out:$sandboxExe" $sandboxSource
  if($LASTEXITCODE -ne 0){throw 'Sandbox runner build failed.'}
}
if(Test-Path $sandboxExe){
  New-Item -ItemType Directory -Path (Join-Path $appRoot 'bin') -Force|Out-Null
  Copy-Item -LiteralPath $sandboxExe -Destination (Join-Path $appRoot 'bin\sandbox-run.exe') -Force
}
Push-Location $stageRuntime
try{
  if($npmCommand){& $npmCommand.Source ci --omit=dev --ignore-scripts --no-audit --no-fund}
  else{& $nodeExecutable $npmScript ci --omit=dev --ignore-scripts --no-audit --no-fund}
  if($LASTEXITCODE -ne 0){throw 'Dependency staging failed; previous release unchanged.'}
}finally{Pop-Location}
$sourceHashes=@{}
Get-ChildItem -LiteralPath $stage -File -Recurse|ForEach-Object{
  $relative=$_.FullName.Substring($stage.Length+1).Replace('\','/')
  $sourceHashes[$relative]=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
}
Write-JsonNoBom (Join-Path $stage 'release-manifest.json') @{version=$version;electron=$electronVersion;candidateId=$candidateId;files=$sourceHashes;status='candidate'} 5
if(-not $SkipArchive){
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($stage,(Join-Path $candidateRoot "embuddies-Windows-$version.zip"))
}
if(-not $SkipInstaller){
  & (Join-Path $projectRoot 'package-candidate.ps1') -CandidateRoot $stage -SkipArchive
  Get-ChildItem -LiteralPath $candidateRoot -Filter '*.exe' -File | ForEach-Object {Assert-ExecutableIntegrity $_.FullName}
}
Write-Host "Candidate built: $stage"
Write-Host 'Previous release unchanged. Publish only with a complete acceptance report.'
