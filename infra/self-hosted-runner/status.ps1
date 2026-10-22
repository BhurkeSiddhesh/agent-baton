[CmdletBinding()]
param([string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'), [switch]$Json)
Import-Module (Join-Path $PSScriptRoot 'RunnerInfra.psm1') -Force
$result = Get-RunnerStatus -Config (Get-RunnerConfig -ConfigPath $ConfigPath)
if ($Json) { $result | ConvertTo-Json -Depth 5 } else { $result | Format-Table -AutoSize }
