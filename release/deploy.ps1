# Production moved to Ubuntu on 2026-11-18.
# This file is intentionally a guard so nobody deploys to the retired Windows host.
Write-Host 'Production is now Ubuntu: ubuntu@62.234.109.9'
Write-Host 'Use: powershell -File release\deploy-linux.ps1'
Write-Host 'Legacy Windows script is kept as release\deploy-windows-legacy.ps1 (do not run).'
Write-Host 'Migration notes: docs\MIGRATION-UBUNTU-2026-11-18.md'
exit 1
