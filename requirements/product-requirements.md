# Product Requirements

## Vision

A local-first desktop app that lets a developer's in-progress AI coding session survive interruption — usage limits, crashes, provider outages, or a deliberate switch — by capturing real project state and handing the task to another agent.

## Core Value Proposition

"When your AI session is interrupted, your work continues — without re-explaining the project."

## Functional Requirements

### 1. Session Capture
- FR-1.1: Capture every PTY session's stdin/stdout with timestamps and exit codes.
- FR-1.2: Store captured sessions in embedded SQLite (Layer 1 — Session Archive).

### 2. Project State Memory
- FR-2.1: Extract structured facts from sessions: objective, decisions, failed attempts, constraints, changed files.
- FR-2.2: Store structured memory in SQLite (Layer 2 — Structured Project Memory).

### 3. Context Compression
- FR-3.1: Compress structured state into a snapshot sized for a fresh agent's context window via local LLM microservice (Layer 3).

### 4. Handoff
- FR-4.1: Format compressed state into a provider-specific prompt (Layer 4).
- FR-4.2: Launch the next agent with the handoff context as its opening input.

### 5. Live Activity Trace
- FR-5.1: Render observed actions as a live, collapsible step tree.
- FR-5.2: Cross-reference parsed PTY output with filesystem watcher mtime to only report real file changes.

### 6. Interruption & Continuation
- FR-6.1: Support manual interruption trigger producing a handoff card.
- FR-6.2: Support "Continue with [another agent]" to launch the second agent.

## Non-Functional Requirements

- NFR-1: **Local-first** — no data leaves the machine; SQLite only.
- NFR-2: **Security** — minimal attack surface; one systems language (Rust); handle source code, git history, and secrets carefully.
- NFR-3: **Reliability** — interruptions (crashes, provider outages) must not lose captured project state.

## Constraints

- Must be compatible with CLI agents: Claude Code, Codex CLI, Gemini CLI.
- OS-native file watchers: fsevents / inotify / ReadDirectoryChangesW.
