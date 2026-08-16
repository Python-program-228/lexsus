import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { claudeSpawn, ptyKill, ptyResize, ptySpawn, ptyWrite } from "../lib/bridge";
import type { PtyExit, PtyOverflow, PtyOutput, PtySpawned } from "../lib/types";

interface TerminalPaneProps {
  cwd: string;
}

type Mode = "shell" | "claude";

/**
 * Interactive terminal pane (M1.2 + M1.3): an xterm.js instance fed by
 * the raw PTY byte stream (pty://output) and typing straight into the
 * session's stdin (pty_write). xterm sends `\r` for Enter — exactly what
 * cmd / PowerShell under ConPTY expect. "Claude Code" mode spawns the
 * claude CLI in the same session.
 */
export default function TerminalPane({ cwd }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [session, setSession] = useState<PtySpawned | null>(null);
  const [state, setState] = useState<"idle" | "running" | "exited">("idle");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [dropped, setDropped] = useState(0);
  const [mode, setMode] = useState<Mode>("shell");
  const resizeTimer = useRef<number | undefined>(undefined);
  const modeRef = useRef<Mode>("shell");

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      cursorBlink: true,
      theme: { background: "#0d0d0d", foreground: "#e6e6e6" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;

    term.onData((data) => {
      ptyWrite(data).catch(() => {});
    });
    term.onResize(({ rows, cols }) => {
      window.clearTimeout(resizeTimer.current);
      resizeTimer.current = window.setTimeout(() => {
        ptyResize(rows, cols).catch(() => {});
      }, 80);
    });

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(container);

    let unlistens: UnlistenFn[] = [];
    let disposed = false;

    const spawn = async () => {
      try {
        const rows = term.rows ?? 24;
        const cols = term.cols ?? 80;
        const info =
          modeRef.current === "claude"
            ? await claudeSpawn(cwd, rows, cols)
            : await ptySpawn(cwd, rows, cols);
        if (disposed) return;
        term.reset();
        setSession(info);
        setState("running");
        setExitCode(null);
        setDropped(0);
      } catch (e) {
        if (disposed) return;
        term.writeln(`\r\n\x1b[31mspawn failed: ${String(e)}\x1b[0m`);
        setState("idle");
      }
    };

    void (async () => {
      unlistens = [
        await listen<PtyOutput>("pty://output", (e) => {
          if (!disposed) term.write(e.payload.data);
        }),
        await listen<PtySpawned>("pty://spawned", (e) => {
          if (disposed) return;
          setSession(e.payload);
          setState("running");
          setExitCode(null);
        }),
        await listen<PtyExit>("pty://exit", (e) => {
          if (disposed) return;
          setState("exited");
          setExitCode(e.payload.code);
          term.writeln("\r\n\x1b[90m[session ended]\x1b[0m");
        }),
        await listen<PtyOverflow>("pty://overflow", (e) => {
          if (disposed) return;
          setDropped((d) => d + e.payload.dropped);
        }),
      ];
      await spawn();
    })();

    return () => {
      disposed = true;
      for (const unlisten of unlistens) unlisten();
      ro.disconnect();
      window.clearTimeout(resizeTimer.current);
      term.dispose();
      termRef.current = null;
      void ptyKill().catch(() => {});
    };
  }, [cwd]);

  function restart() {
    termRef.current?.writeln("\r\n\x1b[90m[restarting]\x1b[0m");
    void ptyKill().catch(() => {});
    void spawnAgain();
  }

  async function spawnAgain() {
    const term = termRef.current;
    if (!term) return;
    try {
      const info = await ptySpawn(cwd, term.rows ?? 24, term.cols ?? 80);
      term.reset();
      setSession(info);
      setState("running");
      setExitCode(null);
      setDropped(0);
    } catch (e) {
      term.writeln(`\r\n\x1b[31mspawn failed: ${String(e)}\x1b[0m`);
      setState("idle");
    }
  }

  return (
    <section className="panel terminal-pane">
      <header className="term-header">
        <span className={`dot dot-${state}`} />
        <b className="term-title">Terminal</b>
        <span className="term-meta">
          {state === "idle"
            ? "no session"
            : state === "running"
              ? `${session?.shell ?? "shell"} · ${session?.cwd ?? cwd}`
              : `exited (${exitCode ?? "?"})`}
        </span>
        {dropped > 0 && (
          <span className="badge" title="PTY buffer overflowed; output was dropped">
            dropped {dropped} chunks
          </span>
        )}
        <span className="spacer" />
        <button
          className={mode === "shell" ? "mode-btn active" : "mode-btn"}
          onClick={() => setMode("shell")}
          title="plain shell session"
        >
          Shell
        </button>
        <button
          className={mode === "claude" ? "mode-btn active" : "mode-btn"}
          onClick={() => setMode("claude")}
          title="spawn Claude Code in this session"
        >
          Claude Code
        </button>
        <button onClick={restart} disabled={state === "idle"}>
          Restart
        </button>
        <button className="danger" onClick={() => ptyKill().catch(() => {})}>
          Kill
        </button>
      </header>
      <div className="term-body" ref={containerRef} />
    </section>
  );
}