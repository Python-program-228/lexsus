pub mod bridge;
pub mod db;
pub mod git;
pub mod pty;
pub mod watcher;

use std::sync::Mutex;
use tauri::State;

/// App-managed shared state: the SQLite connection, the watched project root,
/// and the (optional) interactive shell PTY.
struct AppState {
    conn: Mutex<rusqlite::Connection>,
    project_root: Mutex<Option<std::path::PathBuf>>,
    shell: Mutex<Option<pty::InteractiveShell>>,
}

/// Initialize / open the local database and return the connection.
#[tauri::command]
fn init_database(state: State<'_, AppState>, db_path: String) -> Result<Vec<String>, String> {
    let conn = db::open_and_migrate(std::path::Path::new(&db_path)).map_err(|e| e.to_string())?;
    let applied = db::applied_versions(&conn).map_err(|e| e.to_string())?;
    *state.conn.lock().unwrap() = conn;
    Ok(applied)
}

/// Set the project folder this app monitors.
#[tauri::command]
fn set_project_root(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(path);
    if !p.is_dir() {
        return Err(format!("not a directory: {}", p.display()));
    }
    *state.project_root.lock().unwrap() = Some(p);
    Ok(())
}

/// Get the current git status of the project (working tree).
#[tauri::command]
fn git_status(state: State<'_, AppState>) -> Result<Vec<git::GitFileStatus>, String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "project root not set".to_string())?;
    let repo = git::open_repo(&root).map_err(|e| e.to_string())?;
    git::status(&repo).map_err(|e| e.to_string())
}

/// Get the current branch of the project.
#[tauri::command]
fn git_branch(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "project root not set".to_string())?;
    let repo = git::open_repo(&root).map_err(|e| e.to_string())?;
    Ok(git::current_branch(&repo))
}

/// Stage all changes and commit them with the given message.
#[tauri::command]
fn git_commit(state: State<'_, AppState>, message: String) -> Result<String, String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "project root not set".to_string())?;
    let repo = git::open_repo(&root).map_err(|e| e.to_string())?;
    let oid = git::commit(&repo, &message).map_err(|e| e.to_string())?;
    Ok(oid.to_string())
}

/// Run a shell command in the project directory and return its output.
#[tauri::command]
fn run_command(state: State<'_, AppState>, command: String) -> Result<pty::CommandOutput, String> {
    let cwd = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    pty::run_command(&command, &cwd).map_err(|e| e.to_string())
}

/// Start watching the project folder; returns once the watcher is registered.
#[tauri::command]
fn start_watch(state: State<'_, AppState>) -> Result<(), String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "project root not set".to_string())?;
    watcher::watch(&root).map_err(|e| e.to_string())?;
    Ok(())
}

/// Stub for web-AI tool calls (implemented in Phase 1).
#[tauri::command]
fn bridge_tool(tool: bridge::Tool) -> Result<bridge::ToolResult, String> {
    Ok(bridge::tool_not_implemented(&tool))
}

/// Spawn an interactive shell PTY (used by the terminal pane).
#[tauri::command]
fn spawn_shell(state: State<'_, AppState>) -> Result<String, String> {
    let cwd = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let shell = pty::spawn_interactive_shell(&cwd);
    *state.shell.lock().unwrap() = Some(shell);
    Ok("shell spawned".to_string())
}

/// Write input into the running interactive shell PTY.
#[tauri::command]
fn shell_write(state: State<'_, AppState>, input: String) -> Result<(), String> {
    let mut shell = state
        .shell
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "no shell spawned".to_string())?;
    shell.write_input(&input).map_err(|e| e.to_string())?;
    *state.shell.lock().unwrap() = Some(shell);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            conn: Mutex::new(rusqlite::Connection::open_in_memory().expect("in-memory db")),
            project_root: Mutex::new(None),
            shell: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            init_database,
            set_project_root,
            git_status,
            git_branch,
            git_commit,
            run_command,
            start_watch,
            bridge_tool,
            spawn_shell,
            shell_write,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
