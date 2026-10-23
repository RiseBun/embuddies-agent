param([Parameter(Mandatory=$true)][string]$CandidateRoot,[Parameter(Mandatory=$true)][string]$AcceptanceReport)
$ErrorActionPreference='Stop'
$allowed=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'build\candidates'))+[IO.Path]::DirectorySeparatorChar
$candidate=[IO.Path]::GetFullPath($CandidateRoot)
if(-not $candidate.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Candidate must be under build/candidates.'}
$manifest=Get-Content -LiteralPath (Join-Path $candidate 'release-manifest.json') -Raw|ConvertFrom-Json
$report=Get-Content -LiteralPath $AcceptanceReport -Raw|ConvertFrom-Json
if($report.ok -ne $true -or $report.candidateId -ne $manifest.candidateId -or -not $report.cleanWindows10 -or -not $report.cleanWindows11 -or $report.coldStarts -lt 30 -or $report.statusQueries -lt 100 -or $report.runtimeRecoveries -lt 10 -or $report.soakMs -lt 7200000 -or $report.failures -ne 0){throw 'Release acceptance gates have not passed.'}
foreach($property in $manifest.files.PSObject.Properties){$file=Join-Path $candidate $property.Name;if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $property.Value){throw "Candidate changed after testing: $($property.Name)"}}
$active=Join-Path $PSScriptRoot 'build\windows'
$backup=Join-Path $PSScriptRoot ('build\previous-'+[Guid]::NewGuid().ToString('N'))
if(Test-Path -LiteralPath $active){Move-Item -LiteralPath $active -Destination $backup}
try{Move-Item -LiteralPath $candidate -Destination $active}catch{if(Test-Path -LiteralPath $backup){Move-Item -LiteralPath $backup -Destination $active};throw}
Write-Host "Release published: $active"
