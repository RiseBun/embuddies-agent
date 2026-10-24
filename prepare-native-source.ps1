param([string]$ReferenceDirectory)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$manifest=Get-Content -LiteralPath (Join-Path $projectRoot 'native-engine\upstream.json') -Raw|ConvertFrom-Json
$target=Join-Path $projectRoot $manifest.sourceDirectory
if(Test-Path -LiteralPath $target){throw 'Source directory already exists. Existing work is never reset by this script.'}
$source=if($ReferenceDirectory){[IO.Path]::GetFullPath($ReferenceDirectory)}else{$manifest.upstream}
& git clone --filter=blob:none --no-checkout $source $target
if($LASTEXITCODE -ne 0){throw 'Unable to clone the upstream source.'}
& git -C $target fetch origin $manifest.baseline --depth=1
if($LASTEXITCODE -ne 0){throw 'Unable to retrieve the pinned baseline.'}
# Keep the worktree byte-identical to the index so `git apply --index` also works
# on Windows runners whose global Git configuration enables CRLF conversion.
& git -C $target config core.autocrlf false
if($LASTEXITCODE -ne 0){throw 'Unable to configure the product source checkout.'}
# The pinned upstream contains paths that exceed the legacy Windows path limit.
& git -C $target config core.longpaths true
if($LASTEXITCODE -ne 0){throw 'Unable to enable long-path support for the product source checkout.'}
& git -C $target checkout -b $manifest.branch $manifest.baseline
if($LASTEXITCODE -ne 0){throw 'Unable to create the product source branch.'}
$patch=Join-Path $projectRoot 'native-engine\patches\embuddies.patch'
& git -C $target apply --check $patch
if($LASTEXITCODE -ne 0){throw 'Product patch does not apply to the pinned baseline.'}
& git -C $target apply --index $patch
if($LASTEXITCODE -ne 0){throw 'Unable to apply the product patch.'}
Write-Host "Prepared pinned embuddies source: $target"
