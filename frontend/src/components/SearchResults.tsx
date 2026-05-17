import type { SearchShot } from "@/lib/types";
import { Search } from "lucide-react";

interface Props {
  shots: SearchShot[];
  onPlay: (url: string) => void;
  /** True once the user has run at least one query in the current session.
   *  Lets us distinguish "haven't searched yet" (render nothing) from
   *  "searched and found nothing" (render the empty-state hint). */
  hasSearched?: boolean;
}

function fmtClock(s: number | null): string {
  if (!s) return "--:--";
  const total = Math.max(0, Math.floor(s));
  const m = Math.floor(total / 60) % 60;
  const sec = total % 60;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

export function SearchResults({ shots, onPlay, hasSearched = false }: Props) {
  if (!shots.length) {
    if (!hasSearched) return null;
    return (
      <div className="border-b border-zinc-800 px-3 py-4 text-center">
        <Search className="mx-auto mb-1.5 h-4 w-4 text-zinc-600" />
        <div className="text-xs text-zinc-400">No matching moments</div>
        <div className="mt-0.5 text-[10px] text-zinc-500">
          Try a broader term like &ldquo;goal&rdquo;, &ldquo;save&rdquo;, or &ldquo;card&rdquo;
        </div>
      </div>
    );
  }
  return (
    <div className="border-b border-zinc-800 px-3 py-2">
      <div className="mb-1.5 text-[11px] uppercase tracking-wider text-zinc-500">
        {shots.length} result{shots.length === 1 ? "" : "s"}
      </div>
      <div className="space-y-1">
        {shots.map((s, i) => (
          <button
            key={i}
            onClick={() => s.stream_url && onPlay(s.stream_url)}
            className="flex w-full items-center gap-3 rounded border border-zinc-800 bg-zinc-900/50 px-2 py-1.5 text-left hover:border-zinc-700 hover:bg-zinc-900"
          >
            <span className="font-mono text-[10px] tabular-nums text-zinc-500">
              {fmtClock(s.start)}
            </span>
            <span className="flex-1 truncate text-[11px] text-zinc-300">
              {s.text || "(no description)"}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-zinc-500">
              {Math.round((s.score ?? 0) * 100)}%
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
