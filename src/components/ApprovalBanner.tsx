import { ShieldAlertIcon } from "lucide-react";
import type { Approval } from "../hooks/useApprovals";
import { Button } from "./ui/button";

interface ApprovalBannerProps {
  approvals: Approval[];
  onDecide: (id: number, allow: boolean) => void;
}

/**
 * Global approval gate: when a web AI wants to write a file or run a
 * command, this banner sits above everything until you allow or deny it.
 */
export default function ApprovalBanner({
  approvals,
  onDecide,
}: ApprovalBannerProps) {
  if (approvals.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-warning/30 bg-warning/10 px-4 py-2.5">
      {approvals.map((a) => (
        <div
          key={a.id}
          className="flex flex-wrap items-center gap-2.5"
          role="alert"
        >
          <ShieldAlertIcon className="size-4 shrink-0 text-warning" />
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-semibold text-warning">
              {a.source === "web" ? "Web AI" : "Desktop"} requests:
            </span>{" "}
            <span className="font-mono text-xs">{a.summary}</span>
          </p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              disabled={a.resolving}
              onClick={() => onDecide(a.id, true)}
            >
              Allow
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={a.resolving}
              onClick={() => onDecide(a.id, false)}
            >
              Deny
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
