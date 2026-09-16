$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$project = Join-Path $repositoryRoot "apps\desktop\Borg.Desktop.csproj"
$output = Join-Path $repositoryRoot "artifacts\desktop"
$env:DOTNET_CLI_HOME = Join-Path $repositoryRoot ".dotnet-home"
$env:NUGET_PACKAGES = Join-Path $repositoryRoot ".nuget-packages"
$env:APPDATA = Join-Path $repositoryRoot ".dotnet-home\AppData\Roaming"
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = "1"
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
$localNuGetDirectory = Join-Path $env:APPDATA "NuGet"
New-Item -ItemType Directory -Path $localNuGetDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repositoryRoot "NuGet.Config") -Destination (Join-Path $localNuGetDirectory "NuGet.Config") -Force

dotnet restore $project --configfile (Join-Path $repositoryRoot "NuGet.Config")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

dotnet publish $project -c Release --self-contained false --no-restore -o $output
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$executable = Join-Path $output "BORG Code.exe"
if (-not (Test-Path -LiteralPath $executable)) { throw "Desktop executable was not created." }

Write-Output $executable
