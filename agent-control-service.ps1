# agent-control scheduled-task entry. Registered via:
#   schtasks /create /tn agent-control /sc onlogon /f /tr "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"<this file>\""
Set-Location $PSScriptRoot
$logDir = Join-Path $env:USERPROFILE 'git\agent-control-data\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
npm run ac -- start *>> (Join-Path $logDir 'service.out.log')
