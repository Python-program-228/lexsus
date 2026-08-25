//! Fact extraction (Layer 2): turns raw transcript context into
//! structured project memory — objective, decisions, failed attempts,
//! constraints, changed files, rough progress. Heuristics on sentence
//! markers; deliberately conservative caps so a chatty session can't
//! balloon the handoff payload.

use crate::transcript::TranscriptContext;

const MAX_DECISIONS: usize = 10;
const MAX_ATTEMPTS: usize = 8;
const MAX_CONSTRAINTS: usize = 8;
const MIN_SENTENCE_LEN: usize = 12;
const MAX_SENTENCE_LEN: usize = 240;

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ExtractedFacts {
    pub objective: Option<String>,
    pub decisions: Vec<String>,
    pub failed_attempts: Vec<String>,
    pub constraints: Vec<String>,
    pub changed_files: Vec<String>,
    pub progress_percent: u8,
}

const DECISION_MARKERS: &[&str] = &[
    "decided",
    "decision",
    "we'll go",
    "going with",
    "go with",
    "chose",
    "choosing",
    "switch to",
    "switched to",
    "switching to",
    "instead of",
    "rather than",
];

const FAILURE_MARKERS: &[&str] = &[
    "fail",
    "doesn't work",
    "does not work",
    "didn't work",
    "did not work",
    "not working",
    "still broken",
    "crash",
    "error ",
    "regression",
];

const SUCCESS_MARKERS: &[&str] = &[
    "all tests pass",
    "tests pass",
    "tests are green",
    "build succeeded",
    "build succeeds",
    "now works",
    "working now",
    "fixed by",
];

const CONSTRAINT_MARKERS: &[&str] = &[
    "must ",
    "must not",
    "should not",
    "shouldn't",
    "don't ",
    "do not",
    "never ",
    "always ",
    "make sure",
    "constraint",
    "requirement",
    "has to be",
    "needs to",
    "avoid ",
    "no new dependencies",
];

/// Extract structured facts from a parsed transcript.
pub fn extract(ctx: &TranscriptContext) -> ExtractedFacts {
    let mut sentences: Vec<String> = Vec::new();
    for ev in &ctx.events {
        if matches!(ev.kind.as_str(), "user" | "assistant") {
            push_sentences(&mut sentences, &ev.payload);
        }
    }

    let mut decisions = Vec::new();
    let mut failed_attempts = Vec::new();
    let mut constraints = Vec::new();
    for s in &sentences {
        let lower = s.to_lowercase();
        if decisions.len() < MAX_DECISIONS && has_marker(&lower, DECISION_MARKERS) {
            decisions.push(s.clone());
            continue;
        }
        if constraints.len() < MAX_CONSTRAINTS && has_marker(&lower, CONSTRAINT_MARKERS) {
            constraints.push(s.clone());
        } else if failed_attempts.len() < MAX_ATTEMPTS
            && has_marker(&lower, FAILURE_MARKERS)
            && !has_marker(&lower, SUCCESS_MARKERS)
        {
            failed_attempts.push(s.clone());
        }
    }

    // Rough progress from real activity: files written dominate, commands
    // help, errors hurt. Deterministic so repeated builds stay stable.
    let files = ctx.files_written.len().min(10);
    let cmds = ctx.commands_run.len().min(8);
    let base = if files + cmds == 0 {
        0
    } else {
        15 + files * 6 + cmds * 4
    };
    let penalty = ctx.errors.min(5) * 8;
    let progress_percent = base.saturating_sub(penalty).clamp(0, 95) as u8;

    ExtractedFacts {
        objective: ctx.objective.clone(),
        decisions,
        failed_attempts,
        constraints,
        changed_files: ctx.files_written.clone(),
        progress_percent,
    }
}

fn has_marker(lower: &str, markers: &[&str]) -> bool {
    markers.iter().any(|m| lower.contains(m))
}

fn push_sentences(out: &mut Vec<String>, text: &str) {
    for raw in text.split(['.', '!', '?', '\n']) {
        let s = raw.trim();
        let chars = s.chars().count();
        if !(MIN_SENTENCE_LEN..=MAX_SENTENCE_LEN).contains(&chars) {
            continue;
        }
        let owned = s.to_string();
        if !out.contains(&owned) {
            out.push(owned);
        }
    }
}

impl From<ExtractedFacts> for crate::db::ProjectFacts {
    fn from(f: ExtractedFacts) -> Self {
        Self {
            objective: f.objective,
            decisions: f.decisions,
            failed_attempts: f.failed_attempts,
            constraints: f.constraints,
            changed_files: f.changed_files,
            progress_percent: f.progress_percent,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::TranscriptEvent;

    fn ctx_with(events: Vec<(&str, &str)>) -> TranscriptContext {
        TranscriptContext {
            objective: Some("Implement auth flow".into()),
            files_written: vec!["src/login.rs".into(), "src/auth.rs".into()],
            commands_run: vec!["cargo test".into()],
            errors: 1,
            events: events
                .into_iter()
                .map(|(kind, payload)| TranscriptEvent {
                    ts_ms: 0,
                    kind: kind.into(),
                    payload: payload.into(),
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn extracts_decisions_failures_and_constraints() {
        let ctx = ctx_with(vec![
            (
                "assistant",
                "We decided to use argon2 for password hashing. The tests pass now.",
            ),
            ("user", "You must not touch the payments module."),
            (
                "assistant",
                "The bcrypt build failed on musl, so that attempt is abandoned.",
            ),
        ]);
        let f = extract(&ctx);
        assert!(f.decisions.iter().any(|d| d.contains("argon2")));
        assert!(f.constraints.iter().any(|c| c.contains("payments module")));
        assert!(f
            .failed_attempts
            .iter()
            .any(|a| a.contains("bcrypt build failed")));
        assert_eq!(f.objective.as_deref(), Some("Implement auth flow"));
        assert_eq!(f.changed_files.len(), 2);
    }

    #[test]
    fn success_sentences_do_not_count_as_failed_attempts() {
        let ctx = ctx_with(vec![(
            "assistant",
            "Fixed the import ordering; all tests pass now across the suite.",
        )]);
        let f = extract(&ctx);
        assert!(f.failed_attempts.is_empty());
    }

    #[test]
    fn progress_reflects_activity_and_penalizes_errors() {
        // No written files or commands at all → floor.
        assert_eq!(extract(&TranscriptContext::default()).progress_percent, 0);
        let active = TranscriptContext {
            errors: 3,
            ..ctx_with(vec![("tool", "Write x"), ("tool", "Bash y")])
        };
        let more_files = TranscriptContext {
            files_written: (0..6).map(|i| format!("f{i}.rs")).collect(),
            ..active.clone()
        };
        let fa = extract(&active);
        let fb = extract(&more_files);
        // More written work → higher progress; errors keep it below the max.
        assert!(fb.progress_percent > fa.progress_percent);
        assert!(fa.progress_percent < 95);
    }

    #[test]
    fn caps_keep_the_payload_bounded() {
        let events: Vec<TranscriptEvent> = (0..40)
            .map(|i| TranscriptEvent {
                ts_ms: 0,
                kind: "assistant".into(),
                payload: match i % 2 {
                    0 => format!("We decided to rewrite scheduler part {i} again today ok"),
                    _ => format!("Remember you must never commit secrets folder {i} ever ok"),
                },
            })
            .collect();
        let ctx = TranscriptContext {
            events,
            ..ctx_with(vec![])
        };
        let f = extract(&ctx);
        assert_eq!(f.decisions.len(), MAX_DECISIONS);
        assert_eq!(f.constraints.len(), MAX_CONSTRAINTS);
    }
}
