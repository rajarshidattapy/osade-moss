# installed by osade
# managed by osade; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# OSADE_INTEGRATION_ID=kimi
# OSADE_INTEGRATION_VERSION=7

param([string]$Action = "")

if (@("session", "working", "blocked", "idle") -notcontains $Action) { exit 0 }
if ($env:OSADE_ENV -ne "1") { exit 0 }
if ([string]::IsNullOrWhiteSpace($env:OSADE_PANE_ID)) { exit 0 }

$inputText = [Console]::In.ReadToEnd()
try {
    $payload = if ([string]::IsNullOrWhiteSpace($inputText)) { $null } else { $inputText | ConvertFrom-Json }
} catch {
    $payload = $null
}

$seq = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$sessionId = if ($null -ne $payload -and -not [string]::IsNullOrWhiteSpace($payload.session_id)) { $payload.session_id } else { $null }
$osade = if ([string]::IsNullOrWhiteSpace($env:OSADE_BIN_PATH)) { "osade" } else { $env:OSADE_BIN_PATH }

try {
    if ($Action -eq "session") {
        if ([string]::IsNullOrWhiteSpace($sessionId)) { exit 0 }
        & $osade pane report-agent-session $env:OSADE_PANE_ID --source osade:kimi --agent kimi --agent-session-id $sessionId --session-start-source startup --seq $seq 2>$null | Out-Null
    } else {
        if ([string]::IsNullOrWhiteSpace($sessionId)) {
            & $osade pane report-agent $env:OSADE_PANE_ID --source osade:kimi --agent kimi --state $Action --seq $seq 2>$null | Out-Null
        } else {
            & $osade pane report-agent $env:OSADE_PANE_ID --source osade:kimi --agent kimi --state $Action --agent-session-id $sessionId --seq $seq 2>$null | Out-Null
        }
    }
} catch {
}
