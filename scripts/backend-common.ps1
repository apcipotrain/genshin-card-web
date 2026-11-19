$ErrorActionPreference = 'Stop'
$script:ProjectRoot = Split-Path -Parent $PSScriptRoot

function Initialize-BackendConfiguration {
    $cacheDirectory = Join-Path $script:ProjectRoot '.cache'
    [System.IO.Directory]::CreateDirectory($cacheDirectory) | Out-Null
    if ([string]::IsNullOrWhiteSpace($env:GAME_SERVICE_KEY)) {
        $keyFile = Join-Path $cacheDirectory 'game-service-key'
        if (-not (Test-Path -LiteralPath $keyFile)) {
            $bytes = New-Object byte[] 32
            $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $random.GetBytes($bytes) } finally { $random.Dispose() }
            $key = [System.BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
            try {
                $stream = [System.IO.File]::Open($keyFile, [System.IO.FileMode]::CreateNew)
                try {
                    $encoded = [System.Text.Encoding]::UTF8.GetBytes($key)
                    $stream.Write($encoded, 0, $encoded.Length)
                } finally { $stream.Dispose() }
            } catch [System.IO.IOException] {
                if (-not (Test-Path -LiteralPath $keyFile)) { throw }
            }
        }
        $env:GAME_SERVICE_KEY = [System.IO.File]::ReadAllText($keyFile).Trim()
        if ($env:GAME_SERVICE_KEY.Length -lt 32) { throw 'Local service key is invalid. Set GAME_SERVICE_KEY to a random value of at least 32 characters.' }
    }
    if (-not $env:ACCOUNT_API_URL) { $env:ACCOUNT_API_URL = 'http://127.0.0.1:8080' }
    if (-not $env:LEGACY_ACCOUNTS_FILE) { $env:LEGACY_ACCOUNTS_FILE = Join-Path $script:ProjectRoot 'server/accounts.json' }
}

function Initialize-JavaTools {
    if ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin/java.exe'))) {
        $env:Path = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:Path
    }
    $javaCommand = Get-Command java -ErrorAction SilentlyContinue
    if (-not $javaCommand) { throw 'Java was not found. Install JDK 21 and configure JAVA_HOME or PATH.' }
    $script:JavaExecutable = $javaCommand.Source
    if (-not $env:JAVA_HOME) { $env:JAVA_HOME = Split-Path -Parent (Split-Path -Parent $script:JavaExecutable) }
    if ($env:MAVEN_HOME -and (Test-Path -LiteralPath (Join-Path $env:MAVEN_HOME 'bin/mvn.cmd'))) {
        $env:Path = (Join-Path $env:MAVEN_HOME 'bin') + ';' + $env:Path
    }
    $mavenCommand = Get-Command mvn -ErrorAction SilentlyContinue
    if (-not $mavenCommand) { throw 'Maven was not found. Configure MAVEN_HOME or put Maven bin on PATH.' }
    $script:MavenExecutable = $mavenCommand.Source
}

function Assert-DevelopmentPortsAvailable {
    param([int[]]$Ports)
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    $busy = @($Ports | Sort-Object -Unique | Where-Object { $_ -in $listeners.Port })
    if ($busy.Count -gt 0) {
        throw "Development port(s) already in use: $($busy -join ', '). If the game is already running, open its existing page. To restart it, press Ctrl+C in its original terminal and run the startup command again."
    }
}

function New-BackendRuntimeJar {
    # Run from a separate file so Windows can rebuild the Maven artifact while Java is running.
    $buildJar = Join-Path $script:ProjectRoot 'java-backend/target/genshin-card-backend.jar'
    $runtimeDirectory = Join-Path $script:ProjectRoot '.cache/backend-runtime'
    [System.IO.Directory]::CreateDirectory($runtimeDirectory) | Out-Null
    $runtimeJar = Join-Path $runtimeDirectory "$([guid]::NewGuid().ToString('N')).jar"
    Copy-Item -LiteralPath $buildJar -Destination $runtimeJar
    return $runtimeJar
}
