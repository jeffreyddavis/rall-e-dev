$ErrorActionPreference = 'Stop'
$rallyNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($rallyNode) { $rallyVersion = & $rallyNode --version }
if (!$rallyNode -or [int]($rallyVersion.TrimStart('v').Split('.')[0]) -lt 24) {
    $rallyNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (!(Test-Path -LiteralPath $rallyNode)) { throw 'Install Node 24 or newer, then run npm run dev.' }
}
Set-Location -LiteralPath $PSScriptRoot
& $rallyNode --env-file-if-exists=.env server/index.mjs
