import { cn } from "@/lib/utils";

// Keep colours aligned with ReplayScrubber.COLOR so that a dot on the
// scrubber and the badge in the timeline read as the same event class.
// Saturation differentiates "on" vs "off" sub-types (e.g. sky-500 vs sky-700).
const COLOURS: Record<string, string> = {
  goal:            "bg-emerald-500/20 text-emerald-200 border-emerald-500/50",
  shot_on_target:  "bg-sky-500/20    text-sky-200    border-sky-500/50",
  shot_off_target: "bg-sky-800/30    text-sky-400    border-sky-700/50",
  save:            "bg-cyan-500/20   text-cyan-200   border-cyan-500/50",
  red_card:        "bg-rose-600/25   text-rose-200   border-rose-500/60",
  yellow_card:     "bg-amber-500/20  text-amber-200  border-amber-500/50",
  foul:            "bg-amber-800/25  text-amber-400  border-amber-700/50",
  corner:          "bg-violet-500/20 text-violet-200 border-violet-500/50",
  free_kick:       "bg-violet-800/30 text-violet-400 border-violet-700/50",
  penalty:         "bg-rose-700/25   text-rose-200   border-rose-600/60",
  throw_in:        "bg-zinc-600/30   text-zinc-200   border-zinc-500/50",
  kick_off:        "bg-zinc-800/40   text-zinc-400   border-zinc-700/50",
  audio_signal:    "bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-500/50",
};

export function EventBadge({ type }: { type: string }) {
  const cls = COLOURS[type] ?? "bg-zinc-700/15 text-zinc-400 border-zinc-700/40";
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
      "font-mono text-[11px] uppercase tracking-wider",
      cls,
    )}>
      {type.replace(/_/g, " ")}
    </span>
  );
}
