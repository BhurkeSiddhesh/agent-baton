Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RunnerConfig {
    [CmdletBinding()]
    param([string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'))
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Configuration not found: $ConfigPath" }
    $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
    if ($config.schemaVersion -ne 1) { throw "Unsupported schemaVersion: $($config.schemaVersion)" }
    if ([string]::IsNullOrWhiteSpace($config.owner) -or [string]::IsNullOrWhiteSpace($config.runnerRoot)) { throw 'owner and runnerRoot are required' }
    if ([int]$config.maxConcurrent -lt 1 -or [int]$config.maxConcurrent -gt 2) { throw 'maxConcurrent must be 1 or 2' }
    return $config
}

function Invoke-GhJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & gh @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "gh failed: $($output -join [Environment]::NewLine)" }
    if (-not $output) { return $null }
    return ($output -join [Environment]::NewLine) | ConvertFrom-Json
}

function Get-RepositoryInfo {
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)]$Repository)
    $fullName = "$($Config.owner)/$($Repository.name)"
    $repo = Invoke-GhJson @('repo', 'view', $fullName, '--json', 'nameWithOwner,isPrivate,defaultBranchRef,url')
    $runners = Invoke-GhJson @('api', "repos/$fullName/actions/runners")
    [pscustomobject]@{
        FullName = $fullName
        Url = $repo.url
        IsPrivate = [bool]$repo.isPrivate
        DefaultBranch = $repo.defaultBranchRef.name
        RegisteredRunner = @($runners.runners | Where-Object name -eq $Repository.runnerName | Select-Object -First 1)
    }
}

function Get-RunnerDirectory {
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)]$Repository)
    Join-Path $Config.runnerRoot $Repository.name
}

function Get-RunnerService {
    param([Parameter(Mandatory)][string]$RunnerDirectory)
    $serviceFile = Join-Path $RunnerDirectory '.service'
    if (-not (Test-Path -LiteralPath $serviceFile)) { return $null }
    $serviceName = (Get-Content -Raw -LiteralPath $serviceFile).Trim()
    if (-not $serviceName) { return $null }
    Get-Service -Name $serviceName -ErrorAction SilentlyContinue
}

function Assert-PrivateRepository {
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)]$Info)
    if ($Config.requirePrivateRepository -and -not $Info.IsPrivate) {
        throw "$($Info.FullName) is public. Persistent self-hosted runners are intentionally blocked; make the repository private or use a disposable isolated VM runner."
    }
}

function Get-LatestRunnerRelease {
    $release = Invoke-GhJson @('api', 'repos/actions/runner/releases/latest')
    $asset = @($release.assets | Where-Object name -Match '^actions-runner-win-x64-[0-9.]+\.zip$' | Select-Object -First 1)
    if (-not $asset) { throw 'Official Windows x64 runner asset was not found in the latest actions/runner release.' }
    $escaped = [regex]::Escape($asset.name)
    $hashMatch = [regex]::Match([string]$release.body, "(?is)$escaped.*?([a-f0-9]{64})")
    [pscustomobject]@{ Version = $release.tag_name.TrimStart('v'); Name = $asset.name; Url = $asset.browser_download_url; Sha256 = if ($hashMatch.Success) { $hashMatch.Groups[1].Value.ToLowerInvariant() } else { $null } }
}

function Install-RepositoryRunner {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)]$Repository)
    $info = Get-RepositoryInfo -Config $Config -Repository $Repository
    Assert-PrivateRepository -Config $Config -Info $info
    $runnerDirectory = Get-RunnerDirectory -Config $Config -Repository $Repository
    if ($info.RegisteredRunner -and (Test-Path -LiteralPath (Join-Path $runnerDirectory '.runner'))) {
        Write-Host "Already configured: $($Repository.runnerName)"
        return
    }
    if (-not $PSCmdlet.ShouldProcess($info.FullName, "install and register $($Repository.runnerName) in $runnerDirectory")) { return }
    $release = Get-LatestRunnerRelease
    $cache = Join-Path $Config.runnerRoot '_downloads'
    New-Item -ItemType Directory -Force -Path $cache, $runnerDirectory | Out-Null
    $archive = Join-Path $cache $release.Name
    if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $release.Url -OutFile $archive }
    if ($release.Sha256) {
        $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
        if ($actualHash -ne $release.Sha256) { throw "Runner archive SHA-256 mismatch for $archive" }
    } else {
        throw 'GitHub release did not publish a parseable SHA-256; refusing unverified runner installation.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $runnerDirectory 'config.cmd'))) { Expand-Archive -LiteralPath $archive -DestinationPath $runnerDirectory }
    $tokenResult = Invoke-GhJson @('api', '--method', 'POST', "repos/$($info.FullName)/actions/runners/registration-token")
    $labels = (@('windows', 'x64') + @($Repository.labels) | Select-Object -Unique) -join ','
    Push-Location $runnerDirectory
    try {
        & .\config.cmd --unattended --url "https://github.com/$($info.FullName)" --token $tokenResult.token --name $Repository.runnerName --labels $labels --work $Repository.workDirectory --runasservice --replace
        if ($LASTEXITCODE -ne 0) { throw "Runner configuration failed with exit code $LASTEXITCODE" }
    } finally {
        $tokenResult.token = $null
        Pop-Location
    }
    & icacls.exe $runnerDirectory /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' 'NETWORK SERVICE:(OI)(CI)M' | Out-Null
    $service = Get-RunnerService -RunnerDirectory $runnerDirectory
    if (-not $service) { throw 'Runner registered, but its Windows service was not found.' }
    Set-Service -Name $service.Name -StartupType Automatic
    Start-Service -Name $service.Name
}

function Remove-RepositoryRunner {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)]$Repository, [switch]$RemoveFiles)
    $runnerDirectory = Get-RunnerDirectory -Config $Config -Repository $Repository
    if (-not (Test-Path -LiteralPath (Join-Path $runnerDirectory 'config.cmd'))) { Write-Host "Not installed: $($Repository.runnerName)"; return }
    if (-not $PSCmdlet.ShouldProcess($Repository.runnerName, 'unregister and uninstall runner service')) { return }
    $info = Get-RepositoryInfo -Config $Config -Repository $Repository
    $tokenResult = Invoke-GhJson @('api', '--method', 'POST', "repos/$($info.FullName)/actions/runners/remove-token")
    Push-Location $runnerDirectory
    try {
        & .\config.cmd remove --unattended --token $tokenResult.token
        if ($LASTEXITCODE -ne 0) { throw "Runner removal failed with exit code $LASTEXITCODE" }
    } finally {
        $tokenResult.token = $null
        Pop-Location
    }
    if ($RemoveFiles) { Remove-Item -LiteralPath $runnerDirectory -Recurse -Force }
}

function Get-RunnerStatus {
    param([Parameter(Mandatory)]$Config)
    foreach ($repository in @($Config.repositories | Where-Object enabled)) {
        $info = Get-RepositoryInfo -Config $Config -Repository $repository
        $runnerDirectory = Get-RunnerDirectory -Config $Config -Repository $repository
        $service = Get-RunnerService -RunnerDirectory $runnerDirectory
        $remote = @($info.RegisteredRunner | Select-Object -First 1)
        [pscustomobject]@{
            Repository = $info.FullName; Visibility = if ($info.IsPrivate) {'private'} else {'public'}
            Runner = $repository.runnerName; RemoteStatus = if ($remote) {$remote.status} else {'not-registered'}
            Busy = if ($remote) {[bool]$remote.busy} else {$false}; Service = if ($service) {$service.Status} else {'not-installed'}
            Directory = $runnerDirectory
        }
    }
}

function Set-RunnerServiceState {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][ValidateSet('Start','Stop','Restart')][string]$Action, [string]$RepositoryName)
    $selected = @($Config.repositories | Where-Object { $_.enabled -and (-not $RepositoryName -or $_.name -eq $RepositoryName) })
    if (-not $selected) { throw 'No enabled repository matched.' }
    if ($Action -eq 'Start') { $selected = $selected | Select-Object -First ([int]$Config.maxConcurrent) }
    foreach ($repository in $selected) {
        $service = Get-RunnerService -RunnerDirectory (Get-RunnerDirectory -Config $Config -Repository $repository)
        if (-not $service) { Write-Warning "Service not installed for $($repository.name)"; continue }
        if ($PSCmdlet.ShouldProcess($service.Name, "$Action runner service")) {
            switch ($Action) { 'Start' { Start-Service $service.Name } 'Stop' { Stop-Service $service.Name } 'Restart' { Restart-Service $service.Name } }
        }
    }
}

Export-ModuleMember -Function Get-RunnerConfig, Get-RepositoryInfo, Get-RunnerDirectory, Get-RunnerService, Install-RepositoryRunner, Remove-RepositoryRunner, Get-RunnerStatus, Set-RunnerServiceState
