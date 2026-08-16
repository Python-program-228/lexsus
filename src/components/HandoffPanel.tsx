import { useEffect, useState } from "react";
import {
  buildHandoff,
  handoffSend,
  setObjective,
} from "../lib/bridge";
import type { Handoff } from "../lib/types";

/** Handoff card (M2): build real state → "Continue with ChatGPT".
 *  Sends the payload to the paired extension (which renders it on
 *  chatgpt.com); falls back to clipboard copy. */
export default function HandoffPanel() {
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [objective, setObj] = useState("");
  const [status, setStatus] = useState("");
  const [built, setBuilt] = useState(false);

  async function build() {
    const h = await buildHandoff();
    setHandoff(h);
    setObj(h.objective);
    setBuilt(true);
  }

  async function continueWithChatGPT() {
    if (!handoff) return;
    await setObjective(objective).catch(() => {});
    const h = await handoffSend();
    setStatus(
      h.generated_at
        ? "handoff sent to the extension — open chatgpt.com"
        : "",
    );
    await navigator.clipboard.writeText(handoffText(h)).catch(() => {});
    setStatus("handoff sent to the extension (also copied to clipboard)");
  }

  function handoffText(h: Handoff): string {
    return [
      `# Continue this task (AI Continuity Bridge handoff)`,
      ``,
      `Objective: ${h.objective}`,
      `Progress: ${h.progress_percent}% · Files changed: ${h.files_changed} · Errors remaining: ${h.errors_remaining}`,
      `Next step: ${h.next_step ?? "review state"}`,
      h.files.length > 0 ? `Files involved: ${h.files.join(", ")}` : "",
      ``,
      `You are now the coding agent for the local project at the paired machine.`,
      `You may request file reads, file writes, and command runs; the bridge executes them locally and returns real results.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  useEffect(() => {
    void build();
  }, []);

  return (
    <section className="panel handoff-panel">
      <header className="panel-head">
        <h3>Handoff → ChatGPT</h3>
        <span className="muted">built from real trace + watcher state</span>
      </header>
      {handoff ? (
        <div className="handoff-card">
          <div className="handoff-row">
            <label>Objective</label>
            <input value={objective} onChange={(e) => setObj(e.currentTarget.value)} />
          </div>
          <div className="handoff-stats">
            <span>
              <b>{handoff.progress_percent}%</b> progress
            </span>
            <span>
              <b>{handoff.files_changed}</b> files changed
            </span>
            <span>
              <b>{handoff.errors_remaining}</b> errors remaining
            </span>
          </div>
          {handoff.next_step && (
            <p className="muted">next step: {handoff.next_step}</p>
          )}
          <div className="handoff-actions">
            <button onClick={continueWithChatGPT}>Continue with ChatGPT</button>
            <button onClick={() => void navigator.clipboard.writeText(handoffText(handoff!))}>
              Copy handoff
            </button>
            <button onClick={() => void build()}>Rebuild</button>
          </div>
          {status && <p className="muted">{status}</p>}
          {built && !handoff?.files_changed && (
            <p className="muted">
              tip: run a Claude Code session first — the card is built from what it did
            </p>
          )}
        </div>
      ) : (
        <p className="muted">building…</p>
      )}
    </section>
  );
}