import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body: string;
  eta?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  body,
  eta,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center justify-center px-4 py-8 text-center",
        className,
      )}
    >
      {icon && (
        <div className="mb-3 flex h-8 w-8 items-center justify-center text-zinc-500 [&>svg]:h-8 [&>svg]:w-8">
          {icon}
        </div>
      )}
      <div className="text-sm font-semibold text-zinc-200">{title}</div>
      <p className="mt-1.5 max-w-[280px] text-xs leading-relaxed text-zinc-400">
        {body}
      </p>
      {eta && (
        <div className="mt-2 text-[11px] text-zinc-500">{eta}</div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
