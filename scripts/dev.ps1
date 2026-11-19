. (Join-Path $PSScriptRoot 'backend-common.ps1')
Initialize-BackendConfiguration
Initialize-JavaTools

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js was not found. Install Node.js 18 or later.' }
if (-not (Test-Path -LiteralPath (Join-Path $script:ProjectRoot 'node_modules/concurrently/package.json'))) {
    throw 'Dependencies are missing. Run npm install first.'
}
$accountPort = if ($env:JAVA_BACKEND_PORT) { [int]$env:JAVA_BACKEND_PORT } else { 8080 }
$gamePort = if ($env:PORT) { [int]$env:PORT } else { 3457 }
Assert-DevelopmentPortsAvailable -Ports @(3000, $gamePort, $accountPort)

Write-Host 'Building Java backend (the first build downloads Maven dependencies)...'
& (Join-Path $PSScriptRoot 'java-backend.ps1') -Task package -SkipTests
$runtimeJar = New-BackendRuntimeJar
$env:BACKEND_JAVA_EXECUTABLE = $script:JavaExecutable
Push-Location $script:ProjectRoot
try {
    Write-Host "Starting account API on port $accountPort, game server on port $gamePort, and web server on port 3000. Press Ctrl+C to stop all."
    & $nodeCommand.Source 'scripts/dev.mjs' ([System.IO.Path]::GetFileName($runtimeJar))
    if ($LASTEXITCODE -ne 0) { throw "A development service stopped (exit $LASTEXITCODE)." }
} finally {
    Pop-Location
    Remove-Item -LiteralPath $runtimeJar -ErrorAction SilentlyContinue
}
