//! Shell abstraction: runtime detection and one-shot `CommandBuilder`
//! construction. The app never hard-codes a shell; commands are built from
//! a detected [`Shell`] so behavior is predictable on Windows (PowerShell
//! -> Cmd) and Unix (Sh/Bash/Zsh).

use portable_pty::CommandBuilder;
#[cfg(not(windows))]
use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;

/// The shells this app can drive. MVP ships the Windows pair
/// (PowerShell, Cmd) and the POSIX trio (Sh, Bash, Zsh). Git Bash and WSL
/// are explicit future choices, not auto-detected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    Sh,
    Bash,
    Zsh,
    Cmd,
    PowerShell,
}

impl Shell {
    /// Detect the best shell for the current OS.
    ///
    /// Windows: PowerShell is preferred when present (checked via the
    /// well-known System32 path, never via `COMSPEC`); Cmd is the fallback.
    /// Unix: `$SHELL` basename, defaulting to `sh`.
    pub fn detect() -> Shell {
        #[cfg(windows)]
        {
            if powershell_available() {
                Shell::PowerShell
            } else {
                Shell::Cmd
            }
        }
        #[cfg(not(windows))]
        {
            match std::env::var("SHELL") {
                Ok(shell) => match Path::new(&shell)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                {
                    Some(name) if name == "bash" => Shell::Bash,
                    Some(name) if name == "zsh" => Shell::Zsh,
                    _ => Shell::Sh,
                },
                Err(_) => Shell::Sh,
            }
        }
    }

    /// A one-shot command invocation: `<shell> -c/-Command/<cmd>`.
    /// One-shots are always temporary children (see `pty::run_command_stream`).
    pub fn run_command(&self, cmd: &str) -> CommandBuilder {
        let mut builder = match self {
            Shell::PowerShell => CommandBuilder::new("powershell.exe"),
            Shell::Cmd => CommandBuilder::new(comspec_or("cmd.exe")),
            Shell::Sh => CommandBuilder::new("sh"),
            Shell::Bash => CommandBuilder::new("bash"),
            Shell::Zsh => CommandBuilder::new("zsh"),
        };
        match self {
            Shell::PowerShell => builder.args(["-NoProfile", "-NonInteractive", "-Command", cmd]),
            Shell::Cmd => builder.args(["/C", cmd]),
            Shell::Sh => builder.args(["-c", cmd]),
            Shell::Bash => builder.args(["-c", cmd]),
            Shell::Zsh => builder.args(["-c", cmd]),
        }
        builder
    }
}

#[cfg(windows)]
fn powershell_available() -> bool {
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let known = system_root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    if known.exists() {
        return true;
    }
    // Fall back to a PATH lookup for PowerShell 7+ (`pwsh` is not used here;
    // only `powershell.exe` is accepted as the interactive default).
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .map(|dir| dir.join("powershell.exe"))
                .any(|p| p.exists())
        })
        .unwrap_or(false)
}

/// `COMSPEC` is the environment-provided path to the Cmd interpreter —
/// used as the *executable path*, never as a detection preference.
#[cfg(windows)]
fn comspec_or(fallback: &str) -> String {
    std::env::var("COMSPEC").unwrap_or_else(|_| fallback.to_string())
}

#[cfg(not(windows))]
fn comspec_or(_fallback: &str) -> &'static str {
    unreachable!("COMSPEC is Windows-only")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_returns_a_valid_shell_for_this_os() {
        let shell = Shell::detect();
        #[cfg(windows)]
        assert!(
            shell == Shell::PowerShell || shell == Shell::Cmd,
            "detected {shell:?} on windows"
        );
        #[cfg(not(windows))]
        assert!(matches!(shell, Shell::Sh | Shell::Bash | Shell::Zsh));
    }

    #[test]
    fn one_shot_builders_carry_the_command() {
        // CommandBuilder arg shapes — construction must never fail.
        let sh = Shell::Sh.run_command("echo x");
        let args: Vec<String> = sh
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"echo x".to_string()));

        let ps = Shell::PowerShell.run_command("echo x");
        let args: Vec<String> = ps
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.contains(&"-Command".to_string()));
    }
}
