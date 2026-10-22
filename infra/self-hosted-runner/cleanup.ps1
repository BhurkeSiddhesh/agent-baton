[CmdletBinding(SupportsShouldProcess, ConfirmImpact='Medium')]
param([string]$Repository, [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'))
Import-Module (Join-Path $PSScriptRoot 'RunnerInfra.psm1') -Force
$config = Get-RunnerConfig -ConfigPath $ConfigPath
$cutoff = (Get-Date).AddHours(-[double]$config.staleWorkspaceHours)
foreach ($item in @($config.repositories | Where-Object { $_.enabled -and (-not $Repository -or $_.name -eq $Repository) })) {
    $runnerDirectory = Get-RunnerDirectory -Config $config -Repository $item
    $service = Get-RunnerService -RunnerDirectory $runnerDirectory
    if ($service -and $service.Status -eq 'Running') { Write-Warning "Skipping $($item.name): stop its runner service before cleanup."; continue }
    $work = Join-Path $runnerDirectory $item.workDirectory
    if (-not (Test-Path -LiteralPath $work)) { continue }
    Get-ChildItem -Force -LiteralPath $work | Where-Object LastWriteTime -lt $cutoff | ForEach-Object {
        if ($PSCmdlet.ShouldProcess($_.FullName, 'remove stale runner workspace item')) { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
    }
}
