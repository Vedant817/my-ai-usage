# Sync this machine's usage without cloning the repo (Windows).
# Requires once per machine: Bun (or Node 22+) plus API_URL, INGEST_TOKEN,
# DEVICE_ID, DEVICE_LABEL env vars. Register to run every 15 minutes:
#   schtasks /create /tn "UsageDash" /tr "powershell -ExecutionPolicy Bypass -File '%USERPROFILE%\.usage-dash\sync-windows.ps1'" /sc minute /mo 15 /f
$ErrorActionPreference = "Stop"
& bunx ai-usage-collector@latest --push --days 30
