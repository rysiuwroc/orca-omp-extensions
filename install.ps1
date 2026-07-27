# Install the Orca OMP extensions for the current user.
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$sourceDirectory = $PSScriptRoot
$targetDirectory = Join-Path -Path $HOME -ChildPath '.omp\agent\extensions'
$files = @(
    'orca-agent-status.ts'
    'orca-titlebar-spinner.ts'
    'orca-prefill.ts'
)

New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path -Path $sourceDirectory -ChildPath $file) -Destination $targetDirectory -Force
}

Write-Output "Installed Orca OMP extensions to $targetDirectory"
