import { useEffect, useState } from "react";
import {
  gitBranch,
  gitCommit,
  gitStatus,
  initDatabase,
  runCommand,
  setProjectRoot,
  shellWrite,
  spawnShell,
  startWatch,
} from "./lib/bridge";
import type { CommandOutput, GitFileStatus } from "./lib/types";

/** A minimal "control center" shell demonstrating the Phase 0 Rust core. */
export default function App() {
  const [status, setStatus] = useState<GitFileStatus[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [output, setOutput] = useState<CommandOutput | null>(null);
  const [cmd, setCmd] = useState("git status");
  const [commitMsg, setCommitMsg] = useState("");
  const [commitResult, setCommitResult] = useState("");
  const [error, setError] = useState("");

  const [dbPath, setDbPath] = useState("aicb.sqlite");
  const [rootPath, setRootPath] = useState(".");
  const [initMsg, setInitMsg] = useState("");
  const [shellInput, setShellInput] = useState("");
  const [shellMsg, setShellMsg] = useState("");

  async function refreshGit() {
    try {
      setStatus(await gitStatus());
      setBranch(await gitBranch());
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function onInit() {
    try {
      const versions = await initDatabase(dbPath);
      setInitMsg(`db ready (${versions.join(", ")})`);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function onSetRoot() {
    try {
      await setProjectRoot(rootPath);
      setInitMsg(`root set: ${rootPath}`);
      setError("");
      await refreshGit();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRunCommand() {
    try {
      setOutput(await runCommand(cmd));
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function onCommit() {
    try {
      const oid = await gitCommit(commitMsg);
      setCommitResult(`committed ${oid}`);
      setCommitMsg("");
      await refreshGit();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onStartWatch() {
    try {
      await startWatch();
      setInitMsg("watching project folder");
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function onSpawnShell() {
    try {
      setShellMsg(await spawnShell());
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function onShellWrite() {
    try {
      await shellWrite(shellInput);
      setShellMsg(`sent: ${shellInput}`);
      setShellInput("");
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    onInit();
    onSetRoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <h2>Bridge</h2>
        <nav>
          <span>Projects</span>
          <span>Sessions</span>
          <span>Git</span>
        </nav>
      </aside>

      <main className="main">
        <header className="statusbar">
          <span className="dot" /> Control Center · branch:{" "}
          <b>{branch ?? "n/a"}</b>
        </header>

        {error && <pre className="error">{error}</pre>}
        {initMsg && <p className="ok">{initMsg}</p>}

        <section className="panel">
          <h3>Setup</h3>
          <div className="term-row">
            <label>DB path</label>
            <input
              value={dbPath}
              onChange={(e) => setDbPath(e.currentTarget.value)}
            />
            <button onClick={onInit}>Init DB</button>
          </div>
          <div className="term-row">
            <label>Project root</label>
            <input
              value={rootPath}
              onChange={(e) => setRootPath(e.currentTarget.value)}
            />
            <button onClick={onSetRoot}>Set root</button>
            <button onClick={onStartWatch}>Watch</button>
          </div>
        </section>

        <section className="panel">
          <h3>Git status</h3>
          <button onClick={refreshGit}>Refresh</button>
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Status</th>
                <th>+/-</th>
              </tr>
            </thead>
            <tbody>
              {status.map((s) => (
                <tr key={s.path}>
                  <td>{s.path}</td>
                  <td>{s.status}</td>
                  <td>
                    +{s.additions}/-{s.deletions}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h3>Commit</h3>
          <input
            value={commitMsg}
            placeholder="commit message"
            onChange={(e) => setCommitMsg(e.currentTarget.value)}
          />
          <button onClick={onCommit}>Commit</button>
          {commitResult && <p>{commitResult}</p>}
        </section>

        <section className="panel">
          <h3>Terminal</h3>
          <div className="term-row">
            <input
              value={cmd}
              onChange={(e) => setCmd(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && onRunCommand()}
            />
            <button onClick={onRunCommand}>Run</button>
          </div>
          {output && (
            <pre className="term-out">
              $ {output.command}
              {"\n"}
              {output.output}
              {"\n"}exit: {String(output.exit_code)}
            </pre>
          )}
        </section>

        <section className="panel">
          <h3>Interactive shell</h3>
          <button onClick={onSpawnShell}>Spawn shell</button>
          {shellMsg && <p>{shellMsg}</p>}
          <div className="term-row">
            <input
              value={shellInput}
              placeholder="input to the running shell"
              onChange={(e) => setShellInput(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && onShellWrite()}
            />
            <button onClick={onShellWrite}>Send</button>
          </div>
        </section>
      </main>
    </div>
  );
}
