# installed by osade
# managed by osade; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# OSADE_INTEGRATION_ID=claude
# OSADE_INTEGRATION_VERSION=9

param([string]$Action = "")

if ($Action -ne "session") { exit 0 }
if ($env:OSADE_ENV -ne "1") { exit 0 }
if ([string]::IsNullOrWhiteSpace($env:OSADE_PANE_ID)) { exit 0 }

$inputText = [Console]::In.ReadToEnd()
try {
    $payload = if ([string]::IsNullOrWhiteSpace($inputText)) { $null } else { $inputText | ConvertFrom-Json }
} catch {
    exit 0
}

$propertyNames = @($payload.PSObject.Properties.Name)
if ((Test-Path Env:CURSOR_VERSION) -or $propertyNames -ccontains "cursor_version") { exit 0 }
if (-not ($propertyNames -ccontains "hook_event_name") -or $payload.hook_event_name -isnot [string] -or $payload.hook_event_name -cne "SessionStart") { exit 0 }
if (-not [string]::IsNullOrWhiteSpace($payload.agent_id)) { exit 0 }

$sessionId = $payload.session_id
if ([string]::IsNullOrWhiteSpace($sessionId)) { exit 0 }

$seq = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$osade = if ([string]::IsNullOrWhiteSpace($env:OSADE_BIN_PATH)) { "osade" } else { $env:OSADE_BIN_PATH }
try {
    $args = @(
        "pane",
        "report-agent-session",
        $env:OSADE_PANE_ID,
        "--source",
        "osade:claude",
        "--agent",
        "claude",
        "--seq",
        "$seq",
        "--agent-session-id",
        "$sessionId"
    )
    if ($payload.transcript_path -is [string] -and -not [string]::IsNullOrWhiteSpace($payload.transcript_path)) {
        $args += @("--agent-session-path", "$($payload.transcript_path)")
    }
    if ($payload.hook_event_name -eq "SessionStart" -and $payload.source -is [string] -and -not [string]::IsNullOrWhiteSpace($payload.source)) {
        $args += @("--session-start-source", "$($payload.source)")
    }
    & $osade @args 2>$null | Out-Null
} catch {
}
