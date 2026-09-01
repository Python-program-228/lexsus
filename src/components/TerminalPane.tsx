import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { SquareTerminalIcon } from "lucide-react";
import type { TerminalRunEvent } from "../lib/types";
import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/utils";

/** xterm needs concrete values; these mirror the --terminal tokens. */
const TERMINAL_THEMES = {
  dark: { background: "#16171c", foreground: "#eceef2" },
  light: { background: "#fbfbf8", foreground: "#26262b" },
} as const;

/**
 * Read-only command terminal: streams every `run_command` the web AI
 * executes (command header, live output, exit status) into an xterm.js
 * pane that fills the workbench's left column. The user watches;
 * approval cards (the global banner) are the control point.
 */
export default function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [running, setRunning] = useState(false);
  const theme = useTheme();
  // The mount effect only needs the initial value — recreating the
  // terminal on toggle would lose scrollback.
  const themeRef = useRef(theme);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily:
        '"Geist Mono Variable", ui-monospace, "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      cursorBlink: false,
      theme: TERMINAL_THEMES[themeRef.current],
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    term.writeln("\x1b[90m[commands the web AI runs appear here]\x1b[0m");

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(container);

    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void listen<TerminalRunEvent>("terminal://run", (e) => {
      if (disposed) return;
      const event = e.payload;
      if (event.kind === "start") {
        term.write(`\r\n\x1b[36m$ ${event.command}\x1b[0m\r\n`);
        setRunning(true);
      } else if (event.kind === "output") {
        term.write(event.data);
      } else {
        const status = event.timed_out
          ? "timed out"
          : event.code === 0
            ? "exit 0"
            : `exit ${event.code ?? "?"}`;
        const color = event.timed_out || event.code !== 0 ? "31" : "32";
        term.write(`\r\n\x1b[90m[\x1b[${color}m${status}\x1b[0m`);
        if (event.truncated) term.write("\x1b[90m · truncated\x1b[0m");
        term.write("\x1b[90m]\x1b[0m\r\n");
        setRunning(false);
      }
    }).then((unlistenFn) => {
      if (disposed) unlistenFn();
      else unlisten = unlistenFn;
    });

    return () => {
      disposed = true;
      unlisten?.();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // xterm can't read CSS vars — swap concrete hex values when the theme flips.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = TERMINAL_THEMES[theme];
    }
  }, [theme]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <SquareTerminalIcon className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Terminal</h2>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              running ? "animate-pulse bg-success" : "bg-muted-foreground/40",
            )}
          />
          {running ? "web AI running a command" : "idle"}
        </span>
      </header>
      <div className="min-h-0 flex-1 p-2">
        <div className="h-full w-full overflow-hidden rounded-md border border-border/60 bg-terminal">
          <div ref={containerRef} className="h-full w-full p-1.5" />
        </div>
      </div>
    </section>
  );
}
