param(
    [Parameter(Mandatory)][ValidateSet('configure', 'prepare', 'workload')][string]$Mode,
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][ValidateSet('baseline', 'split')][string]$Variant,
    [Parameter(Mandatory)][ValidateSet('seed', 'warm', 'upgrade')][string]$Phase,
    [int]$Sample = 0,
    [string]$CacheHit = ''
)

$ErrorActionPreference = 'Stop'
$root = $env:GITHUB_WORKSPACE
$projectInfo = @(Get-Content -Raw (Join-Path $root 'projects.json') | ConvertFrom-Json) | Where-Object slug -eq $Project
if (-not $projectInfo) { throw "Unknown project $Project" }
$resultsDirectory = Join-Path $root 'results'
[System.IO.Directory]::CreateDirectory($resultsDirectory) | Out-Null

if ($Mode -eq 'configure') {
    $cacheRoot = Join-Path $env:RUNNER_TEMP "measured-go-cache/$Project"
    @(
        "GOMODCACHE=$(Join-Path $cacheRoot 'modules')"
        "GOCACHE=$(Join-Path $cacheRoot 'build')"
        'GOTOOLCHAIN=local'
        'CGO_ENABLED=0'
    ) | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
    return
}

$marker = Join-Path $resultsDirectory "start-$Sample.json"
if ($Mode -eq 'prepare') {
    foreach ($directory in @($env:GOMODCACHE, $env:GOCACHE)) {
        if (-not $directory.StartsWith($env:RUNNER_TEMP, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clear non-scratch cache $directory"
        }
        if (Test-Path $directory) {
            Remove-Item -LiteralPath $directory -Recurse -Force
        }
    }
    @{startedUtc = [DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -Path $marker -Encoding utf8
    return
}

$start = (Get-Content -Raw $marker | ConvertFrom-Json).startedUtc
$restoreFinished = [DateTime]::UtcNow
Push-Location (Join-Path $root "projects/$Project")
try {
    $version = (& go version) -join ' '
    if ($LASTEXITCODE -ne 0) { throw 'Reading Go version failed' }
    $downloadStart = [DateTime]::UtcNow
    & go mod download
    if ($LASTEXITCODE -ne 0) { throw 'Module download failed' }
    $downloadEnd = [DateTime]::UtcNow
    $testStart = [DateTime]::UtcNow
    $packages = @($projectInfo.packages)
    & go test '-short' '-count=1' '-timeout=10m' @packages
    if ($LASTEXITCODE -ne 0) { throw 'Unit workload failed' }
    $testEnd = [DateTime]::UtcNow
    $moduleGraph = (& go list -m -json all) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Module graph lookup failed' }
} finally {
    Pop-Location
}

$inventory = @{}
foreach ($kind in @('modules', 'build')) {
    $directory = if ($kind -eq 'modules') { $env:GOMODCACHE } else { $env:GOCACHE }
    $files = @(Get-ChildItem -LiteralPath $directory -Recurse -File)
    $inventory[$kind] = @{files = $files.Count; bytes = ($files | Measure-Object -Property Length -Sum).Sum}
}
$result = @{
    project = $Project
    variant = $Variant
    phase = $Phase
    sample = $Sample
    source = $projectInfo
    version = $version
    cacheHit = $CacheHit
    restoreSeconds = ($restoreFinished - [DateTime]::Parse($start).ToUniversalTime()).TotalSeconds
    downloadSeconds = ($downloadEnd - $downloadStart).TotalSeconds
    testSeconds = ($testEnd - $testStart).TotalSeconds
    beforePostSeconds = ($testEnd - [DateTime]::Parse($start).ToUniversalTime()).TotalSeconds
    inventory = $inventory
    runnerOS = $env:RUNNER_OS
    runnerArch = $env:RUNNER_ARCH
    imageVersion = $env:ImageVersion
    cpus = [Environment]::ProcessorCount
    runId = $env:GITHUB_RUN_ID
    job = $env:GITHUB_JOB
}
if ($Phase -eq 'warm' -and $CacheHit -ne 'true') {
    throw "Warm sample did not have an exact full hit: $Project / $Variant / $Sample"
}
$result | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $resultsDirectory "sample-$Sample.json") -Encoding utf8
$moduleGraph | Set-Content -Path (Join-Path $resultsDirectory "module-graph-$Sample.json") -Encoding utf8
Write-Output ($result | ConvertTo-Json -Depth 8 -Compress)
