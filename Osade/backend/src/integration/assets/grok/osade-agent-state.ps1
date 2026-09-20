# installed by osade
# managed by osade; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# OSADE_INTEGRATION_ID=grok
# OSADE_INTEGRATION_VERSION=1

param([string]$Action = "")

if ($Action -ne "session") { exit 0 }
if ($env:OSADE_ENV -ne "1") { exit 0 }
if ([string]::IsNullOrWhiteSpace($env:OSADE_PANE_ID)) { exit 0 }

$inputText = [Console]::In.ReadToEnd()
try {
    $payload = if ([string]::IsNullOrWhiteSpace($inputText)) { $null } else { $inputText | ConvertFrom-Json }
} catch {
    $payload = $null
}

$event = if ($null -ne $payload -and $payload.hook_event_name -is [string]) {
    $payload.hook_event_name
} elseif ($null -ne $payload -and $payload.hookEventName -is [string]) {
    $payload.hookEventName
} else {
    $null
}
if ($null -ne $event -and $event -notin @("session_start", "SessionStart", "sessionStart")) { exit 0 }

$sessionId = $env:GROK_SESSION_ID
if ([string]::IsNullOrWhiteSpace($sessionId) -and $null -ne $payload) {
    if ($payload.session_id -is [string]) { $sessionId = $payload.session_id }
    elseif ($payload.sessionId -is [string]) { $sessionId = $payload.sessionId }
}
if ([string]::IsNullOrWhiteSpace($sessionId)) { exit 0 }

$seq = [DateTime]::UtcNow.Ticks
$osade = if ([string]::IsNullOrWhiteSpace($env:OSADE_BIN_PATH)) { "osade" } else { $env:OSADE_BIN_PATH }
try {
    & $osade pane report-agent-session $env:OSADE_PANE_ID --source osade:grok --agent grok --seq $seq --agent-session-id $sessionId 2>$null | Out-Null
} catch {
}
