# installed by osade
# managed by osade; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# OSADE_INTEGRATION_ID=qwen
# OSADE_INTEGRATION_VERSION=1

param([string]$Action = "")

if ($Action -ne "session") { exit 0 }
if ($env:OSADE_ENV -ne "1") { exit 0 }
if ([string]::IsNullOrWhiteSpace($env:OSADE_PANE_ID)) { exit 0 }
if ([string]::IsNullOrWhiteSpace($env:OSADE_SOCKET_PATH)) { exit 0 }

$inputText = [Console]::In.ReadToEnd()
try {
    $payload = if ([string]::IsNullOrWhiteSpace($inputText)) { $null } else { $inputText | ConvertFrom-Json }
} catch {
    $payload = $null
}

if ($null -eq $payload -or [string]::IsNullOrWhiteSpace($payload.session_id)) { exit 0 }

$seq = [DateTime]::UtcNow.Ticks
$osade = if ([string]::IsNullOrWhiteSpace($env:OSADE_BIN_PATH)) { "osade" } else { $env:OSADE_BIN_PATH }
$commandArgs = @(
    "pane", "report-agent-session", $env:OSADE_PANE_ID,
    "--source", "osade:qwen", "--agent", "qwen",
    "--agent-session-id", [string]$payload.session_id,
    "--seq", [string]$seq
)
if ($payload.source -in @("startup", "resume", "clear", "compact", "branch")) {
    $commandArgs += @("--session-start-source", [string]$payload.source)
}
try {
    & $osade @commandArgs 2>$null | Out-Null
} catch {
}
