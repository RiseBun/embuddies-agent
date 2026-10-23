param([switch]$VerifyOnly)
$ErrorActionPreference='Stop'
$selection=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'native-engine\desktop-candidate.json') -Raw|ConvertFrom-Json
$candidate=[IO.Path]::GetFullPath($selection.path)
$manifest=Get-Content -LiteralPath (Join-Path $candidate 'release-manifest.json') -Raw|ConvertFrom-Json
if($manifest.status -ne 'candidate' -or $manifest.candidateId -ne $selection.candidateId){throw 'Candidate identity mismatch. Original release unchanged.'}
foreach($property in $manifest.files.PSObject.Properties){
  $file=[IO.Path]::GetFullPath((Join-Path $candidate $property.Name))
  if(-not $file.StartsWith($candidate+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Manifest path escaped candidate.'}
  if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw "Candidate file missing: $($property.Name)"}
  if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $property.Value){throw "Candidate integrity mismatch: $($property.Name)"}
}
$exe=Join-Path $candidate 'embuddies.exe'
if(-not(Test-Path -LiteralPath $exe)){throw 'Candidate executable missing.'}
if($VerifyOnly){
  Write-Host "Candidate integrity verified: $candidate"
  return
}
# Trial data and profile are isolated from the user's installed release.
$trialRoot=Join-Path $env:LOCALAPPDATA 'embuddies-candidate'
$env:EMBUDDIES_DATA_DIR=Join-Path $trialRoot 'data'
$profile=Join-Path $trialRoot 'profile'
New-Item -ItemType Directory -Path $profile -Force|Out-Null
foreach($name in @('EMBUDDIES_NATIVE_EXECUTABLE','EMBUDDIES_RUNTIME_ROOT','EMBUDDIES_UI_ROOT','EMBUDDIES_BUNDLE_ROOT','EMBUDDIES_IPC_DEBUG')){
  [Environment]::SetEnvironmentVariable($name,$null,'Process')
}
Start-Process -FilePath $exe -ArgumentList ('"--user-data-dir='+$profile+'"') -WorkingDirectory $candidate -WindowStyle Hidden
