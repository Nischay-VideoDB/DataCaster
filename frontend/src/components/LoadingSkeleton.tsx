import { cn } from "@/lib/utils";

const block = "rounded-sm bg-zinc-800/60";

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex h-full w-full flex-col divide-y divide-zinc-800/50">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex animate-pulse items-center gap-3 px-3 py-2"
          style={{ animationDelay: `${i * 80}ms` }}
        >
          <span className={cn(block, "h-1.5 w-1.5 rounded-full")} />
          <span className={cn(block, "h-3 w-10")} />
          <span className={cn(block, "h-3 flex-1")} />
          <span className={cn(block, "h-3 w-8")} />
        </div>
      ))}
    </div>
  );
}

export function PlayerSkeleton() {
  return (
    <div className="relative h-full w-full">
      <div
        className={cn(
          "relative aspect-video w-full animate-pulse overflow-hidden bg-zinc-800/60",
        )}
      >
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs text-zinc-500">Connecting…</span>
        </div>
      </div>
    </div>
  );
}

export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="flex h-full w-full flex-col divide-y divide-zinc-800/50">
      {Array.from({ length: count }).map((_, i) => {
        const widths = ["w-3/4", "w-2/3", "w-5/6"];
        const lineA = widths[i % widths.length];
        const lineB = widths[(i + 1) % widths.length];
        return (
          <div
            key={i}
            className="flex animate-pulse items-start gap-3 px-3 py-3"
            style={{ animationDelay: `${i * 100}ms` }}
          >
            <span className={cn(block, "h-7 w-7 shrink-0 rounded-full")} />
            <div className="flex flex-1 flex-col gap-1.5">
              <span className={cn(block, "h-3", lineA)} />
              <span className={cn(block, "h-3", lineB)} />
              <span className={cn(block, "mt-1 h-5 w-24 rounded-full")} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
