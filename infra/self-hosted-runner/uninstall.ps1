[CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
param([string]$Repository, [switch]$RemoveFiles, [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'))
Import-Module (Join-Path $PSScriptRoot 'RunnerInfra.psm1') -Force
$config = Get-RunnerConfig -ConfigPath $ConfigPath
$selected = @($config.repositories | Where-Object { $_.enabled -and (-not $Repository -or $_.name -eq $Repository) })
if (-not $selected) { throw 'No enabled repository matched.' }
foreach ($item in $selected) { Remove-RepositoryRunner -Config $config -Repository $item -RemoveFiles:$RemoveFiles -WhatIf:$WhatIfPreference -Confirm:$false }
