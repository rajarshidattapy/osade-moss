use crate::api::schema::IntegrationTarget;

pub(super) fn run_integration_command(args: &[String]) -> std::io::Result<i32> {
    let Some(subcommand) = args.first().map(|arg| arg.as_str()) else {
        print_integration_help();
        return Ok(2);
    };

    match subcommand {
        "install" => integration_install(&args[1..]),
        "uninstall" => integration_uninstall(&args[1..]),
        "status" => integration_status(&args[1..]),
        "help" | "--help" | "-h" => {
            print_integration_help();
            Ok(0)
        }
        _ => {
            print_integration_help();
            Ok(2)
        }
    }
}

fn integration_status(args: &[String]) -> std::io::Result<i32> {
    let outdated_only = match args {
        [] => false,
        [flag] if flag == "--outdated-only" => true,
        _ => {
            eprintln!("usage: osade integration status [--outdated-only]");
            return Ok(2);
        }
    };

    if outdated_only {
        crate::integration::print_outdated_update_notice();
        return Ok(0);
    }

    for status in crate::integration::installed_integration_statuses() {
        let target = crate::integration::integration_target_label(status.target);
        let version = match status.installed_version {
            Some(version) => format!("v{version}"),
            None => "legacy".to_string(),
        };
        let state = match status.state {
            crate::integration::IntegrationStatusKind::NotInstalled => "not installed".to_string(),
            crate::integration::IntegrationStatusKind::Current => {
                format!("current ({version})")
            }
            crate::integration::IntegrationStatusKind::Outdated
                if status
                    .installed_version
                    .is_some_and(|installed| installed >= status.expected_version) =>
            {
                format!("needs repair ({version})")
            }
            crate::integration::IntegrationStatusKind::Outdated => {
                format!("outdated ({version} < v{})", status.expected_version)
            }
        };
        println!("{target}: {state} ({})", status.path.display());
    }

    Ok(0)
}

fn integration_install(args: &[String]) -> std::io::Result<i32> {
    let Some(target) = parse_integration_target(args, "install")? else {
        return Ok(2);
    };

    match crate::integration::install_target(target) {
        Ok(messages) => {
            print_integration_messages(messages);
            Ok(0)
        }
        Err(err) => {
            eprintln!("{err}");
            Ok(1)
        }
    }
}

fn integration_uninstall(args: &[String]) -> std::io::Result<i32> {
    let Some(target) = parse_integration_target(args, "uninstall")? else {
        return Ok(2);
    };

    match crate::integration::uninstall_target(target) {
        Ok(messages) => {
            print_integration_messages(messages);
            Ok(0)
        }
        Err(err) => {
            eprintln!("{err}");
            Ok(1)
        }
    }
}

fn print_integration_messages(messages: Vec<String>) {
    for message in messages {
        println!("{message}");
    }
}

fn parse_integration_target(
    args: &[String],
    action: &str,
) -> std::io::Result<Option<IntegrationTarget>> {
    let Some(target) = args.first().map(|arg| arg.as_str()) else {
        eprintln!(
            "usage: osade integration {action} <pi|omp|claude|codex|copilot|devin|droid|kimi|opencode|kilo|hermes|qodercli|qwen|cursor|mastracode|grok>"
        );
        return Ok(None);
    };
    if args.len() != 1 {
        eprintln!(
            "usage: osade integration {action} <pi|omp|claude|codex|copilot|devin|droid|kimi|opencode|kilo|hermes|qodercli|qwen|cursor|mastracode|grok>"
        );
        return Ok(None);
    }

    let parsed = match target {
        "pi" => IntegrationTarget::Pi,
        "omp" => IntegrationTarget::Omp,
        "claude" => IntegrationTarget::Claude,
        "codex" => IntegrationTarget::Codex,
        "copilot" => IntegrationTarget::Copilot,
        "devin" => IntegrationTarget::Devin,
        "droid" => IntegrationTarget::Droid,
        "kimi" => IntegrationTarget::Kimi,
        "opencode" => IntegrationTarget::Opencode,
        "kilo" => IntegrationTarget::Kilo,
        "hermes" => IntegrationTarget::Hermes,
        "qodercli" => IntegrationTarget::Qodercli,
        "qwen" => IntegrationTarget::Qwen,
        "cursor" => IntegrationTarget::Cursor,
        "mastracode" => IntegrationTarget::Mastracode,
        "antigravity-cli" | "antigravity_cli" => IntegrationTarget::AntigravityCli,
        "grok" => IntegrationTarget::Grok,
        _ => {
            eprintln!("unknown integration target: {target}");
            eprintln!(
                "currently supported: pi, omp, claude, codex, copilot, devin, droid, kimi, opencode, kilo, hermes, qodercli, qwen, cursor, mastracode, antigravity-cli, grok"
            );
            return Ok(None);
        }
    };

    Ok(Some(parsed))
}

fn print_integration_help() {
    eprintln!("osade integration commands:");
    eprintln!("  osade integration install pi");
    eprintln!("  osade integration install omp");
    eprintln!("  osade integration install claude");
    eprintln!("  osade integration install codex");
    eprintln!("  osade integration install copilot");
    eprintln!("  osade integration install devin");
    eprintln!("  osade integration install droid");
    eprintln!("  osade integration install kimi");
    eprintln!("  osade integration install opencode");
    eprintln!("  osade integration install kilo");
    eprintln!("  osade integration install hermes");
    eprintln!("  osade integration install qodercli");
    eprintln!("  osade integration install qwen");
    eprintln!("  osade integration install cursor");
    eprintln!("  osade integration install mastracode");
    eprintln!("  osade integration install antigravity-cli");
    eprintln!("  osade integration install grok");
    eprintln!("  osade integration uninstall pi");
    eprintln!("  osade integration uninstall omp");
    eprintln!("  osade integration uninstall claude");
    eprintln!("  osade integration uninstall codex");
    eprintln!("  osade integration uninstall copilot");
    eprintln!("  osade integration uninstall devin");
    eprintln!("  osade integration uninstall droid");
    eprintln!("  osade integration uninstall kimi");
    eprintln!("  osade integration uninstall opencode");
    eprintln!("  osade integration uninstall kilo");
    eprintln!("  osade integration uninstall hermes");
    eprintln!("  osade integration uninstall qodercli");
    eprintln!("  osade integration uninstall qwen");
    eprintln!("  osade integration uninstall cursor");
    eprintln!("  osade integration uninstall mastracode");
    eprintln!("  osade integration uninstall antigravity-cli");
    eprintln!("  osade integration uninstall grok");
    eprintln!("  osade integration status [--outdated-only]");
}
