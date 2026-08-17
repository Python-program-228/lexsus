import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { SquareTerminalIcon } from "lucide-react";
import type { TerminalRunEvent } from "../lib/types";
import { cn } from "../lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

const TERMINAL_THEME = {
  background: "#0d0d0d",
  foreground: "#e6e6e6",
};

/**
 * Read-only command terminal: streams every `run_command` the web AI
 * executes (command header, live output, exit status) into an xterm.js
 * pane. The user watches; approval cards are the control point.
 */
export default function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      cursorBlink: false,
      theme: TERMINAL_THEME,
    });
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
        term.write(`\r\n\x1b[32m$ ${event.command}\x1b[0m\r\n`);
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
    };
  }, []);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SquareTerminalIcon className="size-4 shrink-0 text-muted-foreground" />
          Terminal
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-2 rounded-full",
                running
                  ? "animate-pulse bg-emerald-500"
                  : "bg-zinc-700",
              )}
            />
            <span className="text-xs font-normal text-muted-foreground">
              {running ? "web AI running a command" : "idle"}
            </span>
          </span>
        </CardTitle>
        <CardDescription>
          live output of the commands the web AI runs in this project
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col px-3 pb-3">
        <div className="min-h-[340px] flex-1 overflow-hidden rounded-lg border border-border/60 bg-[#0d0d0d]">
          <div ref={containerRef} className="h-full w-full p-2" />
        </div>
      </CardContent>
    </Card>
  );
}