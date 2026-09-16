param(
  [switch]$Apply,
  [switch]$SkipDependencies,
  [switch]$SkipBuild,
  [switch]$SkipShortcut,
  [switch]$SkipStartup,
  [switch]$StopRunningApp,
  [string]$Remote = "origin",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$expectedRepository = "stonksmasters/borg-coding"

function Invoke-Git {
  param([string[]]$Arguments)

  $lines = @(& git -C $repositoryRoot @Arguments 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed:`n$($lines -join "`n")"
  }
  return ($lines -join "`n").Trim()
}

if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot ".git"))) {
  throw "$repositoryRoot is not a Git checkout. Run this script from the canonical BORG Code repository."
}

$remoteUrl = Invoke-Git @("remote", "get-url", $Remote)
$normalizedRemote = $remoteUrl.ToLowerInvariant().TrimEnd("/")
if ($normalizedRemote.EndsWith(".git")) {
  $normalizedRemote = $normalizedRemote.Substring(0, $normalizedRemote.Length - 4)
}
if (-not ($normalizedRemote.EndsWith("/$expectedRepository") -or $normalizedRemote.EndsWith(":$expectedRepository"))) {
  throw "Remote '$Remote' points to '$remoteUrl', not the canonical $expectedRepository repository. No changes were made."
}

Invoke-Git @("fetch", "--prune", $Remote, $Branch) | Out-Null
$remoteRef = "$Remote/$Branch"
$currentBranch = Invoke-Git @("branch", "--show-current")
$localCommit = Invoke-Git @("rev-parse", "HEAD")
$remoteCommit = Invoke-Git @("rev-parse", $remoteRef)
$status = Invoke-Git @("status", "--porcelain=v1")
$counts = (Invoke-Git @("rev-list", "--left-right", "--count", "HEAD...$remoteRef")) -split "\s+"
$ahead = [int]$counts[0]
$behind = [int]$counts[1]
$dirty = -not [string]::IsNullOrWhiteSpace($status)

Write-Output "Repository: $repositoryRoot"
Write-Output "Remote:     $remoteUrl"
Write-Output "Branch:     $currentBranch"
Write-Output "Local:      $localCommit"
Write-Output "Canonical:  $remoteCommit"
Write-Output "Ahead:      $ahead"
Write-Output "Behind:     $behind"
Write-Output "Dirty:      $dirty"

if (-not $Apply) {
  Write-Output "Status only. Run npm run desktop:sync to fast-forward, rebuild, and repoint the desktop shortcut."
  exit 0
}

if ($currentBranch -ne $Branch) {
  throw "The checkout is on '$currentBranch', not '$Branch'. Switch deliberately after preserving that branch's work; the sync command will not abandon it."
}
if ($dirty) {
  throw "The checkout has uncommitted changes. Commit or stash them deliberately before syncing; the sync command never resets or deletes local work."
}
if ($ahead -gt 0) {
  throw "The checkout is $ahead commit(s) ahead of $remoteRef. Reconcile or publish those commits before syncing; the sync command never rewrites history."
}

$runningApp = @(Get-Process -Name "BORG Code" -ErrorAction SilentlyContinue)
if ($runningApp.Count -gt 0 -and -not $SkipBuild) {
  if (-not $StopRunningApp) {
    throw "BORG Code is running. Exit it from the tray, or rerun with -StopRunningApp to stop it explicitly before rebuilding."
  }
  $runningApp | Stop-Process
  $runningApp | Wait-Process -ErrorAction SilentlyContinue
}

Invoke-Git @("pull", "--ff-only", $Remote, $Branch) | Out-Null

Push-Location $repositoryRoot
try {
  if (-not $SkipDependencies) {
    & npm run install:ci
    if ($LASTEXITCODE -ne 0) { throw "Locked dependency installation failed." }
  }
  if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot "build-desktop.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Desktop build failed." }
  }
  if (-not $SkipShortcut) {
    $installArguments = @("-SkipBuild")
    if ($SkipStartup) { $installArguments += "-SkipStartup" }
    & (Join-Path $PSScriptRoot "install-desktop.ps1") @installArguments
    if ($LASTEXITCODE -ne 0) { throw "Desktop shortcut installation failed." }
  }
} finally {
  Pop-Location
}

$updatedCommit = Invoke-Git @("rev-parse", "HEAD")
Write-Output "BORG Code is synchronized at $updatedCommit."
Write-Output "The desktop shortcut now launches this checkout: $repositoryRoot"
