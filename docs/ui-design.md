# UI Design — The Desktop Control Center

The desktop app is the **control center** — one place where you see everything happening to your work. It combines a live activity trace, an interactive terminal pane, and a full git workflow, all correlated in a single timeline.

## Control Center Layout

```
┌────────────────────────────────────────────────────────────┐
│  SIDEBAR      │  MAIN PANEL                                │
│               │  ┌──────────────────────────────────────┐  │
│  Projects     │  │  LIVE ACTIVITY TRACE                 │  │
│   • myapp  ▸  │  │  ▾ Refactor auth (Claude Code)       │  │
│               │  │      Reading auth.ts                 │  │
│  Sessions     │  │      ✏ Editing auth.ts [3 lines]     │  │
│   • #12 ▸     │  │      ▾ Running: npm test             │  │
│   • #11 ▸     │  └──────────────────────────────────────┘  │
│               │  ┌──────────────────────────────────────┐  │
│  Git          │  │  TERMINAL PANE                       │  │
│   • status    │  │  $ npm test                          │  │
│   • diff      │  │  PASS auth.test.ts                   │  │
│   • branch    │  └──────────────────────────────────────┘  │
│   • commit    │                                            │
│               │  STATUS BAR: ● Claude Code · running · 64% │
└───────────────┴────────────────────────────────────────────┘
```

- **Sidebar:** Projects, Sessions, Git.
- **Live Activity Trace:** real-time tree of every action.
- **Terminal Pane:** interactive — see live output and type.
- **Status Bar:** current agent, session state, watcher status, compression-service status.

## Live Activity Trace

As the agent (local or web AI) works, every observed action becomes a node in a live step tree.

```
▾ Session: Refactor auth (Claude Code)
        Reading auth.ts
        Reading db/schema.sql
    ✏   Editing auth.ts           [3 lines changed]
    ▾     Running: npm test
        ❌ 2 failing — auth.test.ts
    ✏   Editing auth.test.ts
    ▾     Running: npm test
        ✅ All passing
```

Each line is derived from two correlated signals:

1. **Parsed PTY / tool-call output** — what command ran, what file path appeared
2. **Independent filesystem watcher** — confirming a file's mtime actually changed

Cross-referencing both avoids showing "wrote a file" when the agent merely printed a code block without saving.

## Headroom — Collapsing Process, Maximizing Outcome

The core UX problem: a long session generates far more step-detail than a user wants visible at once, but the summary/outcome should always stay prominent.

### Headroom Pattern

- **Default collapsed state** — only the current/most recent 2–3 steps are expanded; older steps auto-collapse into a single summarized line ("12 earlier steps — 6 files touched, 1 error resolved").
- **Reserved space for outcome** — the process trace occupies a shrinking, scrollable region at the top; the live "what's happening now" line and eventual handoff summary always keep guaranteed space at the bottom.
- **Auto-promotion on interruption** — the same step data collapses directly into the handoff card ("64% progress, 8 files changed, 3 errors remaining") — nothing is re-derived.
- **Expand-on-demand** — clicking any collapsed group re-expands its steps, useful for debugging without cluttering normal operation.

## Git Panel (full git workflow from the app)

- **Status:** working-tree changes, staged vs unstaged.
- **Diff:** see exactly what changed in each file (inline, colored).
- **Stage/Unstage:** stage files or hunks with a click.
- **Branch:** view branches, switch branches, see current branch.
- **History:** browse commit history, view past commits/diffs.
- **Commit from the app:** write a commit message, preview staged changes, click **Commit** (via `git2`); optional push.

## Interactive Terminal Pane

- See **live command output** for anything the agent runs.
- **Type directly into it** — run your own commands, answer prompts, or take over a hanging process.
- Everything in the terminal is correlated into the unified timeline with the activity trace.

## Web AI Activity View

When a web AI is acting as a coding agent (via the bridge), the control center shows what it is doing *with your machine* — like ChatGPT's `> thinking` view, but grounded to real operations:

- "ChatGPT read auth.ts"
- "ChatGPT wrote auth.ts"
- "ChatGPT ran npm test → 2 failing"

These appear in the activity trace, the real output appears in the terminal pane, and the resulting changes appear in the git panel — where you can commit them from the app.
