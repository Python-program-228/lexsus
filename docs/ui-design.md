# UI Design — The Live Activity Trace

As the wrapped agent runs, every observed action becomes a node in a live step tree — visually similar to the collapsible tool-use blocks in Claude.ai's interface or Claude Code's own terminal output.

## Step Tree Example

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

1. **Parsed PTY output** — what command ran, what file path appeared
2. **Independent filesystem watcher** — confirming a file's mtime actually changed

Cross-referencing both avoids showing "wrote a file" when the agent merely printed a code block without saving.

## Headroom — Collapsing Process, Maximizing Outcome

The core UX problem: a long agent session generates far more step-detail than a user wants visible at once, but the summary/outcome should always stay prominent.

### Headroom Pattern

- **Default collapsed state** — only the current/most recent 2–3 steps are expanded; older steps auto-collapse into a single summarized line ("12 earlier steps — 6 files touched, 1 error resolved").
- **Reserved space for outcome** — the process trace occupies a shrinking, scrollable region at the top; the live "what's happening now" line and eventual handoff summary always keep guaranteed space at the bottom.
- **Auto-promotion on interruption** — the same step data collapses directly into the handoff card ("64% progress, 8 files changed, 3 errors remaining") — nothing is re-derived.
- **Expand-on-demand** — clicking any collapsed group re-expands its steps, useful for debugging without cluttering normal operation.
