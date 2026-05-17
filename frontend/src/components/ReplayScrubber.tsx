import type { DataCasterEvent } from "@/lib/types";
import { useMemo, useState } from "react";

interface Props {
  events: DataCasterEvent[];
  startedAt: number | null;
  onSelect: (e: DataCasterEvent) => void;
  className?: string;
}

const COLOR: Record<string, string> = {
  goal: "bg-emerald-400",
  shot_on_target: "bg-sky-400",
  shot_off_target: "bg-sky-700",
  save: "bg-cyan-400",
  red_card: "bg-rose-500",
  yellow_card: "bg-amber-400",
  foul: "bg-amber-700",
  corner: "bg-violet-400",
  free_kick: "bg-violet-700",
  penalty: "bg-rose-600",
  throw_in: "bg-zinc-500",
  kick_off: "bg-zinc-700",
  audio_signal: "bg-fuchsia-400",
};

function fmtClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function ReplayScrubber({ events, startedAt, onSelect, className = "" }: Props) {
  const [hovered, setHovered] = useState<DataCasterEvent | null>(null);

  const { totalSec, dots } = useMemo(() => {
    if (!startedAt || events.length === 0) {
      return { totalSec: 60, dots: [] as { evt: DataCasterEvent; pct: number }[] };
    }
    const now = Date.now() / 1000;
    const total = Math.max(60, now - startedAt);
    const items = events
      .filter(e => e.unix_ts >= startedAt)
      .map(e => ({ evt: e, pct: ((e.unix_ts - startedAt) / total) * 100 }));
    return { totalSec: total, dots: items };
  }, [events, startedAt]);

  return (
    <div className={`relative h-7 border-y border-zinc-800 bg-zinc-950 ${className}`}>
      {/* Tick marks every ~25% — purely visual */}
      <div className="absolute inset-0 grid grid-cols-4">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="border-r border-zinc-900 last:border-r-0" />
        ))}
      </div>

      {/* Event dots */}
      {dots.map(({ evt, pct }) => (
        <button
          key={evt.id}
          onClick={() => onSelect(evt)}
          onMouseEnter={() => setHovered(evt)}
          onMouseLeave={() => setHovered(prev => (prev?.id === evt.id ? null : prev))}
          className={`absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${COLOR[evt.event_type] ?? "bg-zinc-400"} hover:scale-150 transition-transform`}
          style={{ left: `${Math.min(100, Math.max(0, pct))}%` }}
          aria-label={`${evt.event_type} at ${fmtClock(evt.unix_ts - (startedAt ?? evt.unix_ts))}`}
        />
      ))}

      {/* Tooltip for hovered dot */}
      {hovered && startedAt && (
        <div
          className="pointer-events-none absolute -top-7 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-200 shadow"
          style={{ left: `${Math.min(100, Math.max(0, ((hovered.unix_ts - startedAt) / totalSec) * 100))}%` }}
        >
          {hovered.event_type.replace(/_/g, " ")} · {fmtClock(hovered.unix_ts - startedAt)}
        </div>
      )}

      {/* Right edge: total elapsed clock */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-zinc-500">
        {fmtClock(totalSec)}
      </div>
    </div>
  );
}
