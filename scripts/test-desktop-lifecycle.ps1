$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$buildScript = Join-Path $PSScriptRoot "build-desktop.ps1"
$executable = Join-Path $repositoryRoot "artifacts\desktop\BORG Code.exe"

function Wait-ForExit([System.Diagnostics.Process]$Process, [int]$Seconds = 15) {
    if (-not $Process.WaitForExit($Seconds * 1000)) {
        throw "Desktop process $($Process.Id) did not exit within $Seconds seconds."
    }
}

function Wait-ForWindow([System.Diagnostics.Process]$Process, [int]$Seconds = 20) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "Desktop exited before its window was ready." }
        if ($Process.MainWindowHandle -ne 0) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "Desktop window did not become available within $Seconds seconds."
}

function Wait-ForGateway([int]$Seconds = 30) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:4312/health" -TimeoutSec 2
            if ($health.status -eq "ok") { return }
        } catch { }
        Start-Sleep -Milliseconds 350
    }
    throw "Desktop session gateway did not become healthy within $Seconds seconds."
}

function Request-DesktopExit {
    $request = Start-Process -FilePath $executable -ArgumentList "--request-exit" -PassThru
    Wait-ForExit $request 5
}

function Get-BorgOwnedProcesses {
    $escapedRoot = [Regex]::Escape($repositoryRoot)
    Get-CimInstance Win32_Process | Where-Object {
        ($_.ExecutablePath -eq $executable) -or
        ($_.Name -eq "node.exe" -and $_.CommandLine -and (
            $_.CommandLine -match "apps[\\/]server[\\/]src[\\/]index\.ts" -or
            $_.CommandLine -match "apps[\\/]server[\\/]src[\\/]desktop-gateway\.ts" -or
            $_.CommandLine -match "apps[\\/]server[\\/]src[\\/]remote-gateway\.ts" -or
            ($_.CommandLine -match "vinext" -and $_.CommandLine -match $escapedRoot)
        ))
    }
}

function Assert-ZeroBorgProcesses([string]$Context) {
    Start-Sleep -Milliseconds 700
    $remaining = @(Get-BorgOwnedProcesses)
    if ($remaining.Count -gt 0) {
        $details = $remaining | ForEach-Object { "pid=$($_.ProcessId) name=$($_.Name) cmd=$($_.CommandLine)" }
        throw "$Context left BORG processes running:`n$($details -join "`n")"
    }
}

Write-Host "Building desktop launcher..."
& $buildScript | Out-Host
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not (Test-Path -LiteralPath $executable)) { throw "Desktop executable was not created." }

Write-Host "Checking Windows Credential Manager bridge..."
$credentialTarget = "BORG Code/LifecycleTest/$([Guid]::NewGuid().ToString('N'))"
$credentialSecret = "  borg-test-$([Guid]::NewGuid().ToString('N')) with spaces  "
try {
    $setInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $setInfo.FileName = $executable
    $setInfo.UseShellExecute = $false
    $setInfo.CreateNoWindow = $true
    $setInfo.RedirectStandardInput = $true
    $setInfo.RedirectStandardError = $true
    $setInfo.Arguments = "--credential-set `"$credentialTarget`""
    $setProcess = [System.Diagnostics.Process]::new()
    $setProcess.StartInfo = $setInfo
    [void]$setProcess.Start()
    $setProcess.StandardInput.Write($credentialSecret)
    $setProcess.StandardInput.Close()
    $setError = $setProcess.StandardError.ReadToEnd()
    $setProcess.WaitForExit()
    if ($setProcess.ExitCode -ne 0) { throw "Credential set command failed: $setError" }

    $getInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $getInfo.FileName = $executable
    $getInfo.UseShellExecute = $false
    $getInfo.CreateNoWindow = $true
    $getInfo.RedirectStandardOutput = $true
    $getInfo.RedirectStandardError = $true
    $getInfo.Arguments = "--credential-get `"$credentialTarget`""
    $getProcess = [System.Diagnostics.Process]::new()
    $getProcess.StartInfo = $getInfo
    [void]$getProcess.Start()
    $roundTrip = $getProcess.StandardOutput.ReadToEnd()
    $getError = $getProcess.StandardError.ReadToEnd()
    $getProcess.WaitForExit()
    if ($getProcess.ExitCode -ne 0) { throw "Credential get command failed: $getError" }
    if ($roundTrip -cne $credentialSecret) { throw "Credential did not round-trip exactly through Windows Credential Manager." }
} finally {
    & $executable --credential-delete $credentialTarget | Out-Null
}

Write-Host "Checking window close -> tray -> reopen -> Exit..."
$desktop = Start-Process -FilePath $executable -PassThru
Wait-ForWindow $desktop
$closed = $desktop.CloseMainWindow()
if (-not $closed) { throw "Could not send the normal window-close request." }
Start-Sleep -Seconds 1
$desktop.Refresh()
if ($desktop.HasExited) { throw "Normal window close terminated the app instead of hiding it to the tray." }

$activation = Start-Process -FilePath $executable -PassThru
Wait-ForExit $activation 5
Start-Sleep -Milliseconds 500
$desktop.Refresh()
if ($desktop.HasExited) { throw "Second-instance activation unexpectedly terminated the desktop app." }

Request-DesktopExit
Wait-ForExit $desktop 20
Assert-ZeroBorgProcesses "Idle tray Exit"

Write-Host "Checking Exit while an agent request is active..."
$desktop = Start-Process -FilePath $executable -ArgumentList "--background" -PassThru
Wait-ForGateway
$session = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4312/api/sessions" -ContentType "application/json" -Body '{"activeMode":"agent","title":"Lifecycle active-task test"}'
$sessionId = $session.session.id
$chatJob = Start-Job -ScriptBlock {
    param($id)
    try {
        Invoke-WebRequest -Method Post -Uri "http://127.0.0.1:4312/api/chat" -ContentType "application/json" -Body (@{ sessionId = $id; request = "Inspect the repository briefly so lifecycle shutdown can interrupt an active request." } | ConvertTo-Json) -TimeoutSec 60 | Out-Null
    } catch { }
} -ArgumentList $sessionId
Start-Sleep -Milliseconds 500
Request-DesktopExit
Wait-ForExit $desktop 20
Stop-Job $chatJob -ErrorAction SilentlyContinue
Remove-Job $chatJob -Force -ErrorAction SilentlyContinue
Assert-ZeroBorgProcesses "Active-task tray Exit"

Write-Host "Desktop lifecycle regression passed: close-to-tray, activation, credential persistence, idle Exit, and active-task Exit all terminated cleanly."
