import { useEffect, useState } from "react";
import { getProjectRoot, setProjectRoot, startWatch } from "./lib/bridge";
import ActivityTrace from "./components/ActivityTrace";
import BridgePanel from "./components/BridgePanel";
import GitPanel from "./components/GitPanel";
import HandoffPanel from "./components/HandoffPanel";
import TerminalPane from "./components/TerminalPane";

/**
 * Control center shell (M1.2): sidebar (project root + restore),
 * statusbar, terminal pane, and the four milestone panels:
 * ActivityTrace (M1.4), GitPanel (M1.7), BridgePanel (M2), HandoffPanel (M2).
 */
export default function App() {
  const [projectRoot, setRootInput] = useState("");
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const saved = await getProjectRoot();
        if (saved) {
          setRootInput(saved);
          await startWatch();
        }
        setRestored(true);
      } catch (e) {
        setError(String(e));
        setRestored(true);
      }
    })();
  }, []);

  async function onSetProjectRoot() {
    try {
      await setProjectRoot(projectRoot);
      await startWatch();
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h2>Bridge</h2>
        <label className="side-label">Project folder</label>
        <div className="side-row">
          <input
            value={projectRoot}
            placeholder="C:\path\to\project"
            onChange={(e) => setRootInput(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && onSetProjectRoot()}
          />
          <button onClick={onSetProjectRoot}>Set</button>
        </div>
        <p className="muted side-hint">
          {restored && !projectRoot
            ? "paste the project path to unlock the terminal, trace and git"
            : projectRoot
              ? `project: ${projectRoot}`
              : "…"}
        </p>
      </aside>

      <main className="main">
        <header className="statusbar">
          <span className="dot" /> Control Center ·{" "}
          {projectRoot ? <b>{projectRoot}</b> : <span className="muted">no project</span>}
        </header>

        {error && <pre className="error">{error}</pre>}

        <div className="grid">
          <div className="col">
            {projectRoot ? (
              <TerminalPane cwd={projectRoot} />
            ) : (
              <section className="panel">
                <h3>Terminal</h3>
                <p className="muted">
                  Set a project folder in the sidebar to start the interactive
                  terminal.
                </p>
              </section>
            )}
            <ActivityTrace />
          </div>
          <div className="col">
            <GitPanel />
            <BridgePanel />
            <HandoffPanel />
          </div>
        </div>
      </main>
    </div>
  );
}