# Trade-off Summary

| Decision | Chosen | Rejected | Why |
|----------|--------|----------|-----|
| Shell | Tauri | Electron | Smaller, safer; Electron acceptable if speed-to-prototype wins |
| Systems language | Rust only | Rust + C | C adds memory-safety risk with no capability gain here |
| Agent comms | PTY-wrap CLI | Raw API-only | Keeps each agent's native tool-use loop; API-only forces rebuilding it |
| Web chat support | Clipboard / extension autofill | Browser automation / DOM scraping | Automation breaks on UI redesigns — flagged 10/10 platform risk |
| State store | SQLite | Postgres / cloud DB | Local-first privacy pitch requires no data leaving the machine |
| Search | Structured queries | Vector DB | Premature at MVP scale; add only if memory volume demands it |

## Key Risks

- **Web chat support (10/10 risk)** — browser automation / DOM scraping breaks on UI redesigns. Mitigated by choosing clipboard / extension autofill.
- **Secret handling** — app touches source code, git history, and potentially credentials; requires minimal attack surface and careful secret handling.
