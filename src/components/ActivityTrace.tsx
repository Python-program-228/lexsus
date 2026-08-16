import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FsEvent, TraceStep } from "../lib/types";

interface TraceItem extends TraceStep {
  confirmed: boolean;
  id: number;
}

const ICONS: Record<string, string> = {
  reading: "📖",
  editing: "✏️",
  running: "▸",
  test: "🧪",
  error: "✖",
  fs: "📁",
};

/** Live activity trace (M1.4): parsed Claude Code steps + watcher
 *  grounding. Headroom: newest 3 expanded, older collapse into a
 *  summary line you can click to expand. */
export default function ActivityTrace() {
  const [items, setItems] = useState<TraceItem[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const idRef = useRef(0);

  useEffect(() => {
    let unlistens: UnlistenFn[] = [];
    void (async () => {
      unlistens = [
        await listen<TraceStep>("trace://step", (e) => {
          const step = e.payload;
          setItems((prev) => [
            ...prev,
            {
              ...step,
              id: ++idRef.current,
              confirmed: step.kind === "editing" ? false : step.confirmed,
            },
          ]);
        }),
        await listen<{ path: string }>("trace://confirm", (e) => {
          setItems((prev) =>
            prev.map((it) =>
              it.kind === "editing" && it.file === e.payload.path
                ? { ...it, confirmed: true }
                : it,
            ),
          );
        }),
        await listen<FsEvent>("fs://event", () => {
          setItems((prev) => [
            ...prev,
            {
              kind: "fs",
              file: null,
              command: null,
              detail: null,
              confirmed: false,
              agent: "watcher",
              ts: Date.now(),
              id: ++idRef.current,
            },
          ]);
        }),
      ];
    })();
    return () => {
      for (const u of unlistens) u();
    };
  }, []);

  // Keep the list bounded (last 500).
  const visible = items.slice(-500);
  const expanded = collapsed ? visible.slice(-3) : visible;
  const earlier = visible.slice(0, Math.max(0, visible.length - 3));

  function renderItem(it: TraceItem) {
    const icon = ICONS[it.kind] ?? "•";
    const label =
      it.kind === "fs"
        ? "file changed on disk"
        : it.kind === "test" || it.kind === "error"
          ? (it.detail ?? "")
          : it.file ?? it.command ?? "";
    return (
      <li key={it.id} className={`trace-item trace-${it.kind}`}>
        <span className="trace-icon">{icon}</span>
        <span className="trace-label">{label}</span>
        {it.kind === "editing" && (
          <span className={it.confirmed ? "trace-ok" : "trace-wait"}>
            {it.confirmed ? "✓ saved" : "… waiting"}
          </span>
        )}
        {it.kind === "running" && <span className="trace-cmd">{it.command}</span>}
        <span className="trace-agent">{it.agent}</span>
      </li>
    );
  }

  return (
    <section className="panel trace-panel">
      <header className="panel-head">
        <h3>Live activity trace</h3>
        <span className="muted">grounded against the filesystem watcher</span>
      </header>
      {visible.length === 0 ? (
        <p className="muted">
          No activity yet — start a session in the terminal (Claude Code
          button) and watch its steps appear here.
        </p>
      ) : (
        <ul className="trace-list">
          {collapsed && earlier.length > 0 && (
            <li className="trace-collapse">
              <button onClick={() => setCollapsed(false)}>
                {earlier.length} earlier steps
                {" · "}
                {new Set(earlier.filter((e) => e.kind === "editing").map((e) => e.file))
                  .size}{" "}
                files touched
              </button>
            </li>
          )}
          {expanded.map(renderItem)}
          {!collapsed && (
            <li className="trace-collapse">
              <button onClick={() => setCollapsed(true)}>collapse older steps</button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}