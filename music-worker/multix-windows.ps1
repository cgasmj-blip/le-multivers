param(
    [ValidateSet('Start', 'Stop', 'Status')]
    [string]$Action = 'Start'
)

$ErrorActionPreference = 'Stop'
$runtime = Join-Path $env:LOCALAPPDATA 'MultixMusic'
$statePath = Join-Path $runtime 'processes.json'
$null = New-Item -ItemType Directory -Path $runtime -Force
$lock = [IO.File]::Open((Join-Path $runtime 'launcher.lock'), 'OpenOrCreate', 'ReadWrite', 'None')

function Find-TrackedProcess($Record) {
    if ($null -eq $Record) { return }
    $process = Get-Process -Id $Record.id -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $Record.started) {
        return $process
    }
}

function Get-ProcessRecord($Process) {
    return @{
        id = $Process.Id
        started = $Process.StartTime.ToUniversalTime().Ticks.ToString()
    }
}

function Stop-TrackedProcess($Process) {
    if ($Process -and -not $Process.HasExited) {
        Stop-Process -InputObject $Process -Force -ErrorAction SilentlyContinue
        $null = $Process.WaitForExit(5000)
    }
}

try {
    $state = if (Test-Path $statePath) { Get-Content $statePath -Raw | ConvertFrom-Json }
    $bot = Find-TrackedProcess $state.bot
    $tunnel = Find-TrackedProcess $state.tunnel

    if ($Action -eq 'Stop') {
        Stop-TrackedProcess $tunnel
        Stop-TrackedProcess $bot
        if (Test-Path $statePath) { Remove-Item $statePath }
        Write-Host 'Service musique et tunnel arretes.'
        return
    }

    if ($bot -and $tunnel -and $state.url) {
        Write-Host 'Multix musique tourne en arriere-plan.'
        Write-Host "MULTIX_MUSIC_URL = $($state.url)"
        return
    }

    if ($Action -eq 'Status') {
        Write-Host "Bot actif : $([bool]$bot). Tunnel actif : $([bool]$tunnel)."
        Write-Host "Journaux : $runtime"
        return
    }

    if ($bot -or $tunnel) {
        throw 'Un seul processus est encore actif. Lance le script avec -Action Stop avant de redemarrer.'
    }
    if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) {
        throw 'Le port 8080 est deja utilise. Arrete le service musique dans son ancienne fenetre PowerShell.'
    }

    $entry = Join-Path $PSScriptRoot 'index.js'
    if (-not (Test-Path $entry) -or -not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
        throw 'Place le script dans music-worker et lance npm.cmd ci dans ce dossier.'
    }
    $node = (Get-Command node.exe -CommandType Application).Source
    $cloudflared = (Get-Command cloudflared.exe -CommandType Application).Source
    $botLog = Join-Path $runtime 'music.log'
    $botErrors = Join-Path $runtime 'music-errors.log'
    $tunnelLog = Join-Path $runtime 'tunnel.log'
    $tunnelErrors = Join-Path $runtime 'tunnel-errors.log'
    $env:DISCORD_GUILD_ID = '1187492291892486195'
    $env:DISCORD_PUBLIC_KEY = '26039708a0813f047fc1408285ae278c19ea16921d3870e4b869e9d6ba897406'
    $env:PORT = '8080'
    if (-not $env:DISCORD_BOT_TOKEN) {
        $env:DISCORD_BOT_TOKEN = [System.Net.NetworkCredential]::new('', (Read-Host 'Token de Multix' -AsSecureString)).Password
    }

    try {
        try {
            $bot = Start-Process -FilePath $node -ArgumentList 'index.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $botLog -RedirectStandardError $botErrors -PassThru
        } finally {
            Remove-Item Env:DISCORD_BOT_TOKEN -ErrorAction SilentlyContinue
        }

        $ready = $false
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline -and -not $bot.HasExited) {
            try {
                $ready = (Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 2).ready -eq $true
                if ($ready) { break }
            } catch {}
            Start-Sleep -Milliseconds 400
        }
        if (-not $ready) { throw "Multix n'a pas demarre. Consulte $botErrors." }

        $tunnel = Start-Process -FilePath $cloudflared -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:8080' -WindowStyle Hidden -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelErrors -PassThru
        $endpoint = $null
        $deadline = (Get-Date).AddSeconds(45)
        while ((Get-Date) -lt $deadline -and -not $tunnel.HasExited) {
            $lines = (Get-Content $tunnelErrors, $tunnelLog -Raw -ErrorAction SilentlyContinue) -join "`n"
            $match = [regex]::Match($lines, 'https://[a-z0-9-]+\.trycloudflare\.com')
            if ($match.Success -and $lines -match 'Registered tunnel connection') {
                $endpoint = $match.Value + '/discord'
                break
            }
            Start-Sleep -Milliseconds 400
        }
        if (-not $endpoint) { throw "Le tunnel n'a pas demarre. Consulte $tunnelErrors." }

        @{
            bot = Get-ProcessRecord $bot
            tunnel = Get-ProcessRecord $tunnel
            url = $endpoint
        } | ConvertTo-Json | Set-Content -Path $statePath -Encoding UTF8

        Write-Host 'Multix musique et le tunnel tournent en arriere-plan.'
        Write-Host "MULTIX_MUSIC_URL = $endpoint"
        Write-Host 'Copie cette adresse dans Supabase, puis ferme cette fenetre.'
    } catch {
        Stop-TrackedProcess $tunnel
        Stop-TrackedProcess $bot
        throw
    }
} finally {
    $lock.Dispose()
}
