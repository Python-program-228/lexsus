//! Claude Code JSONL transcript reader.
//!
//! The app does not host or observe the developer's local Claude Code
//! session. When it needs real task context for a handoff (or an
//! automatic failover), it reads the session transcripts Claude Code
//! already persists at `~/.claude/projects/<munged-cwd>/<uuid>.jsonl`.
//! The reader is deliberately tolerant of version drift: it walks the
//! NDJSON `type` field and extracts what it can, degrading gracefully.

use std::collections::VecDeque;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Context extracted from a Claude Code session transcript.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct TranscriptContext {
    pub objective: Option<String>,
    pub message_snippet: Option<String>,
    pub files_touched: Vec<String>,
    pub commands_run: Vec<String>,
    pub errors: usize,
    pub end_reason: Option<String>,
    pub last_updated: u64,
    pub source: Option<String>,
}

/// Cap how much of a transcript we read (very long sessions get huge).
const MAX_LINES: usize = 20_000;
/// Cap per-line length; pathological lines are skipped.
const MAX_LINE_LEN: usize = 32 * 1024;
/// Cap collected facts so a giant session doesn't balloon the payload.
const MAX_FACTS: usize = 30;
const MAX_SNIPPET_LEN: usize = 600;

fn projects_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())?;
    Some(PathBuf::from(home).join(".claude").join("projects"))
}

/// Munged directory name Claude Code uses for a project's transcripts
/// (non-alphanumeric run collapsed to `-`, absolute paths get a leading
/// `-`), e.g. `/home/me/proj` → `-home-me-proj`.
pub fn munge_path(p: &Path) -> String {
    let mut out = String::new();
    for ch in p.to_string_lossy().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    if p.is_absolute() && !out.starts_with('-') {
        out.insert(0, '-');
    }
    out
}

fn newest_jsonl_in(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
            continue;
        }
        let mtime = entry.metadata().and_then(|m| m.modified()).ok()?;
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, path));
        }
    }
    best.map(|(_, p)| p)
}

/// The `cwd` a transcript was recorded in (from its first line). Older
/// transcripts may not carry one — then they can't be matched by path.
fn jsonl_cwd(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let v: serde_json::Value = serde_json::from_str(&line).ok()?;
    v.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string())
}

/// Find the newest transcript whose session belongs to `project_root`.
pub fn find_newest_for(projects_dir: &Path, project_root: &Path) -> Option<PathBuf> {
    let fast = projects_dir.join(munge_path(project_root));
    if let Some(p) = newest_jsonl_in(&fast) {
        return Some(p);
    }
    // Fallback: scan subdirectories, checking the session cwd.
    let canonical = project_root.canonicalize().ok();
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for dir in std::fs::read_dir(projects_dir).ok()?.take(100).flatten() {
        if !dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(newest) = newest_jsonl_in(&dir.path()) else {
            continue;
        };
        let matches = jsonl_cwd(&newest)
            .and_then(|cwd| PathBuf::from(cwd).canonicalize().ok())
            .map(|c| Some(c) == canonical)
            .unwrap_or(false);
        if matches {
            let mtime = newest
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .unwrap_or(SystemTime::UNIX_EPOCH);
            if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                best = Some((mtime, newest));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Result of a coarse analysis of one NDJSON line.
struct LineFacts {
    user_texts: VecDeque<String>,
    summary_leaves: Vec<(String, String)>, // (subtype, leaf)
    files: Vec<String>,
    commands: Vec<String>,
    assistant_text: Option<String>,
    errors: usize,
    stop_reasons: Vec<String>,
}

/// Parse a transcript file into structured context.
pub fn parse_transcript(path: &Path) -> Result<TranscriptContext, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut facts = LineFacts {
        user_texts: VecDeque::new(),
        summary_leaves: Vec::new(),
        files: Vec::new(),
        commands: Vec::new(),
        assistant_text: None,
        errors: 0,
        stop_reasons: Vec::new(),
    };
    let reader = std::io::BufReader::new(file);
    let mut read_lines = 0usize;
    for line in reader.lines().take(MAX_LINES) {
        read_lines += 1;
        let Ok(line) = line else { continue };
        if line.len() > MAX_LINE_LEN {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "summary" => {
                if let Some(leaves) = v.get("summary").and_then(|s| s.as_array()) {
                    for leaf in leaves {
                        let text = leaf
                            .get("leaf")
                            .and_then(|x| x.as_str())
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty());
                        let subtype = leaf
                            .get("subtype")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        if let Some(text) = text {
                            facts.summary_leaves.push((subtype, text));
                        }
                    }
                }
            }
            "user" => {
                if let Some(text) = extract_user_text(&v) {
                    facts.user_texts.push_back(text);
                    if facts.user_texts.len() > 3 {
                        facts.user_texts.pop_front();
                    }
                }
            }
            "assistant" => {
                let (text, tools) = extract_assistant(&v);
                if let Some(t) = text {
                    facts.assistant_text = Some(t);
                }
                for (name, input) in tools {
                    match name.as_str() {
                        "read" | "write" | "edit" | "notebookedit" => {
                            if let Some(p) = input
                                .get("file_path")
                                .or_else(|| input.get("path"))
                                .and_then(|x| x.as_str())
                            {
                                push_fact(&mut facts.files, p);
                            }
                        }
                        "bash" => {
                            if let Some(c) = input.get("command").and_then(|x| x.as_str()) {
                                push_fact(&mut facts.commands, c);
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(sr) = v
                    .get("message")
                    .and_then(|m| m.get("stop_reason"))
                    .and_then(|x| x.as_str())
                {
                    if facts.stop_reasons.len() < 3 {
                        facts.stop_reasons.push(sr.to_string());
                    }
                }
            }
            "system" => {
                let subtype = v.get("subtype").and_then(|x| x.as_str()).unwrap_or("");
                if matches!(subtype, "error" | "permission_error" | "auth_error") {
                    facts.errors += 1;
                }
            }
            "error" => facts.errors += 1,
            _ => {}
        }
    }

    let truncated = read_lines >= MAX_LINES;
    let objective = facts
        .summary_leaves
        .iter()
        .find(|(s, _)| s == "task")
        .or_else(|| facts.summary_leaves.iter().find(|(s, _)| s == "result"))
        .or_else(|| facts.summary_leaves.first())
        .map(|(_, t)| truncate(t, MAX_SNIPPET_LEN));
    let message_snippet = facts
        .user_texts
        .back()
        .or(facts.assistant_text.as_ref())
        .map(|t| truncate(t, MAX_SNIPPET_LEN));
    let end_reason = Some(if facts.stop_reasons.iter().any(|s| s == "max_tokens") {
        "session hit the model's usage limit (max_tokens)".to_string()
    } else if facts.errors > 0 {
        format!("session ended with {} error(s)", facts.errors)
    } else if truncated {
        "transcript truncated (very long session)".to_string()
    } else {
        "session ended".to_string()
    });

    let last_updated = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Ok(TranscriptContext {
        objective,
        message_snippet,
        files_touched: facts.files,
        commands_run: facts.commands,
        errors: facts.errors,
        end_reason,
        last_updated,
        source: Some(path.display().to_string()),
    })
}

fn extract_user_text(v: &serde_json::Value) -> Option<String> {
    let msg = v.get("message")?;
    match msg.get("content") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Array(arr)) => {
            let mut out = String::new();
            for part in arr {
                if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                    out.push_str(t);
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        _ => msg
            .get("content")
            .and_then(|c| c.as_str())
            .map(String::from),
    }
}

fn extract_assistant(v: &serde_json::Value) -> (Option<String>, Vec<(String, serde_json::Value)>) {
    let mut text: Option<String> = None;
    let mut tools = Vec::new();
    let content = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array());
    if let Some(arr) = content {
        for part in arr {
            if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                text = Some(match text {
                    Some(mut s) => {
                        s.push_str(t);
                        s
                    }
                    None => t.to_string(),
                });
            }
            if let Some(name) = part.get("name").and_then(|x| x.as_str()) {
                if let Some(input) = part.get("input") {
                    tools.push((name.to_lowercase(), input.clone()));
                }
            }
        }
    }
    (text, tools)
}

fn push_fact(list: &mut Vec<String>, value: &str) {
    let value = value.trim().to_string();
    if value.is_empty() || list.contains(&value) || list.len() >= MAX_FACTS {
        return;
    }
    list.push(value);
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// Load the newest transcript for `project_root`, cached by (path, mtime)
/// so repeated handoff builds don't re-parse a large file. Returns `None`
/// when there is no usable transcript (failover degrades gracefully).
pub fn load_for(project_root: &Path) -> Option<TranscriptContext> {
    let dir = projects_dir()?;
    let path = find_newest_for(&dir, project_root)?;
    let key = {
        let meta = std::fs::metadata(&path).ok()?;
        let mtime = meta.modified().ok()?;
        let m = mtime.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
        format!("{}:{}", path.display(), m.as_nanos())
    };
    {
        let cache = CACHE.lock().unwrap();
        if let Some((k, ctx)) = cache.as_ref() {
            if k == &key {
                return Some(ctx.clone());
            }
        }
    }
    let ctx = parse_transcript(&path).ok()?;
    let mut cache = CACHE.lock().unwrap();
    *cache = Some((key, ctx.clone()));
    Some(ctx)
}

static CACHE: Mutex<Option<(String, TranscriptContext)>> = Mutex::new(None);

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn munge_path_matches_claude_code_folders() {
        assert_eq!(
            munge_path(Path::new("/home/me/my project")),
            "-home-me-my-project"
        );
        assert_eq!(
            munge_path(Path::new("C:\\Users\\me\\proj")),
            "C-Users-me-proj"
        );
        assert_eq!(munge_path(Path::new("relative/path")), "relative-path");
    }

    #[test]
    fn parses_an_objective_plan_and_tools() {
        let dir = std::env::temp_dir().join(format!("lexsus-transcript-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(
            f,
            r#"{{"type":"session_start","cwd":"/work/app","session_id":"s1"}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"user","message":{{"role":"user","content":"implement the auth flow"}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"summary","summary":[{{"leaf":"Implement auth flow","subtype":"task"}},{{"leaf":"login form designed","subtype":"result"}}]}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","name":"Read","input":{{"file_path":"src/auth.rs"}}}},{{"type":"tool_use","name":"Write","input":{{"file_path":"src/login.rs","content":"x"}}}},{{"type":"tool_use","name":"Bash","input":{{"command":"cargo test"}}}}]}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"auth done"}}],"stop_reason":"max_tokens"}}}}"#
        )
        .unwrap();

        let ctx = parse_transcript(&path).unwrap();
        assert_eq!(ctx.objective.as_deref(), Some("Implement auth flow"));
        assert_eq!(
            ctx.message_snippet.as_deref(),
            Some("implement the auth flow")
        );
        assert!(ctx.files_touched.iter().any(|f| f == "src/login.rs"));
        assert!(ctx.commands_run.iter().any(|c| c == "cargo test"));
        assert!(ctx.errors == 0);
        assert!(ctx.end_reason.as_deref().unwrap().contains("usage limit"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tolerant_of_garbage_lines() {
        let dir = std::env::temp_dir().join(format!("lexsus-tx-garbage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        std::fs::write(
            &path,
            "not json\n{broken\n{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n",
        )
        .unwrap();
        let ctx = parse_transcript(&path).unwrap();
        assert_eq!(ctx.message_snippet.as_deref(), Some("hi"));
        assert!(ctx.end_reason.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn finds_newest_transcript_by_munged_dir() {
        let dir = std::env::temp_dir().join(format!("lexsus-tx-find-{}", std::process::id()));
        let proj = dir.join(munge_path(&dir.join("sample")));
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("old.jsonl"), "").unwrap();
        std::fs::write(proj.join("new.jsonl"), "").unwrap();
        let found = find_newest_for(&dir, &dir.join("sample")).unwrap();
        assert_eq!(found.file_name().unwrap(), "new.jsonl");
        std::fs::remove_dir_all(&dir).ok();
    }
}
