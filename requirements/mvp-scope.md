# MVP Scope — What Ships First

## In Scope

1. **Tauri desktop shell** — single monitored project folder.
2. **Rust-based file watcher + git state extraction** — OS-native watchers + git2 for diffs, status, branch/commit state.
3. **PTY wrapper for one agent: Claude Code** — spawned as a child process, handoff context injected as opening input, terminal output passively observed.
4. **SQLite-backed structured memory** — no compression service yet; raw structured state is small enough to hand off directly at MVP scale.
5. **Live activity tree UI** with headroom-collapsing behavior.
6. **Manual interruption trigger → handoff card → manual "Continue with Codex CLI"** (second PTY adapter).

## Out of Scope (for MVP)

- Compression / summarization service (Layer 3).
- Additional agents beyond Claude Code + Codex CLI.
- Team / enterprise features.
- Vector DB / search at scale.
- Browser automation / web chat support.

## Success Criterion

> A real interrupted coding task, picked up by the second agent, with the developer not having to re-explain the project.

Validate with 5–10 real developers before adding a third agent, compression service, or any team/enterprise features.
