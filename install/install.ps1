<#
Installs (or removes) Dual Agent in VS Code on Windows.

  .\install.ps1                      install into every VS Code-family editor found
  .\install.ps1 -Editors code        install into the named editors only
  .\install.ps1 -Uninstall           remove it again

Picks the VSIX that matches this machine (x64 or ARM64) from the folder this
script is in, or from ..\dist.
#>
param(
  [switch]$Uninstall,
  [string[]]$Editors = @()
)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# The extension id is <publisher>.<name> from package.json, next to this script in
# dist\ (copied there by scripts/package.mjs) or one folder up in the repo.
$PkgFile = @("$Here\package.json", "$Here\..\package.json") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $PkgFile) {
  Write-Host 'package.json not found next to this script or in its parent folder.' -ForegroundColor Red
  exit 1
}
$Pkg = Get-Content -Raw -Path $PkgFile | ConvertFrom-Json
if (-not $Pkg.publisher -or -not $Pkg.name) {
  Write-Host "No publisher and name in $PkgFile." -ForegroundColor Red
  exit 1
}
$ExtId = "$($Pkg.publisher).$($Pkg.name)"

# --- Which build fits this machine ---------------------------------------------
# A 32-bit shell on 64-bit Windows reports the real CPU in PROCESSOR_ARCHITEW6432.
$cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($cpu) {
  'AMD64' { $target = 'win32-x64' }
  'ARM64' { $target = 'win32-arm64' }
  default { Write-Error "Unsupported CPU: $cpu"; exit 1 }
}

# --- Which editors to install into ----------------------------------------------
$names = if ($Editors.Count) { $Editors } else { @('code', 'code-insiders', 'codium', 'cursor', 'windsurf') }
$found = @()
foreach ($name in $names) {
  $cmd = Get-Command "$name.cmd" -ErrorAction SilentlyContinue
  if ($cmd) { $found += $cmd.Source }
}
# The command is often not on PATH; look where the installers put it.
$known = @{
  'code'          = @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd", "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd")
  'code-insiders' = @("$env:LOCALAPPDATA\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd", "$env:ProgramFiles\Microsoft VS Code Insiders\bin\code-insiders.cmd")
  'codium'        = @("$env:LOCALAPPDATA\Programs\VSCodium\bin\codium.cmd", "$env:ProgramFiles\VSCodium\bin\codium.cmd")
  'cursor'        = @("$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd")
  'windsurf'      = @("$env:LOCALAPPDATA\Programs\Windsurf\bin\windsurf.cmd")
}
foreach ($name in $names) {
  foreach ($p in $known[$name]) {
    if ($p -and (Test-Path $p)) { $found += (Resolve-Path $p).Path }
  }
}
# The same editor can be found on PATH and in its install folder.
$clis = $found | ForEach-Object { (Resolve-Path $_).Path } | Sort-Object -Unique

if (-not $clis) {
  Write-Host 'No VS Code command line found.' -ForegroundColor Red
  Write-Host "Install VS Code (https://code.visualstudio.com), or in VS Code run ""Shell Command: Install 'code' command in PATH"", then run this again."
  exit 1
}

if ($Uninstall) {
  foreach ($cli in $clis) {
    Write-Host "Removing from $(Split-Path -Leaf $cli)..."
    & $cli --uninstall-extension $ExtId
  }
  exit 0
}

# --- Install ---------------------------------------------------------------------
$vsix = Get-ChildItem -Path @("$Here\dual-agent-*-$target.vsix", "$Here\..\dist\dual-agent-*-$target.vsix") -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) {
  Write-Host "No Dual Agent build for $target next to this script." -ForegroundColor Red
  Write-Host 'Build it with: make package   (or: node scripts/package.mjs)'
  exit 1
}

Write-Host "Installing $($vsix.Name) for $target"
foreach ($cli in $clis) {
  Write-Host "  -> $(Split-Path -Leaf $cli)"
  # Remove the old version first: a rebuild keeps the version number, and the
  # editor could otherwise keep the copy it already has.
  if (& $cli --list-extensions 2>$null | Where-Object { $_ -ieq $ExtId }) {
    Write-Host '     removing the installed version'
    & $cli --uninstall-extension $ExtId | Out-Null
  }
  & $cli --install-extension $vsix.FullName --force
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Host ''
Write-Host 'Done. Restart VS Code (or run Developer: Reload Window), then open Dual Agent from the activity bar.'
