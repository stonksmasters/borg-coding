param(
  [switch]$SkipBuild,
  [switch]$SkipStartup
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$executable = Join-Path $repositoryRoot "artifacts\desktop\BORG Code.exe"

if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot "build-desktop.ps1")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Test-Path -LiteralPath $executable)) { throw "Build BORG Code before installing its shortcuts." }

$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
if ([string]::IsNullOrWhiteSpace($desktop)) {
  $desktopCandidates = @()
  if ($env:USERPROFILE) { $desktopCandidates += Join-Path $env:USERPROFILE "Desktop" }
  if ($env:OneDrive) { $desktopCandidates += Join-Path $env:OneDrive "Desktop" }
  $desktop = $desktopCandidates | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($desktop)) { throw "The Windows desktop folder could not be located." }
New-Item -ItemType Directory -Path $desktop -Force | Out-Null
$shortcutPath = Join-Path $desktop "BORG Code.lnk"
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $executable
$shortcut.WorkingDirectory = $repositoryRoot
$shortcut.Description = "BORG Code local AI engineering workspace"
$shortcut.Save()

if (-not $SkipStartup) {
  & $executable --install-startup
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Output "Desktop shortcut: $shortcutPath"
Write-Output $(if ($SkipStartup) { "Windows startup: unchanged" } else { "Windows startup: enabled" })
