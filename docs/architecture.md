# Product Architecture

Four layers, from raw capture to delivered handoff:

| Layer | Purpose | What it stores / does |
|-------|---------|-----------------------|
| 1. Session Archive | Raw capture | Every PTY session's stdin/stdout, timestamps, exit codes |
| 2. Structured Project Memory | Facts, not chat | Objective, decisions, failed attempts, constraints, changed files |
| 3. Context Compression | Make state handoff-sized | LLM-summarized snapshot of Layer 2, sized for a fresh agent's context window |
| 4. Handoff Engine | Translate + deliver | Formats Layer 3 into a provider-specific prompt and re-launches the next agent |

## Layer Details

### 1. Session Archive

The lowest-level capture. Every keystroke, command, and output from the wrapped CLI agent is recorded to SQLite with timestamps and exit codes. This is the raw, lossless record.

### 2. Structured Project Memory

The archive is interpreted into structured facts — what the objective was, which decisions were made, what failed, what constraints exist, and which files changed. This is "facts, not chat".

### 3. Context Compression

The structured state is summarized by an LLM into a snapshot sized to fit a fresh agent's context window, so a new agent can pick up the work without reading the full session history.

### 4. Handoff Engine

The compressed snapshot is formatted into a provider-specific prompt for the target agent (e.g. Codex CLI, Gemini CLI) and the next agent is launched with that prompt as its opening input.
