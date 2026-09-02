//! The task entity and its state machine (Agent Runtime, Phase 1).
//!
//! A task is the unit of autonomous work: an objective the agent executes
//! through a sequence of tool calls. Every state change is validated
//! against the transition table and persisted to `tasks` /
//! `task_state_transitions`, so a restart can resume or at least explain
//! exactly where each task stopped.
//!
//! The machine is deliberately small and total: `transition` either
//! applies a legal edge (and records it) or returns an error — there is
//! no way to smuggle a task into an arbitrary state.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

/// All states a task can be in. Serialized as snake_case strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Created,
    Queued,
    Planning,
    Executing,
    /// Blocked on a user approval for a tool call.
    WaitingApproval,
    /// Blocked on free-form user input (a question from the agent).
    AwaitingInput,
    /// Paused by the user; resumable.
    Paused,
    /// Cannot proceed without external help (error the agent cannot fix).
    Blocked,
    /// A step failed; a retry is scheduled/in progress.
    Retrying,
    /// Cancellation requested, running steps are being stopped.
    Cancelling,
    Cancelled,
    Completed,
    Failed,
}

impl TaskState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskState::Created => "created",
            TaskState::Queued => "queued",
            TaskState::Planning => "planning",
            TaskState::Executing => "executing",
            TaskState::WaitingApproval => "waiting_approval",
            TaskState::AwaitingInput => "awaiting_input",
            TaskState::Paused => "paused",
            TaskState::Blocked => "blocked",
            TaskState::Retrying => "retrying",
            TaskState::Cancelling => "cancelling",
            TaskState::Cancelled => "cancelled",
            TaskState::Completed => "completed",
            TaskState::Failed => "failed",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "created" => TaskState::Created,
            "queued" => TaskState::Queued,
            "planning" => TaskState::Planning,
            "executing" => TaskState::Executing,
            "waiting_approval" => TaskState::WaitingApproval,
            "awaiting_input" => TaskState::AwaitingInput,
            "paused" => TaskState::Paused,
            "blocked" => TaskState::Blocked,
            "retrying" => TaskState::Retrying,
            "cancelling" => TaskState::Cancelling,
            "cancelled" => TaskState::Cancelled,
            "completed" => TaskState::Completed,
            "failed" => TaskState::Failed,
            _ => return None,
        })
    }

    /// Terminal states: nothing leaves these.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TaskState::Cancelled | TaskState::Completed | TaskState::Failed
        )
    }

    /// States in which real work (tool calls) may happen.
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            TaskState::Executing | TaskState::Planning | TaskState::Retrying
        )
    }

    /// Legal successors of this state. This table is the single source of
    /// truth for the machine; `transition` refuses anything not listed.
    fn successors(&self) -> &'static [TaskState] {
        use TaskState::*;
        match self {
            Created => &[Queued, Planning, Executing, Cancelled],
            Queued => &[Planning, Executing, Paused, Cancelling, Cancelled],
            Planning => &[Executing, AwaitingInput, Paused, Blocked, Cancelling, Cancelled, Failed],
            Executing => &[
                WaitingApproval,
                AwaitingInput,
                Paused,
                Retrying,
                Blocked,
                Cancelling,
                Cancelled,
                Completed,
                Failed,
            ],
            WaitingApproval => &[Executing, Cancelling, Cancelled, Failed],
            AwaitingInput => &[Executing, Paused, Cancelling, Cancelled, Failed],
            Paused => &[Queued, Executing, Cancelling, Cancelled],
            Blocked => &[Executing, AwaitingInput, Cancelling, Cancelled, Failed],
            Retrying => &[Executing, Blocked, Cancelling, Cancelled, Failed],
            Cancelling => &[Cancelled, Failed],
            Cancelled | Completed | Failed => &[],
        }
    }

    /// Can a task in `self` move directly to `to`?
    pub fn can_transition_to(&self, to: TaskState) -> bool {
        self.successors().contains(&to)
    }
}

impl fmt::Display for TaskState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A task row as persisted in SQLite.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub state: TaskState,
    /// Origin of the task: "web" | "desktop" | a web-AI host name.
    pub source: String,
    /// Optional link to the session that created the task.
    pub session_id: Option<i64>,
    /// Free-form JSON metadata (plan, progress counters, last error).
    pub meta: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One recorded state change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateTransition {
    pub task_id: String,
    pub from_state: Option<TaskState>,
    pub to_state: TaskState,
    pub reason: String,
    pub ts: String,
}

#[derive(Debug, Clone)]
pub struct TaskError {
    pub message: String,
}

impl fmt::Display for TaskError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TaskError {}

fn err<S: Into<String>>(message: S) -> TaskError {
    TaskError {
        message: message.into(),
    }
}

/// Monotonic counter so task ids are unique within a launch even when the
/// CSPRNG produces a collision (practically impossible, but cheap to
/// guarantee).
static TASK_SEQ: AtomicU64 = AtomicU64::new(0);

/// Generate a short opaque task id: `task_<hex-random>-<seq>`.
pub fn new_task_id() -> String {
    let mut buf = [0u8; 8];
    let rand = if getrandom::getrandom(&mut buf).is_ok() {
        u64::from_le_bytes(buf)
    } else {
        // Clock fallback; still unique thanks to the sequence suffix.
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
    };
    let seq = TASK_SEQ.fetch_add(1, Ordering::SeqCst);
    format!("task_{rand:016x}-{seq}")
}

// --- persistence ---------------------------------------------------------------

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    let state_s: String = row.get(4)?;
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        objective: row.get(2)?,
        source: row.get(3)?,
        state: TaskState::from_str(&state_s).unwrap_or(TaskState::Created),
        session_id: row.get(5)?,
        meta: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

const TASK_COLS: &str =
    "id, title, objective, source, state, session_id, meta, created_at, updated_at";

/// Create a task in state `created` and record the initial transition.
pub fn create_task(
    conn: &Connection,
    title: &str,
    objective: &str,
    source: &str,
    session_id: Option<i64>,
) -> Result<Task, TaskError> {
    let id = new_task_id();
    conn.execute(
        "INSERT INTO tasks (id, title, objective, source, state, session_id, meta)
         VALUES (?1, ?2, ?3, ?4, 'created', ?5, '{}')",
        (&id, title, objective, source, session_id),
    )
    .map_err(|e| err(format!("create task: {e}")))?;
    record_transition(conn, &id, None, TaskState::Created, "task created")?;
    get_task(conn, &id)?.ok_or_else(|| err("task vanished after insert"))
}

pub fn get_task(conn: &Connection, id: &str) -> Result<Option<Task>, TaskError> {
    let mut stmt = conn
        .prepare(&format!("SELECT {TASK_COLS} FROM tasks WHERE id = ?1"))
        .map_err(|e| err(e.to_string()))?;
    let mut rows = stmt
        .query_map([id], row_to_task)
        .map_err(|e| err(e.to_string()))?;
    match rows.next() {
        Some(Ok(t)) => Ok(Some(t)),
        Some(Err(e)) => Err(err(e.to_string())),
        None => Ok(None),
    }
}

pub fn list_tasks(conn: &Connection, limit: usize) -> Result<Vec<Task>, TaskError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLS} FROM tasks ORDER BY created_at DESC, id DESC LIMIT ?1"
        ))
        .map_err(|e| err(e.to_string()))?;
    let rows = stmt
        .query_map([limit as i64], row_to_task)
        .map_err(|e| err(e.to_string()))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| err(e.to_string()))
}

/// Tasks that are not in a terminal state — the resume candidates after a
/// restart.
pub fn open_tasks(conn: &Connection) -> Result<Vec<Task>, TaskError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLS} FROM tasks
             WHERE state NOT IN ('cancelled', 'completed', 'failed')
             ORDER BY created_at ASC"
        ))
        .map_err(|e| err(e.to_string()))?;
    let rows = stmt
        .query_map([], row_to_task)
        .map_err(|e| err(e.to_string()))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| err(e.to_string()))
}

fn record_transition(
    conn: &Connection,
    task_id: &str,
    from: Option<TaskState>,
    to: TaskState,
    reason: &str,
) -> Result<(), TaskError> {
    conn.execute(
        "INSERT INTO task_state_transitions (task_id, from_state, to_state, reason)
         VALUES (?1, ?2, ?3, ?4)",
        (
            task_id,
            from.map(|s| s.as_str().to_string()),
            to.as_str(),
            reason,
        ),
    )
    .map_err(|e| err(format!("record transition: {e}")))?;
    Ok(())
}

/// Move a task to a new state, validating the edge against the transition
/// table and recording the change atomically.
pub fn transition(
    conn: &Connection,
    id: &str,
    to: TaskState,
    reason: &str,
) -> Result<Task, TaskError> {
    let task = get_task(conn, id)?.ok_or_else(|| err(format!("no such task: {id}")))?;
    let from = task.state;
    if from == to {
        return Ok(task); // idempotent no-op
    }
    if !from.can_transition_to(to) {
        return Err(err(format!(
            "illegal transition: {from} -> {to} (task {id})"
        )));
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| err(e.to_string()))?;
    tx.execute(
        "UPDATE tasks SET state = ?1, updated_at = datetime('now') WHERE id = ?2",
        (to.as_str(), id),
    )
    .map_err(|e| err(e.to_string()))?;
    record_transition(&tx, id, Some(from), to, reason)?;
    tx.commit().map_err(|e| err(e.to_string()))?;
    get_task(conn, id)?.ok_or_else(|| err("task vanished after transition"))
}

/// Update the free-form metadata blob (plan, progress, last error).
pub fn set_meta(conn: &Connection, id: &str, meta: &str) -> Result<(), TaskError> {
    conn.execute(
        "UPDATE tasks SET meta = ?1, updated_at = datetime('now') WHERE id = ?2",
        (meta, id),
    )
    .map_err(|e| err(e.to_string()))?;
    Ok(())
}

/// Full transition history for one task, oldest first.
pub fn history(conn: &Connection, id: &str) -> Result<Vec<StateTransition>, TaskError> {
    let mut stmt = conn
        .prepare(
            "SELECT task_id, from_state, to_state, reason, ts
             FROM task_state_transitions WHERE task_id = ?1 ORDER BY id ASC",
        )
        .map_err(|e| err(e.to_string()))?;
    let rows = stmt
        .query_map([id], |row| {
            let from_s: Option<String> = row.get(1)?;
            let to_s: String = row.get(2)?;
            Ok(StateTransition {
                task_id: row.get(0)?,
                from_state: from_s.and_then(|s| TaskState::from_str(&s)),
                to_state: TaskState::from_str(&to_s).unwrap_or(TaskState::Created),
                reason: row.get(3)?,
                ts: row.get(4)?,
            })
        })
        .map_err(|e| err(e.to_string()))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| err(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::open_and_migrate_into(&conn).unwrap();
        conn
    }

    #[test]
    fn happy_path_lifecycle() {
        let conn = mem();
        let t = create_task(&conn, "Fix bug", "Fix the login bug", "web", None).unwrap();
        assert_eq!(t.state, TaskState::Created);
        let t = transition(&conn, &t.id, TaskState::Executing, "plan ready").unwrap();
        assert_eq!(t.state, TaskState::Executing);
        let t = transition(&conn, &t.id, TaskState::Completed, "done").unwrap();
        assert_eq!(t.state, TaskState::Completed);
        assert!(t.state.is_terminal());
        let h = history(&conn, &t.id).unwrap();
        assert_eq!(h.len(), 3); // created, executing, completed
    }

    #[test]
    fn illegal_transition_is_refused() {
        let conn = mem();
        let t = create_task(&conn, "T", "O", "web", None).unwrap();
        let r = transition(&conn, &t.id, TaskState::Completed, "skip everything");
        assert!(r.is_err());
        assert!(r.unwrap_err().message.contains("illegal transition"));
    }

    #[test]
    fn terminal_states_are_final() {
        let conn = mem();
        let t = create_task(&conn, "T", "O", "web", None).unwrap();
        let t = transition(&conn, &t.id, TaskState::Cancelled, "user abort").unwrap();
        assert!(transition(&conn, &t.id, TaskState::Executing, "revive").is_err());
        assert!(t.state.is_terminal());
    }

    #[test]
    fn pause_and_resume() {
        let conn = mem();
        let t = create_task(&conn, "T", "O", "web", None).unwrap();
        let t = transition(&conn, &t.id, TaskState::Executing, "go").unwrap();
        let t = transition(&conn, &t.id, TaskState::Paused, "user pause").unwrap();
        assert_eq!(t.state, TaskState::Paused);
        let t = transition(&conn, &t.id, TaskState::Executing, "user resume").unwrap();
        assert_eq!(t.state, TaskState::Executing);
    }

    #[test]
    fn open_tasks_excludes_terminal() {
        let conn = mem();
        let a = create_task(&conn, "A", "a", "web", None).unwrap();
        let b = create_task(&conn, "B", "b", "web", None).unwrap();
        transition(&conn, &b.id, TaskState::Cancelled, "abort").unwrap();
        let open = open_tasks(&conn).unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].id, a.id);
    }

    #[test]
    fn transition_table_is_sane() {
        // Every state lists its successors; no state may transition into
        // `created`; terminal states have no successors.
        for s in [
            TaskState::Created,
            TaskState::Queued,
            TaskState::Planning,
            TaskState::Executing,
            TaskState::WaitingApproval,
            TaskState::AwaitingInput,
            TaskState::Paused,
            TaskState::Blocked,
            TaskState::Retrying,
            TaskState::Cancelling,
            TaskState::Cancelled,
            TaskState::Completed,
            TaskState::Failed,
        ] {
            assert!(!s.can_transition_to(TaskState::Created));
            if s.is_terminal() {
                assert!(s.successors().is_empty());
            }
        }
    }
}
