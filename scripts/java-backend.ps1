param(
    [ValidateSet('run', 'test', 'package')]
    [string]$Task = 'run',
    [switch]$SkipTests
)

. (Join-Path $PSScriptRoot 'backend-common.ps1')
Initialize-BackendConfiguration
Initialize-JavaTools

$moduleDirectory = Join-Path $script:ProjectRoot 'java-backend'
$repositoryDirectory = Join-Path $script:ProjectRoot '.cache/maven'
$mavenArguments = @('-B', '-ntp', "-Dmaven.repo.local=$repositoryDirectory")
if ($Task -eq 'test') {
    $mavenArguments += 'test'
} else {
    $mavenArguments += 'package'
    if ($SkipTests -or $Task -eq 'run') { $mavenArguments += '-DskipTests' }
}

if ($Task -eq 'run') {
    $accountPort = if ($env:JAVA_BACKEND_PORT) { [int]$env:JAVA_BACKEND_PORT } else { 8080 }
    Assert-DevelopmentPortsAvailable -Ports @($accountPort)
}

Push-Location $moduleDirectory
try {
    & $script:MavenExecutable @mavenArguments
    if ($LASTEXITCODE -ne 0) { throw "Java backend build failed (exit $LASTEXITCODE)." }
    if ($Task -eq 'run') {
        $runtimeJar = New-BackendRuntimeJar
        try {
            & $script:JavaExecutable '-jar' $runtimeJar
            if ($LASTEXITCODE -ne 0) { throw "Java backend stopped (exit $LASTEXITCODE)." }
        } finally {
            Remove-Item -LiteralPath $runtimeJar -ErrorAction SilentlyContinue
        }
    }
} finally { Pop-Location }
