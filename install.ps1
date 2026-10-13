# Agent Baton bootstrap: check Node >= 18, then run the installer from GitHub.
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [init options]
#   e.g. powershell -File install.ps1 --yes --agents claude,codex
# Once published to npm, "npx agent-baton init" does the same.
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    [Console]::Error.WriteLine("agent-baton: Node.js 18 or newer is required but 'node' was not found. Install it from https://nodejs.org")
    exit 1
}

$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) {
    $v = & node -v
    [Console]::Error.WriteLine("agent-baton: Node.js 18 or newer is required (found $v). Update from https://nodejs.org")
    exit 1
}

$npx = Get-Command npx -ErrorAction SilentlyContinue
if (-not $npx) {
    [Console]::Error.WriteLine("agent-baton: 'npx' was not found. It ships with npm; reinstall Node.js from https://nodejs.org")
    exit 1
}

& npx --yes github:BhurkeSiddhesh/agent-baton init @args
exit $LASTEXITCODE
