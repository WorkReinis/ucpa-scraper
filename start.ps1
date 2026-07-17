# One process, one port, no build step: `npm run dev` runs the real API and
# the frontend (Vite in middleware mode, hot reload) together -- see
# web/dev-server.mjs. For the single-file production build instead, see
# README ("single deployable process").

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "UCPA Tracker"
Set-Location $PSScriptRoot

# Free up port 8787 if a previous run is still holding it, so this always
# starts clean instead of failing with EADDRINUSE.
$existing = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $existing) {
  $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq "node") {
    Write-Host "Stopping previous instance on port 8787 (PID $($proc.Id))..."
    Stop-Process -Id $proc.Id -Force
  }
}

Write-Host "Starting UCPA Tracker -- http://localhost:8787  (Ctrl+C to stop)"
Write-Host ""
npm run dev
