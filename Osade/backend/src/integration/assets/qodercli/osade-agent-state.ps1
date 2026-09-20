# installed by osade
# managed by osade; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# OSADE_INTEGRATION_ID=qodercli
# OSADE_INTEGRATION_VERSION=3

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

if ($null -eq $payload -or [string]::IsNullOrWhiteSpace($payload.session_id)) { exit 0 }

$seq = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$osade = if ([string]::IsNullOrWhiteSpace($env:OSADE_BIN_PATH)) { "osade" } else { $env:OSADE_BIN_PATH }
try {
    & $osade pane report-agent-session $env:OSADE_PANE_ID --source osade:qodercli --agent qodercli --agent-session-id $payload.session_id --seq $seq 2>$null | Out-Null
} catch {
}
