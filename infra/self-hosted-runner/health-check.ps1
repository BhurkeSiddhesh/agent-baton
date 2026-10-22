[CmdletBinding()]
param([string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'), [switch]$Json)
Import-Module (Join-Path $PSScriptRoot 'RunnerInfra.psm1') -Force
$config = Get-RunnerConfig -ConfigPath $ConfigPath
$drive = Get-Item -LiteralPath ([System.IO.Path]::GetPathRoot($config.runnerRoot))
$os = Get-CimInstance Win32_OperatingSystem
$status = @(Get-RunnerStatus -Config $config)
$githubHealthy = try { $null = gh auth status 2>$null; $LASTEXITCODE -eq 0 } catch { $false }
$result = [pscustomobject]@{
    Timestamp = (Get-Date).ToUniversalTime().ToString('o')
    GitHub = $githubHealthy
    FreeDiskGb = [math]::Round($drive.PSDrive.Free / 1GB, 1)
    DiskHealthy = ($drive.PSDrive.Free / 1GB) -ge [double]$config.minimumFreeDiskGb
    MemoryUsedPercent = [math]::Round((1 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize)) * 100, 1)
    CpuUsedPercent = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average, 1)
    Runners = $status
}
if ($Json) { $result | ConvertTo-Json -Depth 6 } else { $result | Format-List Timestamp,GitHub,FreeDiskGb,DiskHealthy,MemoryUsedPercent,CpuUsedPercent; $status | Format-Table -AutoSize }
if (-not $result.GitHub -or -not $result.DiskHealthy) { exit 1 }
