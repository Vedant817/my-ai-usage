# Run collector every 15 minutes (Windows). Run once as admin to register:
#   schtasks /create /tn "UsageDash" /tr "bun 'C:\path\to\my-ai-usage\collector\index.ts --push'" /sc minute /mo 15 /f
# Or with Task Scheduler GUI pointing at schedule-windows.ps1.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$collector = Join-Path (Split-Path -Parent $root) "collector\index.ts"
& bun $collector --push
