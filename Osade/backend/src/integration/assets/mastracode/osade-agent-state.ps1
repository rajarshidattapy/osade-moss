# installed by osade
# managed by osade; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# OSADE_INTEGRATION_ID=mastracode
# OSADE_INTEGRATION_VERSION=2

param([string]$Action = "")

if ($Action -notin @("session", "working", "idle", "blocked")) { exit 0 }
if ($env:OSADE_ENV -ne "1") { exit 0 }
if ([string]::IsNullOrWhiteSpace($env:OSADE_PANE_ID)) { exit 0 }

$inputText = [Console]::In.ReadToEnd()
try {
    $payload = if ([string]::IsNullOrWhiteSpace($inputText)) { $null } else { $inputText | ConvertFrom-Json }
} catch {
    $payload = $null
}

$sessionId = if ($null -ne $payload -and $payload.session_id -is [string]) { $payload.session_id } else { $null }
$seq = [DateTime]::UtcNow.Ticks
$osade = if ([string]::IsNullOrWhiteSpace($env:OSADE_BIN_PATH)) { "osade" } else { $env:OSADE_BIN_PATH }
try {
    if ($Action -eq "session") {
        if ([string]::IsNullOrWhiteSpace($sessionId)) { exit 0 }
        & $osade pane report-agent-session $env:OSADE_PANE_ID --source osade:mastracode --agent mastracode --seq $seq --session-start-source startup --agent-session-id $sessionId 2>$null | Out-Null
    } else {
        $args = @("pane", "report-agent", $env:OSADE_PANE_ID, "--source", "osade:mastracode", "--agent", "mastracode", "--state", $Action, "--seq", "$seq")
        if (-not [string]::IsNullOrWhiteSpace($sessionId)) {
            $args += @("--agent-session-id", $sessionId)
        }
        & $osade @args 2>$null | Out-Null
    }
} catch {
}
