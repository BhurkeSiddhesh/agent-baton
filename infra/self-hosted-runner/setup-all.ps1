[CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
param([string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'))
Import-Module (Join-Path $PSScriptRoot 'RunnerInfra.psm1') -Force
$config = Get-RunnerConfig -ConfigPath $ConfigPath
foreach ($repository in @($config.repositories | Where-Object enabled)) {
    Install-RepositoryRunner -Config $config -Repository $repository -WhatIf:$WhatIfPreference -Confirm:$false
}
