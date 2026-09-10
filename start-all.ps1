<# 
.SYNOPSIS
    Starts the full AI Usage Dashboard stack locally.
    - Collector: runs once (dry-run) to verify config, then exits
    - Server: Hono + SQLite on :8787
    - Web: Next.js on :3000

.DESCRIPTION
    This script launches all three components in separate PowerShell jobs.
    Press Ctrl+C to stop all components.

.REQUIRES
    - Bun (for collector)
    - Node.js + npm (for server + web)
    - Turso database (or local file fallback)

.EXAMPLE
    .\start-all.ps1

.EXAMPLE
    .\start-all.ps1 -NoCollector -NoWeb
#>

param(
    [switch] $NoCollector,
    [switch] $NoServer,
    [switch] $NoWeb,
    [string] $ServerPort = "8787",
    [string] $WebPort = "3000",
    [string] $CollectorDays = "30"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$collectorDir = Join-Path $repoRoot "collector"
$serverDir = Join-Path $repoRoot "server"
$webDir = Join-Path $repoRoot "web"

function Write-Status($msg) { Write-Host "[start-all] $msg" -ForegroundColor Cyan }
function Write-ErrorMsg($msg) { Write-Host "[start-all] ERROR: $msg" -ForegroundColor Red }
function Write-Warn($msg) { Write-Host "[start-all] WARN: $msg" -ForegroundColor Yellow }

# Check prerequisites
Write-Status "Checking prerequisites..."
$checks = @(
    @{ Cmd = "bun --version"; Name = "Bun" },
    @{ Cmd = "node --version"; Name = "Node.js" },
    @{ Cmd = "npm --version"; Name = "npm" }
)
foreach ($c in $checks) {
    try { & $c.Cmd | Out-Null; Write-Host "  ✓ $($c.Name)" }
    catch { Write-ErrorMsg "Missing $($c.Name) - install it first"; exit 1 }
}

# Verify .env files exist
$envFiles = @(
    @{ Path = Join-Path $collectorDir ".env"; Label = "collector/.env" },
    @{ Path = Join-Path $serverDir ".env"; Label = "server/.env" },
    @{ Path = Join-Path $webDir ".env.local"; Label = "web/.env.local" }
)
foreach ($ef in $envFiles) {
    if (-not (Test-Path $ef.Path)) {
        Write-Warn "$($ef.Label) not found - copy from .env.example"
    }
}

# Global cleanup on exit
$jobs = @()
function Stop-All {
    Write-Status "Stopping all components..."
    foreach ($job in $jobs) {
        try { Stop-Job $job -Force | Out-Null } catch { }
    }
    # Kill any remaining child processes on our ports
    foreach ($port in $ServerPort, $WebPort) {
        $pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
        foreach ($pid in $pids) { try { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue } catch { } }
    }
}
# Register cleanup
$global:cleanupRegistered = $true
Register-EngineEvent -SourceIdentifier "PowerShell.Exiting" -Action { Stop-All } | Out-Null

# --- Collector (one-shot) ---
if (-not $NoCollector) {
    Write-Status "Running collector dry-run (--days $CollectorDays)..."
    $collectorJob = Start-Job -ScriptBlock {
        param($dir, $days)
        Set-Location $dir
        $env:PATH = $env:PATH + ";C:\Users\$env:USERNAME\.bun\bin"
        bun run index.ts -- --days $days --dry-run
    } -ArgumentList $collectorDir, $CollectorDays
    $jobs += $collectorJob
    Wait-Job $collectorJob | Out-Null
    $out = Receive-Job $collectorJob
    Write-Host $out
    if ($collectorJob.State -ne "Completed") {
        Write-ErrorMsg "Collector dry-run failed"
        exit 1
    }
    Write-Status "Collector dry-run OK"
}

# --- Server ---
if (-not $NoServer) {
    Write-Status "Starting server on :$ServerPort..."
    $serverJob = Start-Job -ScriptBlock {
        param($dir, $port)
        Set-Location $dir
        $env:PORT = $port
        npm run dev
    } -ArgumentList $serverDir, $ServerPort
    $jobs += $serverJob
    Write-Status "Server job started (PID: $($serverJob.Id))"
}

# --- Web ---
if (-not $NoWeb) {
    Write-Status "Starting web on :$WebPort..."
    $webJob = Start-Job -ScriptBlock {
        param($dir, $port)
        Set-Location $dir
        npx next dev --port $port
    } -ArgumentList $webDir, $WebPort
    $jobs += $webJob
    Write-Status "Web job started (PID: $($webJob.Id))"
}

# Wait for Ctrl+C
Write-Status "All components running. Press Ctrl+C to stop."
Write-Host "  Server: http://localhost:$ServerPort"
Write-Host "  Web:    http://localhost:$WebPort"
Write-Host ""
Write-Host "  API endpoints:"
Write-Host "    POST http://localhost:$ServerPort/v1/ingest"
Write-Host "    GET  http://localhost:$ServerPort/v1/summary?day=YYYY-MM-DD"
Write-Host "    GET  http://localhost:$ServerPort/v1/last-day"
Write-Host "    GET  http://localhost:$ServerPort/health"
Write-Host ""
Write-Host "  Collector runs via: bun $collectorDir\index.ts -- --push"

try {
    while ($true) { Start-Sleep -Seconds 10 }
}
catch {
    Stop-All
}