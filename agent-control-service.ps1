# agent-control scheduled-task entry. Registered via:
#   schtasks /create /tn agent-control /sc onlogon /f /tr "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"<this file>\""
Set-Location $PSScriptRoot
# Captures the scheduler's stdout/stderr only; the structured run logs live in
# server.logs_dir from agent-control.yaml. Keep this next to the checkout so
# moving the repo cannot silently strand the console log elsewhere.
$logDir = Join-Path $PSScriptRoot 'agent-control-data\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
npm run ac -- start *>> (Join-Path $logDir 'service.out.log')
