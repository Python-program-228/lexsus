import { useCallback, useEffect, useState } from "react";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCommitDiff,
  gitDiff,
  gitLog,
  gitStage,
  gitStageAll,
  gitUnstage,
} from "../lib/bridge";
import type { BranchInfo, CommitInfo, FileDiff } from "../lib/types";

type Tab = "status" | "branch" | "history";

/** Full git workflow from the app (M1.7): status + stage/unstage + diff,
 *  branch switching, history, and commit — all via git2. */
export default function GitPanel() {
  const [tab, setTab] = useState<Tab>("status");
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [history, setHistory] = useState<CommitInfo[]>([]);
  const [commitDiff, setCommitDiff] = useState("");
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setDiffs(await gitDiff());
      setBranches(await gitBranches());
      setHistory(await gitLog(30));
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function stage(path: string) {
    await gitStage(path).catch((e) => setError(String(e)));
    await refresh();
  }
  async function unstage(path: string) {
    await gitUnstage(path).catch((e) => setError(String(e)));
    await refresh();
  }
  async function stageAll() {
    await gitStageAll().catch((e) => setError(String(e)));
    await refresh();
  }
  async function checkout(name: string) {
    await gitCheckout(name).catch((e) => setError(String(e)));
    await refresh();
  }
  async function commit() {
    try {
      const oid = await gitCommit(message);
      setResult(`committed ${oid.slice(0, 8)}`);
      setMessage("");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }
  async function showCommit(oid: string) {
    setSelectedCommit(oid);
    setCommitDiff(await gitCommitDiff(oid).catch((e) => `error: ${e}`));
  }

  const shown = diffs.filter((d) => !selected || d.path === selected);
  const selectedDiff = diffs.find((d) => d.path === selected);

  return (
    <section className="panel git-panel">
      <header className="panel-head">
        <h3>Git</h3>
        <nav className="tabs">
          <button className={tab === "status" ? "active" : ""} onClick={() => setTab("status")}>
            Status
          </button>
          <button className={tab === "branch" ? "active" : ""} onClick={() => setTab("branch")}>
            Branch
          </button>
          <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
            History
          </button>
        </nav>
        {error && <span className="error-inline">{error}</span>}
      </header>

      {tab === "status" && (
        <div className="git-status">
          <div className="toolbar">
            <button onClick={stageAll}>Stage all</button>
            <button onClick={refresh}>Refresh</button>
            {selected && (
              <button onClick={() => setSelected(null)}>show all files</button>
            )}
            {result && <span className="muted">{result}</span>}
          </div>
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Status</th>
                <th>+/-</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {diffs.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    working tree clean
                  </td>
                </tr>
              )}
              {shown.map((d) => (
                <tr
                  key={d.path}
                  className={selected === d.path ? "row-selected" : ""}
                  onClick={() => setSelected(d.path)}
                >
                  <td>{d.path}</td>
                  <td>
                    <span className={`status-badge status-${d.status}`}>{d.status}</span>
                  </td>
                  <td>
                    +{d.added}/-{d.deleted}
                  </td>
                  <td>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void stage(d.path);
                      }}
                    >
                      Stage
                    </button>{" "}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void unstage(d.path);
                      }}
                    >
                      Unstage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {selectedDiff && (
            <pre className="diff-view">{selectedDiff.patch}</pre>
          )}
          <div className="commit-row">
            <input
              value={message}
              placeholder="commit message"
              onChange={(e) => setMessage(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && commit()}
            />
            <button onClick={commit}>Commit</button>
          </div>
        </div>
      )}

      {tab === "branch" && (
        <ul className="branch-list">
          {branches.map((b) => (
            <li key={b.name}>
              <span className={b.is_current ? "branch-current" : ""}>
                {b.is_current ? "● " : "○ "}
                {b.name}
              </span>
              {!b.is_current && <button onClick={() => checkout(b.name)}>Checkout</button>}
            </li>
          ))}
        </ul>
      )}

      {tab === "history" && (
        <div className="history">
          <ul className="commit-list">
            {history.map((c) => (
              <li
                key={c.oid}
                className={selectedCommit === c.oid ? "row-selected" : ""}
                onClick={() => void showCommit(c.oid)}
              >
                <span className="commit-msg">{c.message}</span>
                <span className="muted">
                  {c.oid.slice(0, 7)} · {c.author} ·{" "}
                  {new Date(c.timestamp * 1000).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
          {commitDiff && <pre className="diff-view">{commitDiff}</pre>}
        </div>
      )}
    </section>
  );
}