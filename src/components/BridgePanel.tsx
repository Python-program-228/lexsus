import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  bridgeApprove,
  bridgeAudit,
  bridgeTool,
  pairGetCode,
  pairStatus,
} from "../lib/bridge";
import type { ApprovalRequested, AuditEntry, BridgeTool, ToolResult } from "../lib/types";

interface Approval extends ApprovalRequested {
  id: number;
  resolving?: boolean;
}

/** Bridge panel (M2): extension pairing, web-AI approval queue, a tool
 *  sandbox for testing read/write/run locally, and the audit trail. */
export default function BridgePanel() {
  const [code, setCode] = useState("");
  const [connected, setConnected] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [readPath, setReadPath] = useState("src/App.tsx");
  const [writePath, setWritePath] = useState("");
  const [writeContent, setWriteContent] = useState("");
  const [command, setCommand] = useState("git status");
  const [sandbox, setSandbox] = useState<ToolResult | null>(null);

  useEffect(() => {
    void (async () => {
      const [c, s, a] = await Promise.all([
        pairGetCode().catch(() => ""),
        pairStatus().catch(() => false),
        bridgeAudit(20).catch(() => []),
      ]);
      setCode(c);
      setConnected(s);
      setAudit(a);

      const unlistens: UnlistenFn[] = [
        await listen<ApprovalRequested>("bridge://approval-requested", (e) => {
          setApprovals((prev) => [
            { ...e.payload, id: e.payload.id },
            ...prev.filter((p) => p.id !== e.payload.id),
          ]);
        }),
        await listen<{ id: number }>("bridge://approval-resolved", (e) => {
          setApprovals((prev) => prev.filter((p) => p.id !== e.payload.id));
        }),
        await listen<string>("pair://code", (e) => setCode(e.payload)),
        await listen<boolean>("pair://status", (e) => setConnected(e.payload)),
      ];
      return () => {
        for (const u of unlistens) u();
      };
    })();
  }, []);

  async function decide(id: number, allow: boolean) {
    setApprovals((prev) => prev.map((p) => (p.id === id ? { ...p, resolving: true } : p)));
    await bridgeApprove(id, allow).catch(() => {});
    setAudit(await bridgeAudit(20).catch(() => []));
  }

  async function sandboxRun(tool: BridgeTool) {
    setSandbox(await bridgeTool(tool));
    setAudit(await bridgeAudit(20).catch(() => []));
  }

  return (
    <section className="panel bridge-panel">
      <header className="panel-head">
        <h3>Web-AI Bridge</h3>
        <span className={`dot ${connected ? "" : "dot-idle"}`} />
        <span className="muted">
          {connected ? "extension paired" : "no extension paired"}
        </span>
        <span className="spacer" />
        <span className="pair-code" title="6-digit pairing code for the extension popup">
          {code || "…"}
        </span>
      </header>

      {approvals.map((a) => (
        <div key={a.id} className="approval-card">
          <span className="approval-summary">
            {a.source === "web" ? "🌐 ChatGPT" : "🖥 desktop"} requests: {a.summary}
          </span>
          <button onClick={() => void decide(a.id, true)} disabled={a.resolving}>
            Allow
          </button>
          <button className="danger" onClick={() => void decide(a.id, false)} disabled={a.resolving}>
            Deny
          </button>
        </div>
      ))}

      <details className="sandbox">
        <summary>Tool sandbox (test read / write / run locally)</summary>
        <div className="sandbox-row">
          <label>read_file</label>
          <input value={readPath} onChange={(e) => setReadPath(e.currentTarget.value)} />
          <button onClick={() => void sandboxRun({ ReadFile: { path: readPath } })}>Read</button>
        </div>
        <div className="sandbox-row">
          <label>write_file</label>
          <input value={writePath} placeholder="path" onChange={(e) => setWritePath(e.currentTarget.value)} />
          <input
            value={writeContent}
            placeholder="content"
            onChange={(e) => setWriteContent(e.currentTarget.value)}
          />
          <button onClick={() => void sandboxRun({ WriteFile: { path: writePath, content: writeContent } })}>
            Write
          </button>
        </div>
        <div className="sandbox-row">
          <label>run_command</label>
          <input value={command} onChange={(e) => setCommand(e.currentTarget.value)} />
          <button onClick={() => void sandboxRun({ RunCommand: { command } })}>Run</button>
        </div>
        {sandbox && (
          <pre className="sandbox-out">
            {sandbox.ok ? sandbox.output : sandbox.error ?? sandbox.pending ?? "?"}
          </pre>
        )}
      </details>

      <details className="audit">
        <summary>Audit trail (last {audit.length})</summary>
        <ul className="audit-list">
          {audit.map((a, i) => (
            <li key={i} className={a.allowed ? "" : "audit-denied"}>
              [{a.ts}] {a.agent} · {a.tool} · {a.args} ·{" "}
              {a.allowed ? `allowed (${a.approved_by})` : "DENIED"} · {a.ok ? "ok" : "failed"}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}