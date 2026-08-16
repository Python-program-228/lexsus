//! Activity parser (M1.4): turns the raw PTY text stream into structured
//! trace steps — "Reading file: x", "Editing file: x", "Running: cmd",
//! test results, errors — so the live activity trace can show *what the
//! agent is doing* without sending megabytes of terminal text to the UI.
//!
//! The parser taps the same decoded stream the terminal pane renders; it
//! must never break the terminal, so `feed` is total (no panics, no
//! Result) and keeps only a bounded buffer of incomplete lines.

use std::time::{SystemTime, UNIX_EPOCH};

/// A single observed agent action.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TraceStep {
    pub kind: String, // reading | editing | running | test | error
    pub file: Option<String>,
    pub command: Option<String>,
    pub detail: Option<String>,
    pub ts: u64, // unix millis
}

const MAX_BUFFER: usize = 64 * 1024;

/// Streaming line parser. Feed decoded text; get completed steps back.
#[derive(Default)]
pub struct Parser {
    buffer: String,
}

impl Parser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of decoded terminal text; returns steps recognized in
    /// complete lines. Incomplete tail lines are kept for the next chunk.
    pub fn feed(&mut self, chunk: &str) -> Vec<TraceStep> {
        self.buffer.push_str(chunk);
        if self.buffer.len() > MAX_BUFFER {
            let cut = self.buffer.len() - MAX_BUFFER;
            self.buffer.drain(..cut);
        }

        let mut steps = Vec::new();
        while let Some(idx) = self.buffer.find('\n') {
            let line: String = self.buffer.drain(..=idx).collect();
            let line = strip_ansi(&line).trim().to_string();
            if let Some(step) = parse_line(&line) {
                steps.push(step);
            }
        }
        steps
    }
}

/// Strip ANSI escape sequences (CSI, OSC, single-char ESC codes).
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() || n == '@' || n == '~' {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                for n in chars.by_ref() {
                    if n == '\x07' || n == '\u{9c}' {
                        break;
                    }
                }
            }
            _ => {
                let _ = chars.next();
            }
        }
    }
    out
}

fn parse_line(line: &str) -> Option<TraceStep> {
    if line.is_empty() {
        return None;
    }
    let ts = now_millis();

    for (needle, kind) in [
        ("reading file:", "reading"),
        ("editing file:", "editing"),
        ("writing file:", "editing"),
        ("running:", "running"),
    ] {
        let lower = line.to_lowercase();
        if let Some(pos) = lower.find(needle) {
            let arg = line[pos + needle.len()..]
                .trim()
                .trim_matches(['\'', '"', '`'])
                .to_string();
            if arg.is_empty() {
                return None;
            }
            return Some(match kind {
                "reading" | "editing" => TraceStep {
                    kind: kind.to_string(),
                    file: Some(arg),
                    command: None,
                    detail: None,
                    ts,
                },
                _ => TraceStep {
                    kind: kind.to_string(),
                    file: None,
                    command: Some(arg),
                    detail: None,
                    ts,
                },
            });
        }
    }

    let lower = line.to_lowercase();
    if lower.contains("failing") || lower.contains("passed") || lower.contains("passing") {
        return Some(TraceStep {
            kind: "test".to_string(),
            file: None,
            command: None,
            detail: Some(line.to_string()),
            ts,
        });
    }
    if lower.starts_with("error") || lower.starts_with("✖") {
        return Some(TraceStep {
            kind: "error".to_string(),
            file: None,
            command: None,
            detail: Some(line.to_string()),
            ts,
        });
    }
    None
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_code_patterns() {
        let mut p = Parser::new();
        let steps =
            p.feed("Reading file: src/auth.ts\nEditing file: src/auth.ts\nRunning: npm test\n");
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].kind, "reading");
        assert_eq!(steps[0].file.as_deref(), Some("src/auth.ts"));
        assert_eq!(steps[1].kind, "editing");
        assert_eq!(steps[2].kind, "running");
        assert_eq!(steps[2].command.as_deref(), Some("npm test"));
    }

    #[test]
    fn strips_ansi_before_matching() {
        let mut p = Parser::new();
        let steps = p.feed("\x1b[38;5;208m⏺ Reading file: \x1b[1ma.ts\x1b[0m\n");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].kind, "reading");
        assert_eq!(steps[0].file.as_deref(), Some("a.ts"));
    }

    #[test]
    fn recognizes_test_and_error_lines() {
        let mut p = Parser::new();
        let steps = p.feed("✖ 2 failing — auth.test.ts\n✔ 12 passing\nError: boom\n");
        assert_eq!(steps[0].kind, "test"); // test failure, not an agent error
        assert_eq!(steps[1].kind, "test");
        assert_eq!(steps[2].kind, "error");
    }

    #[test]
    fn ignores_plain_output_and_spans_chunks() {
        let mut p = Parser::new();
        assert!(p.feed("PASS auth.test.ts (12ms)\n").is_empty());
        // half a line in one chunk, rest in the next
        assert!(p.feed("Running: npm ").is_empty());
        let steps = p.feed("test --watch\n");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].command.as_deref(), Some("npm test --watch"));
    }
}
