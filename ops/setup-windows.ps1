# GSB-100 Windows Dev Setup
# Run:  .\ops\setup-windows.ps1
# ASCII-only so Windows PowerShell 5 parses it cleanly.

$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")

function Say($m) { Write-Host "`n[SETUP] $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "   OK  $m" -ForegroundColor Green }
function Warn($m){ Write-Host "   !!  $m" -ForegroundColor Yellow }

# Make sure npm global bin is on PATH for this session
$npmPrefix = (npm config get prefix 2>$null).Trim()
if ($npmPrefix -and (Test-Path $npmPrefix)) {
  if (-not ($env:Path -like "*$npmPrefix*")) {
    $env:Path = "$npmPrefix;$env:Path"
    Ok "Added $npmPrefix to PATH for this session"
  }
}

# 1. Node + npm
Say "1/7  Checking Node and npm"
try { $v = node --version; Ok "node $v" } catch { Warn "Node not found."; exit 1 }
try { $v = npm --version;  Ok  "npm  $v" } catch { Warn "npm not found.";  exit 1 }

# 2. PM2
Say "2/7  PM2"
$pm2cmd = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2cmd) {
  Warn "pm2 not on PATH - installing globally"
  npm install -g pm2 | Out-Null
  $pm2cmd = Get-Command pm2 -ErrorAction SilentlyContinue
}
if ($pm2cmd) {
  Ok "pm2 at $($pm2cmd.Source)"
  $PM2 = "pm2"
} else {
  Warn "pm2 still not on PATH - will use 'npx pm2' as fallback"
  $PM2 = "npx pm2"
}

# 3. Ollama running
Say "3/7  Ollama"
try {
  $r = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 5
  Ok "ollama up, $($r.models.Count) model(s) pulled"
} catch {
  Warn "Ollama not responding. Open a new PowerShell window and run: ollama serve"
}

# 4. Pull model stack
Say "4/7  Pulling model stack (first run can take several minutes)"
$models = @("qwen2.5:3b","deepseek-r1:32b","nomic-embed-text")
foreach ($m in $models) {
  $list = (ollama list 2>$null | Out-String)
  if ($list -match [regex]::Escape($m)) {
    Ok "$m already pulled"
  } else {
    ollama pull $m
    Ok "$m pulled"
  }
}

# 5. npm install
Say "5/7  npm install"
npm install --silent 2>$null | Out-Null
Ok "dependencies installed"

# 6. Git commit + push
Say "6/7  Git push"
$gs = git status --short
if ($gs) {
  git add .
  git commit -m "GSB-100 v3: multi-model router, vector memory, Langfuse, systemd, setup scripts, README" | Out-Null
  git push origin main
  Ok "pushed to origin/main"
} else {
  Ok "nothing to commit - repo already clean"
}

# 7. PM2 restart
Say "7/7  PM2 agents"
Invoke-Expression "$PM2 delete all" 2>$null | Out-Null
Invoke-Expression "$PM2 start ecosystem.config.js" | Out-Null
Invoke-Expression "$PM2 save" | Out-Null
Invoke-Expression "$PM2 list"

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  GSB-100 WINDOWS SETUP COMPLETE" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Chat with local AI:    npm run chat"
Write-Host "  Test AI router:        node brain\ai-router.js"
Write-Host "  Test phone alert:      node notifications\alert.js"
Write-Host "  Watch agents:          pm2 logs"
Write-Host "  Agent status:          pm2 list"
Write-Host ""
Write-Host "  ROTATE SECRETS (urgent - old ones in git history):" -ForegroundColor Yellow
Write-Host "    - Gmail app password:  myaccount.google.com then App passwords"
Write-Host "    - Backblaze keys:      secure.backblaze.com then App Keys"
Write-Host "    - WhatsApp API key:    provider dashboard"
Write-Host "    Then update C:\gsb-100\.env and run: pm2 restart all"
Write-Host ""
