import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

interface ViewShellProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  actions?: ReactNode;
  /** false lets views with their own scroll structure fill instead */
  padded?: boolean;
  className?:string;
  children: ReactNode;
}

/**
 * Shared chrome for the right-hand workbench views: a slim header strip
 * (icon, title, actions) over a filling, scrolling body on a surface.
 */
export function ViewShell({
  icon: Icon,
  title,
  description,
  actions,
  padded = true,
  className,
  children,
}: ViewShellProps) {
  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface",
        className,
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && (
          <span className="hidden truncate text-xs text-muted-foreground md:inline">
            {description}
          </span>
        )}
        {actions && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {actions}
          </div>
        )}
      </header>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          padded && "overflow-y-auto p-4",
        )}
      >
        {children}
      </div>
    </section>
  );
}
