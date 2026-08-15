# Product Architecture

The system connects your local coding work to **web AIs** (ChatGPT, Claude.ai, Gemini). It captures real project state while you work locally, and when your local agent is interrupted, it turns a web AI into a **working coding agent** on your machine — with real read, write, and terminal access.

There are two bridges:
- **Bridge A — Local Agent Capture:** observes Claude Code running locally (PTY) to capture the real state of your work.
- **Bridge B — Web AI Coding-Agent Bridge:** lets a web AI act on your local machine through a browser extension + local IPC tool relay.

## The Four Layers (State Capture → Delivery)

| Layer | Purpose | What it stores / does |
|-------|---------|-----------------------|
| 1. Session Archive | Raw capture | Claude Code session stdin/stdout, timestamps, exit codes; project file/git/terminal events |
| 2. Structured Project Memory | Facts, not chat | Objective, decisions, failed attempts, constraints, changed files, progress |
| 3. Context Compression | Make state handoff-sized | LLM-summarized snapshot sized for a fresh web AI's context window |
| 4. Handoff Engine | Translate + deliver | Formats Layer 3 into a web-AI prompt and establishes the coding-agent bridge |

## Layer Details

### 1. Session Archive

The lowest-level capture. Every keystroke, command, and output from the local agent (Claude Code) is recorded to SQLite with timestamps and exit codes, alongside filesystem and git events. This is the raw, lossless record.

### 2. Structured Project Memory

The archive is interpreted into structured facts — the objective, decisions, failed attempts, constraints, changed files, and progress. This is "facts, not chat", cross-checked against the filesystem watcher and Git so it reflects real state, not an AI's self-report.

### 3. Context Compression

The structured state is summarized by an LLM into a snapshot sized to fit a fresh web AI's context window, so a web AI can pick up the work without reading the full session history.

### 4. Handoff Engine

The compressed snapshot is formatted into a web-AI-specific handoff prompt and, via the browser extension, delivered as the opening context. The bridge then relays the web AI's tool calls (read/write/run) to the local Rust core for execution, and returns results back into the web chat.

## Data Flow

1. Claude Code works on the project → the bridge captures state (Layer 1, cross-checked to Layer 2).
2. On interruption, Layer 3 compresses the state into a handoff.
3. Layer 4 formats it for the chosen web AI and, via the extension, starts a session with the handoff as opening context.
4. The web AI acts as a coding agent through local tool execution (`read_file`, `write_file`, `run_command`), with every action shown in the live activity trace and grounded against the real local project.

## The Technical Opportunity

Different web AIs have different context limits, tool-format expectations, and behaviors. A simple conversation copy is not enough. The opportunity is a **translation + execution layer** that converts local state into a useful task representation a web AI can act on, grounded against the real local project — turning any web chat into a real coding agent on the user's machine.
