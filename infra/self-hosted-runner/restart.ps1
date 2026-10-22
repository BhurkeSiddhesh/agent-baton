[CmdletBinding(SupportsShouldProcess)]
param([string]$Repository, [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'))
Import-Module (Join-Path $PSScriptRoot 'RunnerInfra.psm1') -Force
Set-RunnerServiceState -Config (Get-RunnerConfig -ConfigPath $ConfigPath) -Action Restart -RepositoryName $Repository -WhatIf:$WhatIfPreference
