use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::sync::mpsc::Receiver;

/// A single terminal command captured via `portable-pty`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CommandOutput {
    pub command: String,
    pub exit_code: Option<i32>,
    pub output: String,
}

/// Run a shell command in a PTY, capture stdout/stderr, and wait for exit.
///
/// Note: `portable-pty` spawns the command attached to a pseudo-terminal,
/// which lets the (future) web-AI `run_command` tool and the interactive
/// terminal pane share the same mechanism.
pub fn run_command(cmd: &str, cwd: &std::path::Path) -> std::io::Result<CommandOutput> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let mut cmd_builder = CommandBuilder::new("sh");
    cmd_builder.arg("-c");
    cmd_builder.arg(cmd);
    cmd_builder.cwd(cwd);

    let mut child = pair
        .slave
        .spawn_command(cmd_builder)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let mut output = String::new();
    reader
        .read_to_string(&mut output)
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let exit_code = child.wait().ok().map(|s| s.exit_code() as i32);

    Ok(CommandOutput {
        command: cmd.to_string(),
        exit_code,
        output,
    })
}

/// A long-lived interactive shell PTY: read its output and write into it.
/// Used by the interactive terminal pane (and the future `run_command` relay).
pub struct InteractiveShell {
    pub output: Receiver<String>,
    writer: Box<dyn std::io::Write + Send>,
}

impl InteractiveShell {
    /// Send input (e.g. a command plus newline) to the running shell.
    pub fn write_input(&mut self, input: &str) -> std::io::Result<()> {
        self.writer.write_all(input.as_bytes())?;
        self.writer.flush()
    }
}

/// Spawn a long-lived interactive shell PTY and return handles for read + write.
pub fn spawn_interactive_shell(cwd: &std::path::Path) -> InteractiveShell {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty failed");

    let mut cmd_builder = CommandBuilder::new("sh");
    cmd_builder.cwd(cwd);
    let mut _child = pair.slave.spawn_command(cmd_builder).expect("spawn failed");
    drop(pair.slave);

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let mut reader = pair.master.try_clone_reader().expect("reader clone");
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                }
            }
        }
    });

    InteractiveShell {
        output: rx,
        writer: pair.master.take_writer().expect("take writer failed"),
    }
}
