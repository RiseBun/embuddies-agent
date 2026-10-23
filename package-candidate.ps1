param([Parameter(Mandatory=$true)][string]$CandidateRoot,[switch]$SkipArchive)
$ErrorActionPreference='Stop'
$candidate=[IO.Path]::GetFullPath($CandidateRoot)
$manifest=Get-Content -LiteralPath (Join-Path $candidate 'release-manifest.json') -Raw|ConvertFrom-Json
if($manifest.status -ne 'candidate'){throw 'Only an immutable candidate may be packaged.'}
foreach($property in $manifest.files.PSObject.Properties){
  $file=[IO.Path]::GetFullPath((Join-Path $candidate $property.Name))
  if(-not $file.StartsWith($candidate+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Manifest path escaped candidate.'}
  if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $property.Value){throw "Candidate changed: $($property.Name)"}
}
$output=[IO.Directory]::GetParent($candidate).FullName
$archive=Join-Path $output "embuddies-Windows-$($manifest.version)-candidate.zip"
if(-not $SkipArchive){
  if(Test-Path -LiteralPath $archive){throw 'Candidate archive already exists; it will not be replaced.'}
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($candidate,$archive)
}
$iscc=Get-Command ISCC.exe -ErrorAction SilentlyContinue
if(-not $iscc){$iscc=@{Source=(Join-Path $PSScriptRoot '.tmp\tools\inno\ISCC.exe')}}
if(-not(Test-Path -LiteralPath $iscc.Source)){throw 'Inno Setup is required for the candidate installer.'}
$compilerAcl=& icacls.exe $iscc.Source
if(($compilerAcl -join "`n") -match 'S-1-16-4096|Low Mandatory'){
  # A low-integrity compiler cannot write a normal-integrity output directory.
  # Copy the trusted tool into an isolated normal build directory, preserving
  # its content hash rather than changing workspace ACLs or disabling isolation.
  $compilerRoot=Join-Path $output ('installer-tools-'+[Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $compilerRoot|Out-Null
  Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($iscc.Source))|Copy-Item -Destination $compilerRoot -Recurse
  $compiler=Join-Path $compilerRoot 'ISCC.exe'
  if((Get-FileHash $compiler).Hash -ne (Get-FileHash $iscc.Source).Hash){throw 'Installer compiler copy mismatch.'}
  $iscc=@{Source=$compiler}
}
# Isolate the candidate's installer identity from the user's installed release.
$appId="embuddies-candidate-$($manifest.candidateId)"
& $iscc.Source "/DMyAppVersion=$($manifest.version)" "/DMyAppId=$appId" '/DMyAppInstallName=embuddies-candidate' "/DStageRoot=$candidate" "/O$output" (Join-Path $PSScriptRoot 'installer\embuddies.iss')
if($LASTEXITCODE -ne 0){throw 'Candidate installer failed; the previous release is unchanged.'}
Write-Host "Candidate archive and installer: $output"
