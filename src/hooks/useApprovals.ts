import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { bridgeApprove } from "../lib/bridge";
import type { ApprovalRequested } from "../lib/types";

export interface Approval extends ApprovalRequested {
  resolving?: boolean;
}

/**
 * Owns the web-AI approval queue so exactly one component (the global
 * banner) renders it. Mirrors `bridge://approval-requested/-resolved`.
 */
export function useApprovals() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let unlistens: UnlistenFn[] = [];
    void (async () => {
      unlistens = [
        await listen<ApprovalRequested>("bridge://approval-requested", (e) => {
          if (!mounted.current) return;
          setApprovals((prev) => [
            { ...e.payload, id: e.payload.id },
            ...prev.filter((p) => p.id !== e.payload.id),
          ]);
        }),
        await listen<{ id: number }>("bridge://approval-resolved", (e) => {
          if (!mounted.current) return;
          setApprovals((prev) => prev.filter((p) => p.id !== e.payload.id));
        }),
      ];
    })();
    return () => {
      mounted.current = false;
      for (const u of unlistens) u();
    };
  }, []);

  async function decide(id: number, allow: boolean) {
    setApprovals((prev) =>
      prev.map((p) => (p.id === id ? { ...p, resolving: true } : p)),
    );
    await bridgeApprove(id, allow).catch(() => {});
    setApprovals((prev) => prev.filter((p) => p.id !== id));
  }

  return { approvals, decide };
}
